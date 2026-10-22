// The composer's update. Typing edits the active draft (saved 300 ms after the last change); the
// selection drives the `/`, `@` and `$` menus; a send validates the draft, empties it at once and
// hands the turn to the root's outbox once its ids are minted. `inform` is how the root keeps the
// composer's context current, and it is also where the composer asks the brain for what the
// context newly needs (models, skills, branches).
import { resolveComposerDispatchMode } from "@cairn/client-logic/ComposerLogic";
import {
  buildComposerPromptHistoryEntries,
  stepComposerPromptHistory,
} from "@cairn/client-logic/ComposerPromptHistory";
import type { ComposerPromptHistoryMessage } from "@cairn/client-logic/ComposerPromptHistory";
import {
  ComposerSubmission,
  submitComposerDraft,
} from "@cairn/client-logic/ComposerSubmission";
import {
  detectComposerTrigger,
  replaceTextRange,
} from "@cairn/client-logic/ComposerTrigger";
import { resolveRestingComposerControlsLayout } from "@cairn/client-logic/FooterLayout";
import type { ConversationView } from "@cairn/protocol/Thread";
import { Array, Equal, Option, Predicate, Record, Schema } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { Services } from "../Command.ts";
import {
  ConfigureThread,
  DetectPlatform,
  EnsureScratch,
  LoadDrafts,
  LoadSettings,
  PrepareLaunch,
  PrepareSend,
  SaveDrafts,
  SaveSettings,
  SearchEntries,
  StopThread,
  WithdrawQueued,
} from "./Command.ts";
import {
  activeDraft,
  draftKey,
  draftProject,
  draftThreadId,
  isDraftTarget,
  modifyActiveDraft,
  targetProject,
} from "./Drafts.ts";
import { FocusEditor, SetEditorValue } from "./Editor.ts";
import { Message, OutMessage } from "./Message.ts";
import type { SubmitIntent } from "./Message.ts";
import { initial, Popover } from "./Model.ts";
import type { ComposerContext, Model, ComposerTarget } from "./Model.ts";
import {
  clampThinking,
  findListing,
  resolvedModel,
  resolvedThinking,
} from "./Models.ts";
import { MenuAction, menuContents, menuSearchKey } from "./TriggerMenu.ts";

/** What the composer's update returns. */
export type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  Services
>;

type Step = Update.Step<Model, Message, Services>;

const keep = (model: Model): UpdateReturn => ({ model });

/** The composer's first Model and the reads it starts with. */
export const init = (): Update.Return<Model, Message, Services> => ({
  model: initial,
  commands: [DetectPlatform(), LoadDrafts(), LoadSettings()],
});

/** True while the open thread has a run the composer can stop or steer into. */
export const isThreadRunning = (model: Model): boolean =>
  Option.exists(
    model.context.thread,
    (thread) =>
      thread.activity === "preparing" ||
      thread.activity === "running" ||
      thread.activity === "waiting"
  );

const sameTarget = (left: ComposerTarget, right: ComposerTarget): boolean =>
  Equal.equals(left, right);

/**
 * True when `next` differs from the context the composer holds. Large parts (the projects, the
 * thread row and view) compare by identity, so the root can call this after every update cheaply.
 */
export const contextChanged = (
  model: Model,
  next: ComposerContext
): boolean => {
  const current = model.context;

  return (
    !sameTarget(current.target, next.target) ||
    current.epoch !== next.epoch ||
    current.hasClient !== next.hasClient ||
    current.live !== next.live ||
    current.projects !== next.projects ||
    !Option.makeEquivalence<object>((left, right) => left === right)(
      current.thread,
      next.thread
    ) ||
    !Option.makeEquivalence<object>((left, right) => left === right)(
      current.view,
      next.view
    ) ||
    !Equal.equals(current.defaults, next.defaults)
  );
};

/** Closes every transient surface, as switching targets does. */
const resetTransient = (model: Model): Model =>
  modifyFields(model, {
    triggerMenu: () => Option.none(),
    dismissedTrigger: () => Option.none(),
    popover: () => Option.none(),
    history: () => Option.none(),
    notice: () => Option.none(),
  });

/**
 * Brings the composer in line with the app: the route's target, the connection, the shell and the
 * open thread's view. A new target closes every menu and puts the caret at the end of its draft.
 */
export const inform = (
  model: Model,
  context: ComposerContext
): Update.Return<Model, Message, Services> => {
  const retargeted = !sameTarget(model.context.target, context.target);
  const informed = modifyFields(model, { context: () => context });
  const next = retargeted ? resetTransient(informed) : informed;
  const end = activeDraft(next).text.length;

  return {
    model: retargeted
      ? modifyFields(next, { selection: () => ({ start: end, end }) })
      : next,
  };
};

const setText = (model: Model, text: string): Model =>
  modifyActiveDraft(model, (draft) => ({ ...draft, text }));

/** The trigger under the caret, or none; a trigger the user dismissed stays closed. */
const refreshTriggerMenu: Step = (model) => {
  const { text } = activeDraft(model);

  const trigger = Option.filter(
    detectComposerTrigger(text, model.selection.end),
    (candidate) =>
      !Option.contains(
        model.dismissedTrigger,
        `${candidate.kind}:${candidate.rangeStart}`
      )
  );

  if (Option.isNone(trigger)) {
    return {
      model: modifyFields(model, {
        triggerMenu: () => Option.none(),
        dismissedTrigger: (dismissed) =>
          Option.isSome(detectComposerTrigger(text, model.selection.end))
            ? dismissed
            : Option.none(),
      }),
    };
  }

  const current = trigger.value;

  const menu = Option.match(model.triggerMenu, {
    onNone: () => ({
      trigger: current,
      highlighted: Option.none(),
      highlightedKey: Option.none(),
    }),
    onSome: (open) => ({ ...open, trigger: current }),
  });

  const withMenu = modifyFields(model, {
    triggerMenu: () => Option.some(menu),
  });

  if (current.kind !== "path") {
    return { model: withMenu };
  }

  const query = current.query.trim();
  const project = targetProject(withMenu);

  const answered =
    withMenu.pathSearch.query === query &&
    Option.isNone(withMenu.pathSearch.pending) &&
    Option.exists(project, (candidate) =>
      Option.contains(withMenu.pathSearch.projectId, candidate.id)
    );

  return answered || Option.contains(withMenu.pathSearch.pending, query)
    ? { model: withMenu }
    : {
        model: modifyFields(withMenu, {
          pathSearch: (search) =>
            modifyFields(search, {
              projectId: () => Option.map(project, ({ id }) => id),
              pending: () => Option.some(query),
            }),
        }),
      };
};

const HistoryMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(Schema.Json)]),
});

const decodeHistoryMessage = Schema.decodeUnknownOption(HistoryMessage);

const decodeTextPart = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
);

const userTexts = (
  message: Schema.Json
): Option.Option<ComposerPromptHistoryMessage> => {
  const decoded = decodeHistoryMessage(message);

  return Option.map(decoded, (value) => ({
    id: "",
    role: value.role,
    texts: Predicate.isString(value.content)
      ? [value.content]
      : Array.getSomes(value.content.map((part) => decodeTextPart(part))).map(
          ({ text }) => text
        ),
  }));
};

/** The thread's messages as prompt history reads them, oldest first. */
const historyMessages = (
  view: Option.Option<ConversationView>
): ReadonlyArray<ComposerPromptHistoryMessage> =>
  Option.match(view, {
    onNone: () => [],
    onSome: (current) =>
      Array.flatMap(current.entries, (entry) =>
        Array.getSomes((entry.model ?? []).map(userTexts)).map((message) => ({
          ...message,
          id: String(entry.id),
        }))
      ),
  });

const SKILL_REFERENCE = /(?:^|\s)(?:\$|\/skill:)(?<name>[A-Za-z0-9][\w.-]*)/gu;

/** The skills a draft names with `$name` or `/skill:name`, known ones only, at most 20. */
const skillRefs = (model: Model, text: string): ReadonlyArray<string> => {
  const known: ReadonlyArray<string> = Option.match(model.skills, {
    onNone: () => [],
    onSome: (skills) => skills.list.map(({ name }) => name),
  });

  const named = Array.getSomes(
    [...text.matchAll(SKILL_REFERENCE)].map((match) =>
      Option.fromUndefinedOr(match.groups?.name)
    )
  );

  return Array.dedupe(
    Array.filter(named, (name) => known.includes(name))
  ).slice(0, 20);
};

const clearSentDraft = (model: Model): Model =>
  modifyFields(
    modifyActiveDraft(model, (draft) => ({
      ...draft,
      text: "",
      attachments: [],
    })),
    {
      selection: () => ({ start: 0, end: 0 }),
      triggerMenu: () => Option.none(),
      history: () => Option.none(),
      notice: () => Option.none(),
    }
  );

const notice = (model: Model, text: string): UpdateReturn => ({
  model: modifyFields(model, { notice: () => Option.some(text) }),
});

/** Hands a validated turn to the Command that mints its ids, emptying the draft at once. */
const dispatch = (
  model: Model,
  intent: SubmitIntent,
  text: string
): UpdateReturn => {
  const draft = activeDraft(model);

  const content = {
    text,
    attachments: draft.attachments,
    skillRefs: skillRefs(model, text),
  };

  if (!isDraftTarget(model)) {
    return Option.match(
      Option.map(model.context.thread, (thread) => thread.id),
      {
        onNone: () =>
          notice(
            model,
            "This thread is still loading. Send again in a moment."
          ),
        onSome: (threadId) => {
          const mode = resolveComposerDispatchMode(
            isThreadRunning(model),
            intent === "alternate",
            model.settings.followUpBehavior
          );

          return {
            model: clearSentDraft(model),
            commands: [
              PrepareSend({
                threadId,
                whenBusy: mode === "steer" ? "steer" : "followUp",
                content,
              }),
            ],
          };
        },
      }
    );
  }

  return Option.match(
    Option.all([resolvedModel(model), resolvedThinking(model)]),
    {
      onNone: () =>
        notice(model, "The models are still loading. Send again in a moment."),
      onSome: ([chosen, thinkingLevel]) => {
        const project = draftProject(model);
        const stay = intent === "background";
        const launched = clearSentDraft(model);

        return {
          model: modifyFields(launched, {
            drafts: (drafts) =>
              Option.match(draftKey(model), {
                onNone: () => drafts,
                onSome: (key) => Record.remove(drafts, key),
              }),
            homeDraftId: (id) =>
              Predicate.isTagged(model.context.target, "Home")
                ? Option.none()
                : id,
          }),
          commands: [
            PrepareLaunch({
              draftId: draftThreadId(model),
              projectId: Option.map(project, ({ id }) => id),
              model: chosen,
              thinkingLevel,
              runtimeMode: draft.runtimeMode,
              envMode: draft.envMode,
              baseBranch: draft.baseBranch,
              currentBranch: Option.flatMap(
                model.branches,
                ({ result }) => result.current
              ),
              content,
              stay,
            }),
          ],
        };
      },
    }
  );
};

/** Sends the draft when it validates; a refusal keeps it and says why. */
const submit = (model: Model, intent: SubmitIntent): UpdateReturn => {
  const draft = activeDraft(model);

  const submission = submitComposerDraft(
    draft.text,
    "turn",
    draft.attachments.length > 0
  );

  return ComposerSubmission.match(submission, {
    Empty: () => keep(model),
    Refuse: ({ message }) => notice(model, message),
    Dispatch: ({ text }) => dispatch(model, intent, text),
  });
};

/** Switches the model: a draft remembers it, an open thread is reconfigured. */
const chooseModel = (
  model: Model,
  chosen: { readonly provider: string; readonly modelId: string }
): Update.Return<Model, Message, Services> => {
  const closed = modifyFields(model, { popover: () => Option.none() });

  if (isDraftTarget(model)) {
    const levels = Option.match(findListing(model, chosen), {
      onNone: () => [],
      onSome: (listing) => listing.thinkingLevels,
    });

    return {
      model: modifyActiveDraft(closed, (draft) => ({
        ...draft,
        model: Option.some(chosen),
        thinking: Option.map(draft.thinking, (level) =>
          clampThinking(level, levels)
        ),
      })),
    };
  }

  return Option.match(model.context.thread, {
    onNone: () => ({ model: closed }),
    onSome: (thread) => ({
      model: closed,
      commands: [
        ConfigureThread({
          threadId: thread.id,
          model: Option.some(chosen),
          thinkingLevel: Option.none(),
        }),
      ],
    }),
  });
};

/** Applies a picked suggestion to the trigger it belongs to. */
const pickMenuItem = (model: Model, id: string): UpdateReturn =>
  Option.match(
    Option.flatMap(menuContents(model), (contents) =>
      Option.map(
        Array.findFirst(contents.items, (item) => item.id === id),
        (item) => [contents.trigger, item] as const
      )
    ),
    {
      onNone: () => keep(model),
      onSome: ([trigger, item]) => {
        const { text } = activeDraft(model);

        const replace = (replacement: string) =>
          replaceTextRange(
            text,
            trigger.rangeStart,
            trigger.rangeEnd,
            replacement
          );

        return MenuAction.match(item.action, {
          Insert: ({ text: inserted }) => {
            const next = replace(inserted);

            return {
              model: modifyFields(setText(model, next.text), {
                selection: () => ({ start: next.cursor, end: next.cursor }),
                triggerMenu: () => Option.none(),
              }),
              commands: [
                SetEditorValue({ value: next.text, cursor: next.cursor }),
              ],
            };
          },
          OpenModels: () => {
            const next = replace("/model ");

            const opened = modifyFields(setText(model, next.text), {
              selection: () => ({ start: next.cursor, end: next.cursor }),
            });

            return {
              ...refreshTriggerMenu(opened),
              commands: [
                SetEditorValue({ value: next.text, cursor: next.cursor }),
              ],
            };
          },
          ChooseModel: ({ model: chosen }) => {
            const next = replace("");

            const cleared = modifyFields(setText(model, next.text), {
              selection: () => ({ start: next.cursor, end: next.cursor }),
              triggerMenu: () => Option.none(),
            });

            const changed = chooseModel(cleared, chosen);

            return {
              model: changed.model,
              commands: [
                ...(changed.commands ?? []),
                SetEditorValue({ value: next.text, cursor: next.cursor }),
              ],
            };
          },
        });
      },
    }
  );

const moveHighlight = (model: Model, delta: number): UpdateReturn =>
  Option.match(menuContents(model), {
    onNone: () => keep(model),
    onSome: (contents) => {
      const ids = contents.items.map((item) => item.id);

      if (ids.length === 0) {
        return keep(model);
      }

      const index = Option.match(contents.activeId, {
        onNone: () => -1,
        onSome: (id) => ids.indexOf(id),
      });

      const next =
        ids[(index + delta + ids.length) % ids.length] ?? ids[0] ?? "";

      return {
        model: modifyFields(model, {
          triggerMenu: (menu) =>
            Option.map(menu, (open) => ({
              ...open,
              highlighted: Option.some(next),
              highlightedKey: Option.some(menuSearchKey(open.trigger)),
            })),
        }),
      };
    },
  });

const menuKey = (model: Model, key: string): UpdateReturn => {
  switch (key) {
    case "ArrowDown": {
      return moveHighlight(model, 1);
    }

    case "ArrowUp": {
      return moveHighlight(model, -1);
    }

    case "Escape": {
      return {
        model: modifyFields(model, {
          dismissedTrigger: () =>
            Option.map(
              model.triggerMenu,
              ({ trigger }) => `${trigger.kind}:${trigger.rangeStart}`
            ),
          triggerMenu: () => Option.none(),
        }),
      };
    }

    default: {
      return Option.match(
        Option.flatMap(menuContents(model), (contents) => contents.activeId),
        {
          onNone: () => keep(model),
          onSome: (id) => pickMenuItem(model, id),
        }
      );
    }
  }
};

const recallHistory = (
  model: Model,
  direction: "backward" | "forward"
): UpdateReturn => {
  if (Option.isSome(model.triggerMenu)) {
    return keep(model);
  }

  const entries = buildComposerPromptHistoryEntries(
    historyMessages(model.context.view)
  );

  return Option.match(
    stepComposerPromptHistory(
      direction,
      entries,
      model.history,
      activeDraft(model).text
    ),
    {
      onNone: () => keep(model),
      onSome: (step) => ({
        model: modifyFields(setText(model, step.prompt), {
          history: () => step.position,
          selection: () => ({
            start: step.prompt.length,
            end: step.prompt.length,
          }),
        }),
        commands: [
          SetEditorValue({ value: step.prompt, cursor: step.prompt.length }),
        ],
      }),
    }
  );
};

const popoverHides = (model: Model, popover: Popover): boolean => {
  const { hiddenCount } = model.footer.layout;

  return Popover.match(popover, {
    ModelPicker: () => !model.footer.layout.visible,
    Thinking: () => hiddenCount >= 2,
    RuntimeMode: () => hiddenCount >= 1,
    Overflow: () => hiddenCount === 0,
    Project: () => false,
    EnvMode: () => false,
    Branch: () => false,
  });
};

const updatePopover = (
  model: Model,
  change: (popover: Popover) => Popover
): UpdateReturn => ({
  model: modifyFields(model, {
    popover: (popover) => Option.map(popover, change),
  }),
});

const withQuery = (popover: Popover, query: string): Popover =>
  Popover.match(popover, {
    ModelPicker: () =>
      Popover.ModelPicker({ query, highlighted: Option.none() }),
    Project: () => Popover.Project({ query, highlighted: Option.none() }),
    Branch: () => Popover.Branch({ query }),
    Thinking: () => popover,
    RuntimeMode: () => popover,
    Overflow: () => popover,
    EnvMode: () => popover,
  });

const withHighlight = (popover: Popover, id: string): Popover =>
  Popover.match(popover, {
    ModelPicker: ({ query }) =>
      Popover.ModelPicker({ query, highlighted: Option.some(id) }),
    Project: ({ query }) =>
      Popover.Project({ query, highlighted: Option.some(id) }),
    Branch: () => popover,
    Thinking: () => popover,
    RuntimeMode: () => popover,
    Overflow: () => popover,
    EnvMode: () => popover,
  });

const closePopover = (model: Model): Model =>
  modifyFields(model, { popover: () => Option.none() });

const changeDraft = (
  model: Model,
  change: Parameters<typeof modifyActiveDraft>[1]
): UpdateReturn => ({
  model: closePopover(modifyActiveDraft(model, change)),
});

const saveSettingsStep = (model: Model): UpdateReturn => ({
  model,
  commands: [SaveSettings({ settings: model.settings })],
});

const step = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ChangedDraft: ({ value }) => ({
      model: modifyFields(setText(model, value), {
        notice: () => Option.none(),
      }),
    }),
    ChangedSelection: ({ end, start }) =>
      refreshTriggerMenu(
        modifyFields(model, { selection: () => ({ start, end }) })
      ),
    FocusedEditor: () => ({
      model: modifyFields(model, { focused: () => true }),
    }),
    BlurredEditor: () => ({
      model: modifyFields(model, { focused: () => false }),
    }),
    PressedSubmitKey: ({ intent }) => submit(model, intent),
    PressedMenuKey: ({ key }) => menuKey(model, key),
    PressedHistoryKey: ({ direction }) => recallHistory(model, direction),
    TypedOutsideEditor: ({ text }) => {
      const next = `${activeDraft(model).text}${text}`;

      return {
        model: modifyFields(setText(model, next), {
          selection: () => ({ start: next.length, end: next.length }),
        }),
        commands: [SetEditorValue({ value: next, cursor: next.length })],
      };
    },
    ClickedSend: ({ alternate }) =>
      submit(model, alternate ? "alternate" : "foreground"),
    ClickedStop: ({ clearQueue }) =>
      Option.match(model.context.thread, {
        onNone: () => keep(model),
        onSome: (thread) => ({
          model,
          commands: [StopThread({ threadId: thread.id, clearQueue })],
        }),
      }),
    ClickedWithdraw: ({ submissionId }) =>
      Option.match(model.context.thread, {
        onNone: () => keep(model),
        onSome: (thread) => ({
          model,
          commands: [WithdrawQueued({ threadId: thread.id, submissionId })],
        }),
      }),

    HighlightedMenuItem: ({ id }) => ({
      model: modifyFields(model, {
        triggerMenu: (menu) =>
          Option.map(menu, (open) => ({
            ...open,
            highlighted: Option.some(id),
            highlightedKey: Option.some(menuSearchKey(open.trigger)),
          })),
      }),
    }),
    PickedMenuItem: ({ id }) => pickMenuItem(model, id),

    OpenedPopover: ({ popover }) => {
      const isOpen = Option.exists(
        model.popover,
        (open) => open._tag === popover._tag
      );

      return isOpen
        ? { model: closePopover(model) }
        : {
            model: modifyFields(model, { popover: () => Option.some(popover) }),
          };
    },
    ClosedPopover: () => ({ model: closePopover(model) }),
    ChangedPopoverQuery: ({ query }) =>
      updatePopover(model, (popover) => withQuery(popover, query)),
    MovedPopoverHighlight: ({ id }) =>
      updatePopover(model, (popover) => withHighlight(popover, id)),
    PickedModel: ({ model: chosen }) => chooseModel(model, chosen),
    ToggledFavoriteModel: ({ key }) =>
      saveSettingsStep(
        modifyFields(model, {
          settings: (settings) =>
            modifyFields(settings, {
              favoriteModels: () =>
                settings.favoriteModels.includes(key)
                  ? Array.filter(
                      settings.favoriteModels,
                      (favorite) => favorite !== key
                    )
                  : [...settings.favoriteModels, key],
            }),
        })
      ),
    PickedThinking: ({ level }) =>
      isDraftTarget(model)
        ? changeDraft(model, (draft) => ({
            ...draft,
            thinking: Option.some(level),
          }))
        : Option.match(model.context.thread, {
            onNone: () => ({ model: closePopover(model) }),
            onSome: (thread) => ({
              model: closePopover(model),
              commands: [
                ConfigureThread({
                  threadId: thread.id,
                  model: Option.none(),
                  thinkingLevel: Option.some(level),
                }),
              ],
            }),
          }),
    PickedRuntimeMode: ({ mode }) =>
      changeDraft(model, (draft) => ({ ...draft, runtimeMode: mode })),
    PickedProject: ({ projectId }) => {
      const draft = activeDraft(model);

      const isEmptyDraft =
        draft.text.length === 0 && draft.attachments.length === 0;

      const retargeted = modifyActiveDraft(closePopover(model), (current) => ({
        ...current,
        projectId: Option.some(projectId),
        // An empty draft starts over in the chosen project, with its default model.
        model: isEmptyDraft ? Option.none() : current.model,
        baseBranch: Option.none(),
      }));

      return { model: retargeted, commands: [FocusEditor()] };
    },
    ClickedAddProject: () => ({
      model: closePopover(model),
      outMessage: OutMessage.RequestedAddProject(),
    }),
    ClickedStartWithoutProject: () => ({
      model: closePopover(model),
      commands: [EnsureScratch()],
    }),
    PickedEnvMode: ({ mode }) =>
      changeDraft(model, (draft) => ({ ...draft, envMode: mode })),
    PickedBranch: ({ branch }) =>
      changeDraft(model, (draft) => ({
        ...draft,
        baseBranch: Option.some(branch),
      })),

    MeasuredFooter: ({ hostWidth, measurement, width }) => {
      const layout = resolveRestingComposerControlsLayout(
        measurement,
        hostWidth,
        Option.some(model.footer.layout)
      );

      const unchanged =
        Option.contains(model.footer.width, width) &&
        Equal.equals(layout, model.footer.layout);

      if (unchanged) {
        return keep(model);
      }

      const measured = modifyFields(model, {
        footer: () => ({ width: Option.some(width), layout }),
      });

      return {
        model: Option.exists(measured.popover, (popover) =>
          popoverHides(measured, popover)
        )
          ? closePopover(measured)
          : measured,
      };
    },
    MeasuredHeadline: ({ inline }) =>
      inline === model.headlineInline
        ? keep(model)
        : { model: modifyFields(model, { headlineInline: () => inline }) },
    ChangedSoftwareKeyboard: ({ open }) => ({
      model: modifyFields(model, { softKeyboardOpen: () => open }),
    }),

    DetectedPlatform: ({ isMac }) => ({
      model: modifyFields(model, { isMac: () => isMac }),
    }),
    LoadedDrafts: ({ drafts }) => ({
      model: modifyFields(model, {
        // Edits made before storage answered win over what was saved.
        drafts: (current) =>
          Record.union(drafts, current, (_saved, edited) => edited),
        draftsLoaded: () => true,
      }),
    }),
    LoadedSettings: ({ settings }) => ({
      model: modifyFields(model, { settings: () => settings }),
    }),
    MintedHomeDraft: ({ draftId }) => ({
      model: modifyFields(model, { homeDraftId: () => Option.some(draftId) }),
    }),
    ElapsedDraftDebounce: ({ version }) =>
      version === model.draftsVersion && version > model.savedVersion
        ? { model, commands: [SaveDrafts({ version, drafts: model.drafts })] }
        : keep(model),
    HidPage: () =>
      model.draftsVersion > model.savedVersion
        ? {
            model,
            commands: [
              SaveDrafts({
                version: model.draftsVersion,
                drafts: model.drafts,
              }),
            ],
          }
        : keep(model),
    CompletedSaveDrafts: ({ saved, version }) =>
      saved
        ? {
            model: modifyFields(model, {
              savedVersion: (current) => Math.max(current, version),
            }),
          }
        : notice(
            model,
            "Drafts could not be saved on this device. Keep this page open until you send."
          ),
    CompletedSaveSettings: () => keep(model),

    SucceededModels: ({ catalog, epoch }) =>
      epoch === model.context.epoch || Option.isNone(model.catalog)
        ? {
            model: modifyFields(model, { catalog: () => Option.some(catalog) }),
          }
        : keep(model),
    SucceededSkills: ({ list, projectId }) => ({
      model: modifyFields(model, {
        skills: () => Option.some({ projectId, list: list.skills }),
      }),
    }),
    ElapsedPathSearchDebounce: ({ projectId, query }) =>
      Option.contains(model.pathSearch.pending, query)
        ? { model, commands: [SearchEntries({ projectId, query })] }
        : keep(model),
    SucceededPathSearch: ({ projectId, query, result }) =>
      Option.contains(model.pathSearch.pending, query)
        ? {
            model: modifyFields(model, {
              pathSearch: () => ({
                projectId: Option.some(projectId),
                query,
                pending: Option.none(),
                entries: result.entries,
              }),
            }),
          }
        : keep(model),
    SucceededBranches: ({ projectId, result }) => ({
      model: modifyFields(model, {
        branches: () => Option.some({ projectId, result }),
      }),
    }),
    SucceededScratch: ({ project }) => ({
      model: modifyActiveDraft(model, (draft) => ({
        ...draft,
        projectId: Option.some(project.id),
      })),
      commands: [FocusEditor()],
    }),
    PreparedTurn: ({ item, navigateTo }) => ({
      model,
      outMessage: OutMessage.Submitted({ item, navigateTo }),
    }),
    FailedPrepareTurn: ({ message: reason, text }) => {
      const restored =
        activeDraft(model).text.length === 0 ? setText(model, text) : model;

      return notice(restored, reason);
    },
    FailedRequest: ({ message: reason }) => notice(model, reason),
    FailedLoad: ({ message: reason, projectId, what }) => {
      if (what === "models") {
        return {
          model: modifyFields(model, {
            catalogError: () => Option.some(reason),
          }),
        };
      }

      // An unreadable list counts as empty, so the menus stop waiting and nothing asks again.
      return Option.match(projectId, {
        onNone: () => keep(model),
        onSome: (id) =>
          what === "skills"
            ? {
                model: modifyFields(model, {
                  skills: () => Option.some({ projectId: id, list: [] }),
                }),
              }
            : {
                model: modifyFields(model, {
                  branches: () =>
                    Option.some({
                      projectId: id,
                      result: { current: Option.none(), branches: [] },
                    }),
                }),
              },
      });
    },
    CompletedRequest: () => keep(model),
    CompletedEditorCommand: () => keep(model),
  });

/** The composer's update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  step(model, message);
