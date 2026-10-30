// The composer's update. Typing edits the active draft (saved 300 ms after the last change); the
// selection drives the `/`, `@` and `$` menus; a send validates the draft, empties it at once and
// hands the turn to the root's outbox once its ids are minted. `inform` is how the root keeps the
// composer's context current, and it is also where the composer asks the brain for what the
// context newly needs (models, skills, branches).

import { resolveComposerDispatchMode } from "@cairn/client-logic/ComposerLogic";
import { stepComposerPromptHistory } from "@cairn/client-logic/ComposerPromptHistory";
import {
  ComposerSubmission,
  submitComposerDraft,
} from "@cairn/client-logic/ComposerSubmission";
import {
  detectComposerTrigger,
  replaceTextRange,
} from "@cairn/client-logic/ComposerTrigger";
import { resolveRestingComposerControlsLayout } from "@cairn/client-logic/FooterLayout";
import type { AttachmentRef } from "@cairn/protocol/Attachments";
import type { ProjectId } from "@cairn/protocol/Ids";
import type { ThreadLaunchInput } from "@cairn/protocol/Launch";
import { Array, Equal, Option, Predicate, Record } from "effect";
import type { Schema } from "effect";
import { Command } from "foldkit";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { OutMessage as TrayOutMessage } from "../attachments/Message.ts";
import type { Message as TrayMessage } from "../attachments/Message.ts";
import * as Tray from "../attachments/Update.ts";
import type { Services } from "../Command.ts";
import { OutboxItem } from "../connection/Outbox.ts";
import {
  ConfigureThread,
  DetectPlatform,
  EnsureScratch,
  FocusPopoverSearch,
  LoadDrafts,
  LoadSettings,
  MoveHeroToDraftUrl,
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
import { emptyDraft, initial, Popover } from "./Model.ts";
import type { ComposerContext, Draft, Model, ComposerTarget } from "./Model.ts";
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

const toTray = (message: TrayMessage): Message =>
  Message.GotAttachmentsMessage({ message });

/**
 * Drops the unsent draft `/new/<draftId>` (the sidebar's Discard), and the home hero's id when it
 * was that draft. The debounced saver writes the change.
 */
export const discardDraft = (
  model: Model,
  draftId: string
): Update.Return<Model, Message, Services> => {
  const tray = Tray.discardDraft(model.attachments, `draft:${draftId}`);

  return {
    model: modifyFields(model, {
      drafts: (drafts) => Record.remove(drafts, `draft:${draftId}`),
      draftsVersion: (version) => version + 1,
      homeDraftId: (id) => (Option.contains(id, draftId) ? Option.none() : id),
      attachments: () => tray.model,
    }),
    commands: Command.mapMessages(tray.commands, toTray),
  };
};

/**
 * Gives the draft `/new/<draftId>` the project its first message launches in (the `next` shell's
 * rail, for a project with no project thread yet). An empty draft starts over with that project's
 * default model, as the hero's project menu does. The debounced saver writes the change.
 */
export const pickDraftProject = (
  model: Model,
  draftId: string,
  projectId: ProjectId
): Model =>
  modifyFields(model, {
    drafts: (drafts) => {
      const key = `draft:${draftId}`;

      const current = Option.getOrElse(
        Record.get(drafts, key),
        () => emptyDraft
      );

      const isEmptyDraft =
        current.text.length === 0 && current.attachments.length === 0;

      return Record.set(drafts, key, {
        ...current,
        projectId: Option.some(projectId),
        model: isEmptyDraft ? Option.none() : current.model,
        baseBranch: Option.none(),
      });
    },
    draftsVersion: (version) => version + 1,
  });

/**
 * Puts a turn that did not reach the brain back into the draft at `key`: its settings when the draft
 * is empty, its text (below what the user has typed since, never over it) and its attachments.
 */
const restoreDraft = (
  model: Model,
  key: string,
  sent: Draft,
  attachments: ReadonlyArray<AttachmentRef>
): Update.Return<Model, Message, Services> => {
  const tray = Tray.restore(model.attachments, key, attachments);
  const ids = attachments.map(({ id }) => id);

  return {
    model: modifyFields(model, {
      drafts: (drafts) =>
        Record.set(
          drafts,
          key,
          Option.match(Record.get(drafts, key), {
            onNone: () => sent,
            onSome: (current) => ({
              ...current,
              text:
                current.text.trim() === ""
                  ? sent.text
                  : `${current.text}\n\n${sent.text}`,
              attachments: [
                ...current.attachments,
                ...Array.filter(ids, (id) => !current.attachments.includes(id)),
              ],
            }),
          })
        ),
      draftsVersion: (version) => version + 1,
      attachments: () => tray.model,
    }),
    commands: Command.mapMessages(tray.commands ?? [], toTray),
  };
};

/** The draft id a refused launch of `threadId` comes back as; not a UUID, so it launches anew. */
export const retryDraftId = (threadId: string): string => `retry-${threadId}`;

/** The workspace choice of a draft that launched with `workspace`. */
const envOf = (
  workspace: ThreadLaunchInput["workspace"]
): Pick<Draft, "envMode" | "baseBranch"> =>
  Predicate.isTagged(workspace, "Worktree")
    ? {
        envMode: "worktree",
        baseBranch:
          workspace.baseRef === "HEAD"
            ? Option.none()
            : Option.some(workspace.baseRef),
      }
    : { envMode: "local", baseBranch: Option.none() };

/**
 * Puts a turn the brain refused, or a launch that failed, back where it was written: a send into its
 * thread's draft, a launch into a new draft (`retryDraftId`) with the model and place it chose.
 */
export const restoreTurn = (
  model: Model,
  item: OutboxItem,
  attachments: ReadonlyArray<AttachmentRef>
): Update.Return<Model, Message, Services> =>
  OutboxItem.match(item, {
    Send: ({ input }) =>
      restoreDraft(
        model,
        `thread:${input.threadId}`,
        {
          ...emptyDraft,
          text: input.input.text,
          attachments: input.input.attachments,
        },
        attachments
      ),
    Launch: ({ input }) =>
      restoreDraft(
        model,
        `draft:${retryDraftId(input.threadId)}`,
        {
          ...emptyDraft,
          ...envOf(input.workspace),
          text: input.initialMessage.text,
          attachments: input.initialMessage.attachments,
          model: Option.some(input.model),
          thinking: Option.some(input.thinkingLevel),
          runtimeMode: input.runtimeMode,
          projectId: Option.some(input.projectId),
        },
        attachments
      ),
    Dispatch: () => ({ model }),
  });

/** The composer's first Model and the reads it starts with. */
export const init = (): Update.Return<Model, Message, Services> => ({
  model: initial,
  commands: [
    DetectPlatform(),
    LoadDrafts(),
    LoadSettings(),
    ...Command.mapMessages(Tray.init().commands, toTray),
  ],
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

const samePrompts = (
  left: ComposerContext["prompts"],
  right: ComposerContext["prompts"]
): boolean =>
  left === right ||
  (left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];

      return (
        other !== undefined &&
        entry.id === other.id &&
        entry.prompt === other.prompt
      );
    }));

/**
 * True when `next` differs from the context the composer holds. Large parts (the projects, the
 * thread row and inbox) compare by identity and the prompts by value, so the root can call this
 * after every update cheaply.
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
    !Option.makeEquivalence<Schema.Json>((left, right) => left === right)(
      current.inbox,
      next.inbox
    ) ||
    !samePrompts(current.prompts, next.prompts) ||
    !Equal.equals(current.defaults, next.defaults) ||
    current.usage !== next.usage
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

/** At `/` with the hero's draft id known, the command that moves the URL to `/new/<id>`. */
const moveHeroToDraftUrl = (model: Model) =>
  Predicate.isTagged(model.context.target, "Home")
    ? Option.match(model.homeDraftId, {
        onNone: () => [],
        onSome: (draftId) => [MoveHeroToDraftUrl({ draftId })],
      })
    : [];

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
    commands: retargeted ? moveHeroToDraftUrl(next) : [],
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

  // A failed search is not an answer: typing again asks again.
  const answered =
    withMenu.pathSearch.query === query &&
    Option.isNone(withMenu.pathSearch.pending) &&
    Option.isNone(withMenu.pathSearch.error) &&
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
const dispatchTurn = (
  model: Model,
  intent: SubmitIntent,
  text: string
): UpdateReturn => {
  const draft = activeDraft(model);

  const attachments = Option.match(draftKey(model), {
    onNone: () => [],
    onSome: (key) => Tray.readyRefs(model.attachments, key),
  });

  const content = {
    text,
    // The tray is what the user sees; the draft's ids follow it.
    attachments: Option.match(draftKey(model), {
      onNone: () => draft.attachments,
      onSome: (key) => Tray.readyIds(model.attachments, key),
    }),
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
                attachments,
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
              Predicate.isTagged(model.context.target, "Home") ||
              Option.exists(id, (home) =>
                Option.contains(draftThreadId(model), home)
              )
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
              draftKey: Option.getOrElse(draftKey(model), () => ""),
              draft,
              attachments,
            }),
          ],
        };
      },
    }
  );
};

/** Changes the ready attachment ids of the draft at `key`, open or not. */
const changeDraftAttachments = (
  model: Model,
  key: string,
  change: (ids: Draft["attachments"]) => Draft["attachments"]
): Model =>
  modifyFields(model, {
    drafts: (drafts) => {
      const current = Option.getOrElse(
        Record.get(drafts, key),
        () => emptyDraft
      );

      return Record.set(drafts, key, {
        ...current,
        attachments: change(current.attachments),
      });
    },
    draftsVersion: (version) => version + 1,
  });

/** A tray result applied to the composer, and the send it asks for, if any. */
interface TrayApplied {
  readonly model: Model;
  readonly commands: ReadonlyArray<Command.Command<Message, never, Services>>;
  readonly ready: Option.Option<{
    readonly key: string;
    readonly intent: SubmitIntent;
  }>;
}

/**
 * The composer after a change in its attachment tray: the tray's Commands lifted, the draft's ready
 * ids kept in step, and a send the tray released handed back to the caller.
 */
const applyTray = (model: Model, result: Tray.UpdateReturn): TrayApplied => {
  const next = modifyFields(model, { attachments: () => result.model });
  const commands = Command.mapMessages(result.commands ?? [], toTray);
  const none: TrayApplied["ready"] = Option.none();

  return Option.match(Option.fromUndefinedOr(result.outMessage), {
    onNone: () => ({ model: next, commands, ready: none }),
    onSome: (outMessage) =>
      TrayOutMessage.match<TrayApplied>(outMessage, {
        Attached: ({ attachmentId, draftKey: key }) => ({
          model: changeDraftAttachments(next, key, (ids) =>
            ids.includes(attachmentId) ? ids : [...ids, attachmentId]
          ),
          commands,
          ready: none,
        }),
        Detached: ({ attachmentId, draftKey: key }) => ({
          model: changeDraftAttachments(next, key, (ids) =>
            Array.filter(ids, (id) => id !== attachmentId)
          ),
          commands,
          ready: none,
        }),
        ReadyToSend: ({ draftKey: key, intent }) => ({
          model: next,
          commands,
          ready: Option.some({ key, intent }),
        }),
      }),
  });
};

/** Sends the turn, and lets the tray forget the attachments it carried. */
const dispatch = (
  model: Model,
  intent: SubmitIntent,
  text: string
): UpdateReturn => {
  const key = draftKey(model);
  const sent = dispatchTurn(model, intent, text);

  return Option.match(
    Option.filter(key, () => (sent.commands ?? []).length > 0),
    {
      onNone: () => sent,
      onSome: (sentKey) => {
        const cleared = applyTray(
          sent.model,
          Tray.clearSent(sent.model.attachments, sentKey)
        );

        return {
          ...sent,
          model: cleared.model,
          commands: Array.appendAll(sent.commands ?? [], cleared.commands),
        };
      },
    }
  );
};

/**
 * Sends the draft when it validates; a refusal keeps it and says why. A draft whose attachments
 * are still uploading (or failed) waits in the tray, which releases the send once they answer.
 */
const submit = (model: Model, intent: SubmitIntent): UpdateReturn => {
  const draft = activeDraft(model);
  const key = draftKey(model);

  const submission = submitComposerDraft(
    draft.text,
    "turn",
    draft.attachments.length > 0 ||
      Option.exists(key, (current) =>
        Tray.hasAttachments(model.attachments, current)
      )
  );

  return ComposerSubmission.match(submission, {
    Empty: () => keep(model),
    Refuse: ({ message }) => notice(model, message),
    Dispatch: ({ text }) =>
      Option.match(
        Option.filter(key, (current) =>
          Tray.mustWait(model.attachments, current)
        ),
        {
          onNone: () => dispatch(model, intent, text),
          onSome: (current) => {
            // A send that must wait never comes straight back ready: something is in flight.
            const waiting = applyTray(
              model,
              Tray.requestSend(model.attachments, current, intent)
            );

            return { model: waiting.model, commands: waiting.commands };
          },
        }
      ),
  });
};

/**
 * A tray Message through the tray, then the send it released. A send whose draft is no longer open
 * is not fired from another page; its draft says it was not sent.
 */
const withTray = (model: Model, result: Tray.UpdateReturn): UpdateReturn => {
  const applied = applyTray(model, result);

  const released = Option.match(applied.ready, {
    onNone: () => keep(applied.model),
    onSome: ({ intent, key }) =>
      Option.contains(draftKey(applied.model), key)
        ? submit(applied.model, intent)
        : keep(
            modifyFields(applied.model, {
              attachments: (tray) => Tray.noteNotSent(tray, key),
            })
          ),
  });

  return {
    ...released,
    commands: Array.appendAll(applied.commands, released.commands ?? []),
  };
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
            const changedCommands = changed.commands ?? [];

            return {
              model: changed.model,
              commands: [
                ...changedCommands,
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

  return Option.match(
    stepComposerPromptHistory(
      direction,
      model.context.prompts,
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

/** True when `id` is the popover's highlighted row already. */
const isHighlighted = (popover: Popover, id: string): boolean =>
  Popover.match(popover, {
    ModelPicker: ({ highlighted }) => Option.contains(highlighted, id),
    Project: ({ highlighted }) => Option.contains(highlighted, id),
    Branch: () => true,
    Thinking: () => true,
    RuntimeMode: () => true,
    Overflow: () => true,
    EnvMode: () => true,
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

    HighlightedMenuItem: ({ id }) =>
      Option.exists(
        model.triggerMenu,
        (open) =>
          Option.contains(open.highlighted, id) &&
          Option.contains(open.highlightedKey, menuSearchKey(open.trigger))
      )
        ? keep(model)
        : {
            model: modifyFields(model, {
              triggerMenu: (menu) =>
                Option.map(menu, (open) => ({
                  ...open,
                  highlighted: Option.some(id),
                  highlightedKey: Option.some(menuSearchKey(open.trigger)),
                })),
            }),
          },
    PickedMenuItem: ({ id }) => pickMenuItem(model, id),

    OpenedPopover: ({ popover }) => {
      const isOpen = Option.exists(
        model.popover,
        (open) => open._tag === popover._tag
      );

      const searchable =
        Predicate.isTagged(popover, "ModelPicker") ||
        Predicate.isTagged(popover, "Branch");

      return isOpen
        ? { model: closePopover(model) }
        : {
            model: modifyFields(model, { popover: () => Option.some(popover) }),
            commands: searchable ? [FocusPopoverSearch()] : [],
          };
    },
    ClosedPopover: () => ({ model: closePopover(model) }),
    ChangedPopoverQuery: ({ query }) =>
      updatePopover(model, (popover) => withQuery(popover, query)),
    // The pointer moves over a row many times a second; the same row keeps the same Model.
    MovedPopoverHighlight: ({ id }) =>
      Option.exists(model.popover, (popover) => isHighlighted(popover, id))
        ? keep(model)
        : updatePopover(model, (popover) => withHighlight(popover, id)),
    // A model the catalog lists as unavailable (no key, no login) is not picked (T30).
    PickedModel: ({ model: chosen }) =>
      Option.exists(findListing(model, chosen), (listing) => !listing.available)
        ? keep(model)
        : chooseModel(model, chosen),
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
    MintedHomeDraft: ({ draftId }) => {
      const next = modifyFields(model, {
        homeDraftId: () => Option.some(draftId),
      });

      return { model: next, commands: moveHeroToDraftUrl(next) };
    },
    MovedHeroToDraftUrl: () => keep(model),
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
                error: Option.none(),
              }),
            }),
          }
        : keep(model),
    FailedPathSearch: ({ message: reason, projectId, query }) =>
      Option.contains(model.pathSearch.pending, query)
        ? {
            model: modifyFields(model, {
              pathSearch: () => ({
                projectId: Option.some(projectId),
                query,
                pending: Option.none(),
                entries: [],
                error: Option.some(reason),
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
    PreparedTurn: ({ attachments, item, navigateTo }) => ({
      model,
      outMessage: OutMessage.Submitted({ item, navigateTo, attachments }),
    }),
    FailedPrepareTurn: ({
      attachments,
      draft,
      draftKey: key,
      message: reason,
    }) => {
      const restored = restoreDraft(model, key, draft, attachments);

      return {
        model: modifyFields(restored.model, {
          notice: () => Option.some(reason),
        }),
        commands: restored.commands ?? [],
      };
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
    GotAttachmentsMessage: ({ message: trayMessage }) =>
      withTray(
        model,
        Tray.update(model.attachments, trayMessage, {
          draftKey: draftKey(model),
        })
      ),
  });

/** The composer's update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  step(model, message);
