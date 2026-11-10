// The request card's view (plan wave 6, 6A; surfaces note S3): one pending request in the Stone
// look, drawn with the primitives (L3) in the composer's lane. At 1,440 px it sits above the
// composer; on the phone it takes the composer's place, since the composer is hidden while a
// request shows (`card.css`), and its body scrolls inside the card, its edges shaded while more lies
// past them, so its actions stay in reach. What the card says about its answer (why Go is blocked,
// the undo bar, a failed answer) sits with the actions, outside the scrolling body, so it is never
// scrolled out of sight (U-5). Bodies:
//
// - Approval: the tool, the call's detail in a mono block (an Executor program whole), then Decline
//   and Approve, with Allow for this thread beside them. A budget raise has a body of its own
//   (ADR 0047): the scope by its title, what it spent against its line and the line proposed, then
//   Decline and Approve only.
// - Question: one question at a time with "i/N", options as buttons led by a radio (one answer) or
//   a check box (several), filled once picked (U-17), and ending in their digit on a fine pointer
//   (1 to 9; the digits work while focus is in the options and not in a text field), "Something
//   else" when the question takes the user's own words, then Back, Decline, and Next or Send. Send
//   opens the undo bar.
// - Brief (a subagent's brief or a workflow's launch; 6B): its fields in reading order and what the
//   models it names run on now, then Send back (a subagent's brief or a launch), Run on 1 first (a
//   launch of more than one node), Decline and Go. While a named model does not resolve, Go is
//   blocked with a plain reason and Check again; Send back opens a notes field first. Change budget
//   opens dollars and tokens fields, and the Budget line reads what Go will send. A launch (6F)
//   leads with its numbers (`LaunchCard.ts`: nodes, the estimate, which is never a zero for an
//   unknown, the budget, what Go covers), then the model each call site runs on and its arguments,
//   folded.
// - Criteria: the criteria and their judges, then Decline and Approve.
//
// Decline opens a reason field first. A request answered elsewhere while it showed leaves a closed
// notice with its settled line. A child's escalated question (a mirror, ADR 0027) links to the child
// that asked ("Open subagent", plan 6D). Hooks for the judges (`judges/surfaces.ts`):
// `data-testid` on the card and its parts, `data-action` on every control.

import "./card.css";
import {
  goBlockOf,
  modelQuestionOf,
  proposedBudgetOf,
  runsOnLine,
  takesBudgetEdit,
  takesRunOnOne,
  takesSendBack,
} from "@cairn/client-logic/BriefGo";
import {
  argsText,
  callSiteRows,
  launchNumbers,
} from "@cairn/client-logic/LaunchCard";
import {
  approvalDetail,
  briefLines,
  budgetRaiseLines,
  budgetText,
  criterionText,
  requestKindWord,
  requestTitle,
} from "@cairn/client-logic/PendingCard";
import type { CardLine } from "@cairn/client-logic/PendingCard";
import type { PendingRequest } from "@cairn/client-logic/PendingRequests";
import { RequestBody } from "@cairn/client-logic/PendingRequests";
import { deriveProgress } from "@cairn/client-logic/PendingUserInput";
import type { Progress } from "@cairn/client-logic/PendingUserInput";
import type { ApprovalId } from "@cairn/protocol/Ids";
import type {
  Brief,
  BudgetRaisePayload,
  Question,
  WorkflowLaunch,
} from "@cairn/protocol/Policy";
import { Array, Option, Result } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Circle, CircleDot, Square, SquareCheck } from "lucide";

import type { IconNode } from "../composer/Icon.ts";
import { threadRouter } from "../Route.ts";
import { banner } from "../ui/Banner.ts";
import { button, buttonDefaults } from "../ui/Button.ts";
import type { ButtonConfig } from "../ui/Button.ts";
import { card, recordLines } from "../ui/Card.ts";
import { chip } from "../ui/Chip.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_RING,
  FOCUS_RING_INSET,
  HIT_HEIGHT,
  TYPE,
  WEIGHT_MEDIUM,
} from "../ui/Classes.ts";
import { classNames } from "../ui/ClassNames.ts";
import { fieldDefaults, inputField, textareaField } from "../ui/Field.ts";
import { glyph } from "../ui/Glyph.ts";
import { kbd } from "../ui/Kbd.ts";
import { statusChip } from "../ui/StatusChip.ts";
import { Message } from "./Message.ts";
import { ModelCheckState } from "./Model.ts";
import type { Model } from "./Model.ts";
import {
  budgetEdit,
  draftsOf,
  goHeld,
  isAnswerable,
  questionIndexOf,
  shownRequest,
} from "./Update.ts";

type H = HtmlBuilder<Message>;

/** The parts of a card body: what it shows, and its actions, primary last. */
interface CardParts {
  readonly body: ReadonlyArray<Html>;
  readonly actions: ReadonlyArray<Html>;
}

/** A card's button, its action named by `data-action` for the judges. */
const actionButton = (
  h: H,
  action: string,
  config: Partial<Omit<ButtonConfig<Message>, "attributes">>,
  label: string
): Html =>
  button(
    h,
    {
      ...buttonDefaults<Message>(),
      ...config,
      attributes: [h.DataAttribute("action", action)],
    },
    [label]
  );

/** The digit a key names, 1 to 9, when no modifier is held. */
const digitOf = (
  key: string,
  modifiers: {
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
  }
): Option.Option<number> => {
  if (modifiers.ctrlKey || modifiers.altKey || modifiers.metaKey) {
    return Option.none();
  }

  return /^[1-9]$/u.test(key) ? Option.some(Number(key)) : Option.none();
};

const MONO_BLOCK = classNames(
  "max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-(--radius-small) border border-stroke-1 bg-surface-sunken p-(--space-2) font-(family-name:--font-code) text-ink-1",
  TYPE.small
);

const declineControls = (
  model: Model,
  h: H,
  approvalId: ApprovalId,
  accept: Html
): CardParts => {
  const busy = Option.contains(model.sending, approvalId);
  const isDeclining = Option.contains(model.declining, approvalId);

  if (isDeclining) {
    return {
      body: [
        textareaField(
          h,
          {
            ...fieldDefaults<Message>(
              `request-card-reason-${approvalId}`,
              "Why not? (optional)"
            ),
            hint: Option.some("The model reads your reason."),
          },
          {
            value: model.reasons[approvalId] ?? "",
            placeholder: Option.none(),
            onInput: Option.some((value: string) =>
              Message.ChangedReason({ approvalId, value })
            ),
          },
          2
        ),
      ],
      actions: [
        actionButton(
          h,
          "cancel-decline",
          {
            variant: "ghost",
            onClick: Option.some(Message.ClickedCancelDecline()),
            isDisabled: busy,
          },
          "Cancel"
        ),
        actionButton(
          h,
          "confirm-decline",
          {
            variant: "danger",
            onClick: Option.some(Message.ClickedConfirmDecline({ approvalId })),
            isBusy: busy,
          },
          "Decline"
        ),
      ],
    };
  }

  return {
    body: [],
    actions: [
      actionButton(
        h,
        "decline",
        {
          variant: "secondary",
          onClick: Option.some(Message.ClickedDecline({ approvalId })),
          // Not while a question's answers wait out their undo window: Undo first.
          isDisabled: !isAnswerable(model, approvalId),
        },
        "Decline"
      ),
      accept,
    ],
  };
};

const acceptButton = (
  model: Model,
  h: H,
  approvalId: ApprovalId,
  action: string,
  label: string
): Html =>
  actionButton(
    h,
    action,
    {
      variant: "primary",
      onClick: Option.some(
        Message.ClickedAccept({ approvalId, decision: "accept" })
      ),
      isBusy: Option.contains(model.sending, approvalId),
      isDisabled: Option.isSome(model.sending),
    },
    label
  );

/**
 * A budget raise (ADR 0047): the scope by its title, what it spent against its line and the line
 * proposed, then Decline and Approve. A raise is not a tool the thread runs, so it names no tool and
 * offers no standing yes.
 */
const raiseBody = (
  model: Model,
  h: H,
  approvalId: ApprovalId,
  raise: BudgetRaisePayload
): CardParts => {
  const decline = declineControls(
    model,
    h,
    approvalId,
    acceptButton(model, h, approvalId, "approve", "Approve")
  );

  return {
    body: [
      h.div(
        [h.DataAttribute("testid", "request-card-raise")],
        [recordLines(h, budgetRaiseLines(raise))]
      ),
      ...decline.body,
    ],
    actions: decline.actions,
  };
};

const approvalBody = (
  model: Model,
  h: H,
  request: PendingRequest,
  body: Extract<RequestBody, { readonly _tag: "Approval" }>
) => {
  const approvalId = request.record.id;

  const raise = Option.flatMap(body.payload, (payload) =>
    payload.type === "budget-raise" ? Option.some(payload) : Option.none()
  );

  if (Option.isSome(raise)) {
    return raiseBody(model, h, approvalId, raise.value);
  }

  const detail = Option.match(
    approvalDetail(request.record.summary, body.payload),
    {
      onNone: () => h.empty,
      onSome: (text) =>
        h.pre(
          [
            h.DataAttribute("testid", "request-card-detail"),
            h.Class(MONO_BLOCK),
          ],
          [text]
        ),
    }
  );

  const decline = declineControls(
    model,
    h,
    approvalId,
    acceptButton(model, h, approvalId, "approve", "Approve")
  );

  return {
    body: [
      h.p(
        [h.DataAttribute("testid", "request-card-tool"), h.Class("text-ink-2")],
        [`${request.record.tool} asks to run:`]
      ),
      detail,
      ...decline.body,
    ],
    actions: Option.isSome(model.declining)
      ? decline.actions
      : [
          actionButton(
            h,
            "allow-thread",
            {
              variant: "ghost",
              onClick: Option.some(
                Message.ClickedAccept({
                  approvalId,
                  decision: "accept_for_thread",
                })
              ),
              isDisabled: Option.isSome(model.sending),
            },
            "Allow for this thread"
          ),
          ...decline.actions,
        ],
  };
};

interface MarkGlyph {
  readonly node: IconNode;
  readonly name: string;
}

/** The lucide glyphs of an option's mark, resting and picked. */
const OPTION_MARKS: Readonly<
  Record<
    "radio" | "check",
    { readonly resting: MarkGlyph; readonly picked: MarkGlyph }
  >
> = {
  radio: {
    resting: { node: Circle, name: "circle" },
    picked: { node: CircleDot, name: "circle-dot" },
  },
  check: {
    resting: { node: Square, name: "square" },
    picked: { node: SquareCheck, name: "square-check" },
  },
};

/**
 * The mark an option leads with, so it reads as a choice on a phone too, where no digit follows it
 * (U-17): a radio for a question of one answer, a check box for one of several, filled once picked.
 */
const optionMark = (h: H, multiSelect: boolean, isPicked: boolean): Html => {
  const { name, node } =
    OPTION_MARKS[multiSelect ? "check" : "radio"][
      isPicked ? "picked" : "resting"
    ];

  return h.span(
    [
      h.DataAttribute("option-mark", multiSelect ? "check" : "radio"),
      h.DataAttribute("picked", String(isPicked)),
      // Its top on the label's first line: the label's line is 1.25rem, the mark 1rem.
      h.Class(
        classNames(
          "mt-(--space-0-5) flex shrink-0",
          isPicked ? "text-accent-text" : "text-ink-3"
        )
      ),
    ],
    [glyph(h, node, name, "regular")]
  );
};

const optionButton = (
  model: Model,
  h: H,
  approvalId: ApprovalId,
  index: number,
  question: Question,
  progress: Progress,
  optionIndex: number
): Html => {
  const option = question.options[optionIndex];

  if (option === undefined) {
    return h.empty;
  }

  const isPicked =
    !progress.usingCustomAnswer && progress.picks.includes(option.label);

  return h.button(
    [
      h.Type("button"),
      h.DataAttribute("action", "option"),
      h.DataAttribute("option-index", String(optionIndex + 1)),
      h.AriaPressed(isPicked ? "true" : "false"),
      h.Disabled(!isAnswerable(model, approvalId)),
      h.OnClick(
        Message.PickedOption({ approvalId, index, label: option.label })
      ),
      h.Class(
        classNames(
          "flex w-full min-w-0 cursor-pointer items-center gap-(--space-2) rounded-(--radius-small) border border-transparent px-(--space-2) py-(--space-1-5) text-start text-ink-1 hover:bg-select-1 aria-pressed:border-stroke-2 aria-pressed:bg-select-2 disabled:cursor-not-allowed disabled:opacity-50",
          HIT_HEIGHT,
          FOCUS_RING_INSET,
          FEEDBACK_MOTION
        )
      ),
    ],
    [
      h.span(
        [h.Class("flex min-w-0 flex-1 items-start gap-(--space-2)")],
        [
          optionMark(h, question.multiSelect, isPicked),
          h.span(
            [h.Class("flex min-w-0 flex-1 flex-col gap-(--space-0-5)")],
            [
              h.span(
                [
                  h.Class(
                    "flex min-w-0 flex-wrap items-center gap-(--space-1-5)"
                  ),
                ],
                [
                  h.span(
                    [
                      h.Class(
                        classNames(
                          "min-w-0 break-words",
                          TYPE.ui,
                          WEIGHT_MEDIUM
                        )
                      ),
                    ],
                    [option.label]
                  ),
                  option.recommended
                    ? chip(h, "accent", {
                        glyph: Option.none(),
                        label: "Recommended",
                        count: Option.none(),
                      })
                    : h.empty,
                ]
              ),
              option.description === null || option.description === option.label
                ? h.empty
                : h.span(
                    [
                      h.Class(
                        classNames("min-w-0 break-words text-ink-2", TYPE.small)
                      ),
                    ],
                    [option.description]
                  ),
            ]
          ),
        ]
      ),
      h.span(
        [h.Class("pointer-coarse:hidden")],
        [kbd(h, String(optionIndex + 1))]
      ),
    ]
  );
};

const questionBody = (
  model: Model,
  h: H,
  request: PendingRequest,
  questions: ReadonlyArray<Question>
) => {
  const approvalId = request.record.id;

  const progress = deriveProgress(
    questions,
    draftsOf(model, approvalId),
    questionIndexOf(model, approvalId)
  );

  const index = progress.questionIndex;
  const answerable = isAnswerable(model, approvalId);
  const isDeclining = Option.contains(model.declining, approvalId);

  const forward = progress.isLastQuestion
    ? actionButton(
        h,
        "send",
        {
          variant: "primary",
          onClick: Option.some(Message.ClickedSend({ approvalId })),
          isDisabled: !answerable || !progress.isComplete,
          isBusy: Option.contains(model.sending, approvalId),
        },
        "Send"
      )
    : actionButton(
        h,
        "next",
        {
          variant: "primary",
          onClick: Option.some(Message.ClickedNext({ approvalId })),
          isDisabled: !answerable || !progress.canAdvance,
        },
        "Next"
      );

  // A question can be declined too (the model reads "The user declined to answer"), so a question
  // the options do not fit always has a way out, even on the phone where the composer is hidden.
  const decline = declineControls(model, h, approvalId, forward);

  return Option.match(progress.activeQuestion, {
    onNone: () => ({ body: [], actions: [] }),
    onSome: (question) => ({
      body: [
        h.div(
          [h.Class("flex min-w-0 items-center gap-(--space-2)")],
          [
            h.span(
              [
                h.DataAttribute("testid", "request-card-header"),
                h.Class(
                  classNames(
                    "min-w-0 flex-1 break-words text-ink-1",
                    WEIGHT_MEDIUM
                  )
                ),
              ],
              [question.header]
            ),
            questions.length > 1
              ? h.span(
                  [
                    h.DataAttribute("testid", "request-card-question-position"),
                    h.Class(
                      classNames("shrink-0 tabular-nums text-ink-3", TYPE.small)
                    ),
                  ],
                  [`${index + 1}/${questions.length}`]
                )
              : h.empty,
          ]
        ),
        h.p(
          [
            h.DataAttribute("testid", "request-card-question"),
            h.Class("text-ink-1"),
          ],
          [question.question]
        ),
        question.multiSelect && !isDeclining
          ? h.p(
              [h.Class(classNames("text-ink-2", TYPE.small))],
              ["Pick one or more."]
            )
          : h.empty,
        question.options.length === 0 || isDeclining
          ? h.empty
          : h.div(
              [
                h.DataAttribute("testid", "request-card-options"),
                h.Role("group"),
                h.AriaLabel(
                  `Options for ${question.header}; press 1 to ${Math.min(question.options.length, 9)} to pick`
                ),
                h.Tabindex(0),
                h.OnKeyDownPreventDefault((key, modifiers) =>
                  Option.flatMap(digitOf(key, modifiers), (digit) =>
                    Option.map(
                      Option.filter(
                        Option.fromUndefinedOr(question.options[digit - 1]),
                        () => answerable
                      ),
                      (option) =>
                        Message.PickedOption({
                          approvalId,
                          index,
                          label: option.label,
                        })
                    )
                  )
                ),
                h.Class(
                  classNames(
                    "flex min-w-0 flex-col gap-(--space-0-5) rounded-(--radius-small)",
                    FOCUS_RING
                  )
                ),
              ],
              question.options.map((_option, optionIndex) =>
                optionButton(
                  model,
                  h,
                  approvalId,
                  index,
                  question,
                  progress,
                  optionIndex
                )
              )
            ),
        question.allowCustomAnswer && !isDeclining
          ? inputField(
              h,
              {
                ...fieldDefaults<Message>(
                  `request-card-custom-${approvalId}-${index}`,
                  question.options.length === 0
                    ? "Your answer"
                    : "Something else"
                ),
                isDisabled: !answerable,
              },
              {
                value: progress.custom,
                placeholder: Option.none(),
                onInput: Option.some((value: string) =>
                  Message.ChangedCustom({ approvalId, index, value })
                ),
              }
            )
          : h.empty,
        ...decline.body,
      ],
      actions: isDeclining
        ? decline.actions
        : [
            index > 0
              ? actionButton(
                  h,
                  "back",
                  {
                    variant: "ghost",
                    onClick: Option.some(Message.ClickedBack({ approvalId })),
                    isDisabled: !answerable,
                  },
                  "Back"
                )
              : h.empty,
            ...decline.actions,
          ],
    }),
  });
};

/** The "Runs on" line of a brief or a launch: what the models it names resolve to now, as far as known. */
const runsOn = (
  model: Model,
  request: PendingRequest
): ReadonlyArray<CardLine> => {
  if (Option.isNone(modelQuestionOf(request.record, request.body))) {
    return [];
  }

  const state: ModelCheckState | undefined =
    model.modelChecks[request.record.id];

  if (state === undefined) {
    return [["Runs on", "Checked once Cairn is connected"]];
  }

  return ModelCheckState.match(state, {
    Checking: (): ReadonlyArray<CardLine> => [
      ["Runs on", "Checking the models…"],
    ],
    Checked: ({ checks }): ReadonlyArray<CardLine> => [
      ["Runs on", runsOnLine(checks)],
    ],
    Unchecked: ({ message }): ReadonlyArray<CardLine> => [
      ["Runs on", `Not checked: ${message} Go checks it again.`],
    ],
  });
};

/**
 * Why Go is blocked, with Check again; none when it is not, or when Decline or Send back took Go's
 * place.
 */
const goBlockBar = (
  model: Model,
  h: H,
  request: PendingRequest
): Option.Option<Html> => {
  const approvalId = request.record.id;
  const state: ModelCheckState | undefined = model.modelChecks[approvalId];

  const block =
    RequestBody.$is("Brief")(request.body) &&
    !Option.contains(model.declining, approvalId) &&
    !Option.contains(model.sendingBack, approvalId) &&
    state !== undefined &&
    ModelCheckState.guards.Checked(state)
      ? goBlockOf(state.checks)
      : Option.none();

  return Option.map(block, (found) =>
    banner(
      h,
      {
        tone: "failed",
        mark: Option.none(),
        title: found.title,
        detail: Option.some(found.detail),
        actions: [
          actionButton(
            h,
            "check-models",
            {
              variant: "ghost",
              size: "small",
              onClick: Option.some(Message.ClickedCheckModels({ approvalId })),
            },
            "Check again"
          ),
        ],
      },
      [
        h.DataAttribute("testid", "request-card-go-blocked"),
        h.DataAttribute("spec", found.spec),
      ]
    )
  );
};

/** A brief's or a launch's Send back: its notes field (required) and its two buttons. */
const sendBackControls = (
  model: Model,
  h: H,
  approvalId: ApprovalId,
  hint: string
): CardParts => {
  const busy = Option.contains(model.sending, approvalId);
  const notes = model.notes[approvalId] ?? "";

  return {
    body: [
      textareaField(
        h,
        {
          ...fieldDefaults<Message>(
            `request-card-notes-${approvalId}`,
            "What should change?"
          ),
          hint: Option.some(hint),
        },
        {
          value: notes,
          placeholder: Option.none(),
          onInput: Option.some((value: string) =>
            Message.ChangedNotes({ approvalId, value })
          ),
        },
        3
      ),
    ],
    actions: [
      actionButton(
        h,
        "cancel-send-back",
        {
          variant: "ghost",
          onClick: Option.some(Message.ClickedCancelSendBack()),
          isDisabled: busy,
        },
        "Cancel"
      ),
      actionButton(
        h,
        "confirm-send-back",
        {
          variant: "primary",
          onClick: Option.some(Message.ClickedConfirmSendBack({ approvalId })),
          isBusy: busy,
          isDisabled: notes.trim() === "" || Option.isSome(model.sending),
        },
        "Send back"
      ),
    ],
  };
};

/** Go, or Run on 1 first: held while the models are checked, blocked while one does not resolve. */
const goButton = (
  model: Model,
  h: H,
  request: PendingRequest,
  decision: "accept" | "accept_sample"
): Html => {
  const approvalId = request.record.id;

  return actionButton(
    h,
    decision === "accept" ? "go" : "run-on-one",
    {
      variant: decision === "accept" ? "primary" : "secondary",
      onClick: Option.some(Message.ClickedAccept({ approvalId, decision })),
      isBusy:
        Option.contains(model.sending, approvalId) &&
        model.sent[approvalId] === decision,
      isDisabled:
        Option.isSome(model.sending) ||
        goHeld(model, request) ||
        Result.isFailure(budgetEdit(model, request)),
    },
    decision === "accept" ? "Go" : "Run on 1 first"
  );
};

/** A launch's call sites: each one's label, then its phase, model, access and count. */
const callSitesList = (h: H, launch: WorkflowLaunch): Html => {
  const rows = callSiteRows(launch);

  return rows.length === 0
    ? h.empty
    : h.ul(
        [
          h.DataAttribute("testid", "request-card-call-sites"),
          h.AriaLabel("What each node runs on"),
          h.Class(
            "flex min-w-0 flex-col gap-(--space-1) border-t border-stroke-1 pt-(--space-2)"
          ),
        ],
        rows.map((row) =>
          h.li(
            [
              h.DataAttribute("testid", "request-card-call-site"),
              h.DataAttribute("model", row.model),
              h.Class("flex min-w-0 flex-col"),
            ],
            [
              h.span(
                [h.Class(classNames("min-w-0 text-ink-1", TYPE.ui))],
                [row.label]
              ),
              h.span(
                [
                  h.Class(
                    classNames("min-w-0 break-words text-ink-2", TYPE.small)
                  ),
                ],
                [row.detail]
              ),
            ]
          )
        )
      );
};

/** A launch's arguments, folded behind "Arguments"; nothing for none. */
const argsBlock = (h: H, launch: WorkflowLaunch): Html =>
  Option.match(argsText(launch.args), {
    onNone: () => h.empty,
    onSome: (text) =>
      h.details(
        [h.DataAttribute("testid", "request-card-args")],
        [
          h.summary(
            [
              h.DataAttribute("action", "show-args"),
              h.Class(
                classNames(
                  "flex cursor-pointer items-center rounded-(--radius-small) text-ink-2 hover:text-ink-1",
                  TYPE.small,
                  HIT_HEIGHT,
                  FOCUS_RING
                )
              ),
            ],
            ["Arguments"]
          ),
          h.pre([h.Class(MONO_BLOCK)], [text]),
        ]
      ),
  });

/**
 * The Budget line's value: what Go will send, the proposal's budget or the one the user set
 * (ADR 0047), so "No limit" shows only when no limit is what will run.
 */
const budgetLineText = (
  model: Model,
  request: PendingRequest,
  payload: Brief | WorkflowLaunch
): string => {
  const proposed = proposedBudgetOf(payload);

  return Option.match(
    Result.getOrElse(budgetEdit(model, request), Option.none),
    {
      onNone: () => budgetText(proposed),
      onSome: (edited) =>
        `${budgetText(edited)} (changed from ${budgetText(proposed)})`,
    }
  );
};

/** A card's lines with its Budget line reading `text`. */
const withBudgetLine = (
  lines: ReadonlyArray<CardLine>,
  text: string
): ReadonlyArray<CardLine> =>
  lines.map((line) => (line[0] === "Budget" ? ["Budget", text] : line));

/**
 * The budget field of a subagent's brief or a workflow's launch (ADR 0047): Change budget opens
 * dollars and tokens fields from the proposal's budget, and Keep proposed closes them. Go sends
 * what they say; the proposal stays as its model wrote it.
 */
const budgetControls = (model: Model, h: H, request: PendingRequest): Html => {
  const approvalId = request.record.id;

  // Decline and Send back send no budget, so their fields take the field's place.
  if (
    !takesBudgetEdit(request.record, request.body) ||
    Option.contains(model.declining, approvalId) ||
    Option.contains(model.sendingBack, approvalId)
  ) {
    return h.empty;
  }

  const draft = model.budgets[approvalId];
  const busy = !isAnswerable(model, approvalId);

  if (draft === undefined) {
    return h.div(
      [h.Class("flex")],
      [
        actionButton(
          h,
          "change-budget",
          {
            variant: "ghost",
            size: "small",
            onClick: Option.some(Message.ClickedChangeBudget({ approvalId })),
            isDisabled: busy,
          },
          "Change budget"
        ),
      ]
    );
  }

  const problem = Result.match(budgetEdit(model, request), {
    onSuccess: () => Option.none<string>(),
    onFailure: Option.some,
  });

  return h.div(
    [
      h.DataAttribute("testid", "request-card-budget"),
      h.Class("flex min-w-0 flex-col gap-(--space-2)"),
    ],
    [
      h.div(
        [h.Class("grid min-w-0 gap-(--space-2) sm:grid-cols-2")],
        [
          inputField(
            h,
            {
              ...fieldDefaults<Message>(
                `request-card-budget-dollars-${approvalId}`,
                "Dollars at API list price"
              ),
              isDisabled: busy,
            },
            {
              value: draft.dollars,
              placeholder: Option.some("No limit"),
              onInput: Option.some((value: string) =>
                Message.ChangedBudgetDollars({ approvalId, value })
              ),
            }
          ),
          inputField(
            h,
            {
              ...fieldDefaults<Message>(
                `request-card-budget-tokens-${approvalId}`,
                "Tokens"
              ),
              isDisabled: busy,
            },
            {
              value: draft.tokens,
              placeholder: Option.some("No limit"),
              onInput: Option.some((value: string) =>
                Message.ChangedBudgetTokens({ approvalId, value })
              ),
            }
          ),
        ]
      ),
      h.p(
        [
          h.DataAttribute("testid", "request-card-budget-hint"),
          h.Class(
            classNames(
              Option.isSome(problem) ? "text-tone-failed" : "text-ink-2",
              TYPE.small
            )
          ),
        ],
        [
          Option.getOrElse(
            problem,
            () =>
              "Go sends this budget; at its line the work stops. Leave both empty for no limit."
          ),
        ]
      ),
      h.div(
        [h.Class("flex")],
        [
          actionButton(
            h,
            "keep-budget",
            {
              variant: "ghost",
              size: "small",
              onClick: Option.some(Message.ClickedKeepBudget({ approvalId })),
              isDisabled: busy,
            },
            "Keep proposed budget"
          ),
        ]
      ),
    ]
  );
};

/** What the card shows of a brief or a launch before its block bar and its answer fields. */
const briefFields = (
  model: Model,
  h: H,
  request: PendingRequest,
  payload: Brief | WorkflowLaunch
): ReadonlyArray<Html> => {
  const budget = budgetLineText(model, request, payload);

  return payload.type === "workflow"
    ? [
        recordLines(h, [
          ...withBudgetLine(launchNumbers(payload), budget),
          ...runsOn(model, request),
          ["Does", payload.description],
        ]),
        budgetControls(model, h, request),
        callSitesList(h, payload),
        argsBlock(h, payload),
      ]
    : [
        recordLines(h, [
          ...withBudgetLine(briefLines(payload), budget),
          ...runsOn(model, request),
        ]),
        budgetControls(model, h, request),
      ];
};

const briefBody = (
  model: Model,
  h: H,
  request: PendingRequest,
  body: Extract<RequestBody, { readonly _tag: "Brief" }>
) => {
  const approvalId = request.record.id;
  const fields = briefFields(model, h, request, body.payload);

  if (Option.contains(model.sendingBack, approvalId)) {
    const sendBack = sendBackControls(
      model,
      h,
      approvalId,
      body.payload.type === "workflow"
        ? "The model reads your notes and proposes the workflow again. Nothing runs."
        : "The parent reads your notes and writes a new brief."
    );

    return {
      body: [...fields, ...sendBack.body],
      actions: sendBack.actions,
    };
  }

  const decline = declineControls(
    model,
    h,
    approvalId,
    goButton(model, h, request, "accept")
  );

  const isDeclining = Option.contains(model.declining, approvalId);

  const extra = isDeclining
    ? []
    : [
        takesSendBack(request.record, request.body)
          ? actionButton(
              h,
              "send-back",
              {
                variant: "ghost",
                onClick: Option.some(Message.ClickedSendBack({ approvalId })),
                isDisabled: !isAnswerable(model, approvalId),
              },
              "Send back"
            )
          : h.empty,
        takesRunOnOne(request.body)
          ? goButton(model, h, request, "accept_sample")
          : h.empty,
      ];

  return {
    body: [...fields, ...decline.body],
    actions: [...extra, ...decline.actions],
  };
};

const criteriaBody = (
  model: Model,
  h: H,
  request: PendingRequest,
  body: Extract<RequestBody, { readonly _tag: "Criteria" }>
) => {
  const approvalId = request.record.id;

  const decline = declineControls(
    model,
    h,
    approvalId,
    acceptButton(model, h, approvalId, "approve", "Approve")
  );

  return {
    body: [
      h.ul(
        [h.Class("flex list-disc flex-col gap-(--space-1) ps-(--space-4)")],
        body.criteria.map((criterion) => h.li([], [criterionText(criterion)]))
      ),
      ...decline.body,
    ],
    actions: decline.actions,
  };
};

const bodyOf = (model: Model, h: H, request: PendingRequest) =>
  RequestBody.$match(request.body, {
    Approval: (body) => approvalBody(model, h, request, body),
    Question: ({ questions }) => questionBody(model, h, request, questions),
    Brief: (body) => briefBody(model, h, request, body),
    Criteria: (body) => criteriaBody(model, h, request, body),
  });

/** What the undo bar says: when the answers go, and what a due window waits for. */
const undoTitle = (model: Model, state: "waiting" | "due"): string => {
  if (state !== "due") {
    return "Sending your answers in 3 seconds.";
  }

  // Due and still here: connected, it waits for the answer on its way; offline, for Cairn.
  return model.hasClient
    ? "Sending your answers after the ones on their way."
    : "Sending your answers once Cairn is back.";
};

const undoBar = (
  model: Model,
  h: H,
  approvalId: ApprovalId
): Option.Option<Html> =>
  Option.map(
    Option.filter(model.undo, (undo) => undo.approvalId === approvalId),
    (undo) =>
      banner(
        h,
        {
          tone: "waiting",
          mark: Option.none(),
          title: undoTitle(model, undo.state),
          detail: Option.none(),
          actions: [
            actionButton(
              h,
              "undo",
              {
                variant: "secondary",
                size: "small",
                onClick: Option.some(Message.ClickedUndo()),
              },
              "Undo"
            ),
          ],
        },
        [h.DataAttribute("testid", "request-card-undo")]
      )
  );

const failureBar = (model: Model, h: H): Option.Option<Html> =>
  Option.map(model.failure, (text) =>
    banner(
      h,
      {
        tone: "failed",
        mark: Option.none(),
        title: text,
        detail: Option.none(),
        actions: [],
      },
      [h.DataAttribute("testid", "request-card-failure")]
    )
  );

/**
 * Why Go waits on the budget field: what it holds is not a budget. The field's own hint says so too,
 * but it scrolls with the body, and Go, disabled, never says why on a press.
 */
const budgetBlockBar = (
  model: Model,
  h: H,
  request: PendingRequest
): Option.Option<Html> =>
  Option.map(
    Option.filter(
      Result.getFailure(budgetEdit(model, request)),
      () =>
        !Option.contains(model.declining, request.record.id) &&
        !Option.contains(model.sendingBack, request.record.id)
    ),
    (problem) =>
      banner(
        h,
        {
          tone: "failed",
          mark: Option.none(),
          title: "Go waits on the budget.",
          detail: Option.some(problem),
          actions: [],
        },
        [h.DataAttribute("testid", "request-card-budget-blocked")]
      )
  );

/**
 * What the card says about its answer, pinned with its actions below the scrolling body so it is
 * always in view (U-5): why Go is blocked by a model or by the budget field, the undo bar, and why
 * the last answer did not go.
 */
const statusOf = (
  model: Model,
  h: H,
  request: PendingRequest
): ReadonlyArray<Html> =>
  Array.getSomes([
    goBlockBar(model, h, request),
    budgetBlockBar(model, h, request),
    undoBar(model, h, request.record.id),
    failureBar(model, h),
  ]);

const requestCard = (model: Model, h: H, request: PendingRequest): Html => {
  const { body, actions } = bodyOf(model, h, request);
  const status = statusOf(model, h, request);

  return card(
    h,
    {
      tone: "waiting",
      // No left rule on a request (the user, 2026-11-10); the status chip says it waits.
      rule: false,
      title: requestTitle(request.record, request.body),
      aside: [
        statusChip(h, {
          tone: "waiting",
          mark: "needs",
          word: requestKindWord(request.body),
        }),
        request.total > 1
          ? h.span(
              [
                h.DataAttribute("testid", "request-card-position"),
                h.Class(classNames("tabular-nums text-ink-3", TYPE.small)),
              ],
              [`${request.position}/${request.total}`]
            )
          : h.empty,
        // A child's question escalated to the user (ADR 0027): the way to the child that asked.
        request.record.mirrorOf === null
          ? h.empty
          : h.a(
              [
                h.DataAttribute("testid", "request-card-subagent"),
                h.DataAttribute("action", "open-subagent"),
                h.Href(
                  threadRouter({ threadId: request.record.mirrorOf.threadId })
                ),
                h.Class(
                  classNames(
                    "rounded-(--radius-small) text-ink-2 underline decoration-stroke-2 underline-offset-2 hover:text-ink-1",
                    TYPE.small,
                    FOCUS_RING
                  )
                ),
              ],
              ["Open subagent"]
            ),
      ],
      body: [
        h.div(
          [h.Class("flex min-w-0 flex-col gap-(--space-3)")],
          [
            // Its edges shade while more lies past them (`card.css`), so a body that scrolls says so.
            h.div(
              [
                h.DataAttribute("testid", "request-card-body"),
                h.DataAttribute("scroll-edges", "true"),
                h.Class(
                  "flex max-h-[45dvh] min-w-0 flex-col gap-(--space-3) overflow-y-auto overscroll-contain sm:max-h-[50dvh]"
                ),
              ],
              body
            ),
            status.length === 0
              ? h.empty
              : h.div(
                  [
                    h.DataAttribute("testid", "request-card-status"),
                    h.Class("flex min-w-0 flex-col gap-(--space-2)"),
                  ],
                  status
                ),
          ]
        ),
      ],
      actions,
    },
    [
      h.DataAttribute("testid", "request-card"),
      h.DataAttribute("request-kind", request.record.kind),
      h.DataAttribute("request-body", request.body._tag),
      h.DataAttribute("approval-id", request.record.id),
      h.AriaLabel(
        `${requestKindWord(request.body)}: ${requestTitle(request.record, request.body)}`
      ),
    ]
  );
};

const closedNotice = (model: Model, h: H): Html =>
  Option.match(model.closed, {
    onNone: () => h.empty,
    onSome: (closed) =>
      h.div(
        [
          h.DataAttribute("testid", "request-card-closed"),
          h.DataAttribute("approval-id", closed.approvalId),
          h.Class("flex min-w-0 flex-col gap-(--space-2)"),
        ],
        [
          banner(h, {
            tone: "neutral",
            mark: Option.some("info"),
            title: closed.text,
            detail: Option.some(
              closed.typed === ""
                ? "It was settled somewhere else."
                : "It was settled somewhere else. What you typed is back in the composer, and below."
            ),
            actions: [
              actionButton(
                h,
                "dismiss-closed",
                {
                  variant: "ghost",
                  size: "small",
                  onClick: Option.some(Message.DismissedClosed()),
                },
                "Dismiss"
              ),
            ],
          }),
          closed.typed === ""
            ? h.empty
            : h.pre(
                [
                  h.DataAttribute("testid", "request-card-closed-typed"),
                  h.Class(MONO_BLOCK),
                ],
                [closed.typed]
              ),
        ]
      ),
  });

/** The card in the composer's lane, as the frame embeds it with `h.submodel`. */
export const view = Submodel.defineView<Model, Message>((model, h) => {
  const request = shownRequest(model);

  const content = Option.match(request, {
    onNone: () => closedNotice(model, h),
    onSome: (shown) => requestCard(model, h, shown),
  });

  return h.div(
    [
      // Keyed, so drawing it before the composer never makes the composer's element anew.
      h.Key("request-card"),
      h.DataAttribute("slot", "request-card-slot"),
      // While a request shows, the composer gives the card its slot on the phone (card.css).
      h.DataAttribute(
        "request-card-up",
        Option.isSome(request) ? "true" : "false"
      ),
      h.Class("contents"),
    ],
    [
      Option.isNone(request) && Option.isNone(model.closed)
        ? h.empty
        : h.div(
            [
              h.DataAttribute("slot", "request-card-lane"),
              h.Class(
                "chat-composer-lane relative z-20 w-full shrink-0 pt-(--space-2) max-sm:pb-[calc(env(safe-area-inset-bottom)+var(--space-3))]"
              ),
            ],
            [
              h.div(
                [h.Class("mx-auto w-full max-w-(--chat-content-max-width)")],
                [content]
              ),
            ]
          ),
    ]
  );
});
