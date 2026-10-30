// The request card's view (plan wave 6, 6A; surfaces note S3): one pending request in the Stone
// look, drawn with the `next` primitives (L3) in the composer's lane. At 1,440 px it sits above the
// composer; on the phone it takes the composer's place, since the composer is hidden while a
// request shows (`card.css`), and its body scrolls inside the card so its actions stay in
// reach. Bodies:
//
// - Approval: the tool, the call's detail in a mono block (an Executor program whole, a budget
//   raise as its two budgets), then Decline and Approve, with Allow for this thread beside them.
// - Question: one question at a time with "i/N", options as buttons with their digit (1 to 9; the
//   digits work while focus is in the options and not in a text field), "Something else" when
//   the question takes the user's own words, then Back, Decline, and Next or Send. Send opens the
//   undo bar.
// - Brief (a subagent's brief or a workflow's launch): its fields in reading order, then Decline
//   and Go. Send back, the role check and Run on 1 first are 6B's and 6F's.
// - Criteria: the criteria and their judges, then Decline and Approve.
//
// Decline opens a reason field first. A request answered elsewhere while it showed leaves a closed
// notice with its settled line. A child's escalated question (a mirror, ADR 0027) links to the child
// that asked ("Open subagent", plan 6D). Hooks for the judges (`judges/surfaces.ts`):
// `data-testid` on the card and its parts, `data-action` on every control.

import "./card.css";
import {
  approvalDetail,
  briefLines,
  budgetRaiseLines,
  criterionText,
  requestKindWord,
  requestTitle,
  workflowLines,
} from "@cairn/client-logic/PendingCard";
import type { PendingRequest } from "@cairn/client-logic/PendingRequests";
import { RequestBody } from "@cairn/client-logic/PendingRequests";
import { deriveProgress } from "@cairn/client-logic/PendingUserInput";
import type { Progress } from "@cairn/client-logic/PendingUserInput";
import type { ApprovalId } from "@cairn/protocol/Ids";
import type { Question } from "@cairn/protocol/Policy";
import { Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { threadRouter } from "../../Route.ts";
import { classNames } from "../../ui/ClassNames.ts";
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
import { fieldDefaults, inputField, textareaField } from "../ui/Field.ts";
import { statusGlyph } from "../ui/Glyph.ts";
import { kbd } from "../ui/Kbd.ts";
import { statusChip } from "../ui/StatusChip.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import {
  draftsOf,
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

const approvalBody = (
  model: Model,
  h: H,
  request: PendingRequest,
  body: Extract<RequestBody, { readonly _tag: "Approval" }>
) => {
  const approvalId = request.record.id;

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

  const raise = Option.match(
    Option.filter(body.payload, (payload) => payload.type === "budget-raise"),
    {
      onNone: () => h.empty,
      onSome: (payload) =>
        payload.type === "budget-raise"
          ? recordLines(h, budgetRaiseLines(payload))
          : h.empty,
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
      raise,
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
        [h.Class("flex min-w-0 flex-1 flex-col gap-(--space-0-5)")],
        [
          h.span(
            [h.Class("flex min-w-0 flex-wrap items-center gap-(--space-1-5)")],
            [
              h.span(
                [
                  h.Class(
                    classNames("min-w-0 break-words", TYPE.ui, WEIGHT_MEDIUM)
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
      isPicked
        ? h.span(
            [h.Class("text-accent-text")],
            [statusGlyph(h, "done", "small")]
          )
        : h.span(
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

const briefBody = (
  model: Model,
  h: H,
  request: PendingRequest,
  body: Extract<RequestBody, { readonly _tag: "Brief" }>
) => {
  const approvalId = request.record.id;

  const decline = declineControls(
    model,
    h,
    approvalId,
    acceptButton(model, h, approvalId, "go", "Go")
  );

  return {
    body: [
      recordLines(
        h,
        body.payload.type === "workflow"
          ? workflowLines(body.payload)
          : briefLines(body.payload)
      ),
      ...decline.body,
    ],
    actions: decline.actions,
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

const undoBar = (model: Model, h: H, approvalId: ApprovalId): Html =>
  Option.isSome(
    Option.filter(model.undo, (undo) => undo.approvalId === approvalId)
  )
    ? banner(
        h,
        {
          tone: "waiting",
          mark: Option.none(),
          title: "Sending your answers in 3 seconds.",
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
    : h.empty;

const failureBar = (model: Model, h: H): Html =>
  Option.match(model.failure, {
    onNone: () => h.empty,
    onSome: (text) =>
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
      ),
  });

const requestCard = (model: Model, h: H, request: PendingRequest): Html => {
  const { body, actions } = bodyOf(model, h, request);

  return card(
    h,
    {
      tone: "waiting",
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
          [
            h.DataAttribute("testid", "request-card-body"),
            h.Class(
              "flex max-h-[45dvh] min-w-0 flex-col gap-(--space-3) overflow-y-auto overscroll-contain sm:max-h-[50dvh]"
            ),
          ],
          [...body, undoBar(model, h, request.record.id), failureBar(model, h)]
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
                : "It was settled somewhere else. What you typed is kept below."
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

/** The card in the composer's lane, as the `next` frame embeds it with `h.submodel`. */
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
