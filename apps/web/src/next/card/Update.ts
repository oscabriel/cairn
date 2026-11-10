// The request card's update (plan wave 6, 6A). The behaviour is t3code's composer panels at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92 (`ComposerPendingApprovalPanel.tsx`,
// `ComposerPendingUserInputPanel.tsx`), with Cairn's additions from the briefs note, section 4:
//
// - One request at a time, the first in card order (`pendingRequests`: approvals, then questions,
//   briefs and criteria), with its place among them ("2/3").
// - A question card shows one question at a time. A pick on a single-select question advances
//   after `ADVANCE_MS` (200 ms) unless the user picks again, goes back or the card moves; a
//   multi-select pick toggles. The last question's advance, or Send, opens an undo window of
//   `UNDO_MS` (3 s, Ultimate's undo bar) before `thread.respond`, so an answer taken back never
//   reaches the brain. The answers are checked with `answersProblem` first, as the brain checks
//   them. A window that ends while Cairn is reconnecting, or while another answer is in flight,
//   leaves its answers due, and they go as soon as neither holds.
// - Approve, Allow for this thread and Go answer at once; Decline (on every body, a question's
//   too) opens a reason field first, and the reason (when there is one) reaches the model.
// - A brief or a workflow's launch (6B, `BriefGo.ts`): the models it names are checked with
//   `models.check` when it shows, again when the connection comes back (a brain restart) and on
//   Check again. Go and Run on 1 first are held while the check is out and blocked while a named
//   model does not resolve; a check that could not be made holds nothing, since the brain checks
//   again at Go. A request that names no model runs on its parent's and is not checked. Send back (a subagent's brief only) opens a notes field and needs notes; Run on 1 first
//   (a launch of more than one node only) answers `accept_sample`.
// - A subagent's brief or a workflow's launch takes a changed budget (ADR 0047): Change budget
//   opens dollars and tokens fields from the proposal's budget, and Go (or Run on 1 first) sends
//   the changed budget as the answer's `launch`; a field that is not a budget sends nothing and
//   says why. Keep proposed closes the fields.
// - One answer in flight at a time. An answer the brain took is hidden at once and stays hidden
//   until the stream shows it settled, so a slow stream never shows it twice.
// - A request that leaves the card without this device answering it (another device, the parent,
//   a stop) closes with its settled line, keeps any words the user typed on it in the closed
//   notice, and hands them to the root (`CarriedTypedWords`), which puts them in the thread's
//   composer draft (t3code's `carryDisplacedCustomAnswerIntoPrompt`; look track L7), so nothing
//   typed is lost.

import {
  goBlockOf,
  modelQuestionOf,
  proposedBudgetOf,
  takesBudgetEdit,
  takesRunOnOne,
  takesSendBack,
} from "@cairn/client-logic/BriefGo";
import { budgetDraftOf, budgetEditOf } from "@cairn/client-logic/Meters";
import type { BudgetDraft } from "@cairn/client-logic/Meters";
import {
  answersProblem,
  approvalRecordsOf,
  pendingRequests,
  RequestBody,
  settledLineOf,
} from "@cairn/client-logic/PendingRequests";
import type { PendingRequest } from "@cairn/client-logic/PendingRequests";
import {
  buildAnswers,
  deriveProgress,
  draftKey,
  EMPTY_DRAFT,
  pruneResolvedDrafts,
  setCustomAnswer,
  toggleOption,
} from "@cairn/client-logic/PendingUserInput";
import type { DraftAnswers } from "@cairn/client-logic/PendingUserInput";
import { ApprovalId, ThreadId } from "@cairn/protocol/Ids";
import type {
  ApprovalRecord,
  Brief,
  Question,
  WorkflowLaunch,
} from "@cairn/protocol/Policy";
import { ApprovalDecision, LaunchEdits } from "@cairn/protocol/Policy";
import type { Budget } from "@cairn/protocol/Spend";
import {
  Array,
  Duration,
  Effect,
  Equal,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect";
import { Command, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { CairnConnection, withBoundary } from "../../connection/Connection.ts";
import type { CairnConnectionService } from "../../connection/Connection.ts";
import { callFailureText } from "../../connection/Failure.ts";
import { Message, OutMessage } from "./Message.ts";
import type { Decision } from "./Message.ts";
import { CardAnswer, initial, ModelCheckState } from "./Model.ts";
import type { CardContext, Model } from "./Model.ts";

/** The pause after a single pick before the card moves to the next question (t3code's). */
export const ADVANCE_MS = 200;

/** How long an answer to a question card can be taken back before it is sent. */
export const UNDO_MS = 3000;

type UpdateReturn = Update.Return<Model, Message, CairnConnectionService>;

/** What `inform` returns: the card, and the words to carry into the composer when a request closed. */
type InformReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  CairnConnectionService
>;

const NO_RECORDS: ReadonlyArray<ApprovalRecord> = [];

// Decoded records by the document object they came from: the thread's stream replaces a document
// only when it changes, so a streamed token decodes nothing.
const decoded = new WeakMap<object, ReadonlyArray<ApprovalRecord>>();

/** The decision records of a `cairn.approvals` document, oldest first; the same array while unchanged. */
export const recordsOf = (
  approvals: Schema.Json
): ReadonlyArray<ApprovalRecord> => {
  if (!Predicate.isObject(approvals)) {
    return NO_RECORDS;
  }

  const known = decoded.get(approvals);

  if (known !== undefined) {
    return known;
  }

  const records = approvalRecordsOf(approvals);

  decoded.set(approvals, records);

  return records;
};

/** The requests the card can show, in card order, numbered among themselves. */
export const visibleRequests = (
  model: Pick<Model, "approvals" | "answered">
): ReadonlyArray<PendingRequest> => {
  const open = pendingRequests(recordsOf(model.approvals)).filter(
    (request) => !model.answered.includes(request.record.id)
  );

  return open.map((request, index) => ({
    ...request,
    position: index + 1,
    total: open.length,
  }));
};

/** The request the card shows: the first one the user can answer. */
export const shownRequest = (
  model: Pick<Model, "approvals" | "answered">
): Option.Option<PendingRequest> =>
  Option.fromUndefinedOr(visibleRequests(model)[0]);

const NO_QUESTIONS: ReadonlyArray<Question> = [];

const questionsOfBody = (body: RequestBody): ReadonlyArray<Question> =>
  RequestBody.$match(body, {
    Question: ({ questions }) => questions,
    Approval: () => NO_QUESTIONS,
    Brief: () => NO_QUESTIONS,
    Criteria: () => NO_QUESTIONS,
  });

const requestById = (
  model: Model,
  approvalId: ApprovalId
): Option.Option<PendingRequest> =>
  Option.fromUndefinedOr(
    visibleRequests(model).find((request) => request.record.id === approvalId)
  );

/** A request's question drafts. */
export const draftsOf = (model: Model, approvalId: ApprovalId): DraftAnswers =>
  model.drafts[approvalId] ?? {};

/** The question a question card is on. */
export const questionIndexOf = (model: Model, approvalId: ApprovalId): number =>
  model.questionIndex[approvalId] ?? 0;

/** Whether the card takes an answer to `approvalId` now: none in flight, none waiting to send. */
export const isAnswerable = (model: Model, approvalId: ApprovalId): boolean =>
  Option.isNone(model.sending) &&
  !Option.exists(model.undo, (undo) => undo.approvalId === approvalId);

/**
 * Whether Go (and Run on 1 first) waits on the models a request names: not checked yet, being
 * checked, or checked with one that does not resolve. A request that names no model never waits; a
 * check that could not be made does not hold Go, since the brain checks the model again at Go.
 */
export const goHeld = (model: Model, request: PendingRequest): boolean => {
  if (Option.isNone(modelQuestionOf(request.record, request.body))) {
    return false;
  }

  const state: ModelCheckState | undefined =
    model.modelChecks[request.record.id];

  return state === undefined
    ? true
    : ModelCheckState.match(state, {
        Checking: () => true,
        Checked: ({ checks }) => Option.isSome(goBlockOf(checks)),
        Unchecked: () => false,
      });
};

/** The words the user typed on a request: its own-words answers, its Decline reason and its notes. */
const typedWords = (model: Model, approvalId: ApprovalId): string =>
  [
    ...Object.values(draftsOf(model, approvalId)).map((draft) => draft.custom),
    model.reasons[approvalId] ?? "",
    model.notes[approvalId] ?? "",
  ]
    .flatMap((words) => {
      const trimmed = words.trim();

      return trimmed.length === 0 ? [] : [trimmed];
    })
    .join("\n\n");

/** Asks the brain to settle one request. */
export const RespondToRequest = Command.define("RespondToRequest", {
  args: {
    threadId: ThreadId,
    approvalId: ApprovalId,
    decision: ApprovalDecision,
    reason: Schema.Option(Schema.String),
    answers: Schema.Option(Schema.Array(CardAnswer)),
    /** The budget the user set on a brief's or a launch's card, with Go (ADR 0047). */
    launch: Schema.Option(LaunchEdits),
  },
  messages: [Message.SucceededRespond, Message.FailedRespond],
  execute: (input) =>
    withBoundary(
      Effect.flatMap(CairnConnection.get, (client) =>
        client["thread.respond"](input)
      )
    ).pipe(
      Effect.match({
        onSuccess: () =>
          Message.SucceededRespond({ approvalId: input.approvalId }),
        onFailure: (failure) =>
          Message.FailedRespond({
            approvalId: input.approvalId,
            message: callFailureText(failure, {
              reconnecting:
                "Cairn is reconnecting. Answer again once it is back.",
              cutOff:
                "The connection dropped before Cairn answered. Answer again once it is back.",
              fallback: "The answer did not reach Cairn. Try again.",
            }),
          }),
      })
    ),
});

/** Asks the brain what the models a brief or a launch names resolve to now. */
export const CheckModels = Command.define("CheckModels", {
  args: {
    approvalId: ApprovalId,
    generation: Schema.Int,
    specs: Schema.Array(Schema.String),
  },
  messages: [Message.ReceivedModelChecks, Message.FailedModelChecks],
  execute: ({ approvalId, generation, specs }) =>
    withBoundary(
      Effect.flatMap(CairnConnection.get, (client) =>
        client["models.check"]({ specs })
      )
    ).pipe(
      Effect.match({
        onSuccess: (checks) =>
          Message.ReceivedModelChecks({ approvalId, generation, checks }),
        onFailure: (failure) =>
          Message.FailedModelChecks({
            approvalId,
            generation,
            message: callFailureText(failure, {
              reconnecting: "Cairn is reconnecting.",
              cutOff: "The connection dropped before Cairn answered.",
              fallback: "The models could not be checked.",
            }),
          }),
      })
    ),
});

/** Waits out the pause after a single pick. */
export const WaitToAdvance = Command.define("WaitToAdvance", {
  args: { approvalId: ApprovalId, index: Schema.Int, timer: Schema.Int },
  messages: [Message.ElapsedAdvance],
  // A later pick makes this pause stale (`timer`); keyed so a scene may leave it unresolved.
  interrupt: true,
  execute: (input) =>
    Effect.as(
      Effect.sleep(Duration.millis(ADVANCE_MS)),
      Message.ElapsedAdvance(input)
    ),
});

/** Waits out a question card's undo window. */
export const WaitToSend = Command.define("WaitToSend", {
  args: { approvalId: ApprovalId, timer: Schema.Int },
  messages: [Message.ElapsedUndo],
  // An Undo makes this wait stale (`timer`); keyed as `WaitToAdvance` is.
  interrupt: true,
  execute: (input) =>
    Effect.as(
      Effect.sleep(Duration.millis(UNDO_MS)),
      Message.ElapsedUndo(input)
    ),
});

interface Answer {
  readonly approvalId: ApprovalId;
  readonly decision: ApprovalDecision;
  readonly reason: Option.Option<string>;
  readonly answers: Option.Option<ReadonlyArray<CardAnswer>>;
  readonly launch: Option.Option<LaunchEdits>;
}

/**
 * Sends one answer, unless one is in flight or there is no thread. It closes the undo window only
 * when the window holds this request's answers: another request's waiting answers stay due.
 */
const respond = (model: Model, answer: Answer): UpdateReturn => {
  if (Option.isSome(model.sending)) {
    return { model };
  }

  return Option.match(model.threadId, {
    onNone: () => ({ model }),
    onSome: (threadId) =>
      model.hasClient
        ? {
            model: modifyFields(model, {
              sending: () => Option.some(answer.approvalId),
              sent: (sent) => ({
                ...sent,
                [answer.approvalId]: answer.decision,
              }),
              undo: (undo) =>
                Option.filter(
                  undo,
                  (pending) => pending.approvalId !== answer.approvalId
                ),
              failure: () => Option.none(),
            }),
            commands: [
              RespondToRequest({
                threadId,
                approvalId: answer.approvalId,
                decision: answer.decision,
                reason: answer.reason,
                answers: answer.answers,
                launch: answer.launch,
              }),
            ],
          }
        : {
            model: modifyFields(model, {
              failure: () =>
                Option.some(
                  "Cairn is reconnecting. Answer again once it is back."
                ),
            }),
          },
  });
};

/** Runs `step` on `result`'s model, keeping both commands. */
const andThen = (
  result: UpdateReturn,
  step: (model: Model) => UpdateReturn
): UpdateReturn => {
  const after = step(result.model);

  return {
    model: after.model,
    commands: Array.appendAll(result.commands ?? [], after.commands ?? []),
  };
};

/**
 * Sends the answers whose undo window ended, once nothing holds them: a client to send with and no
 * other answer in flight. Every transition that can lift a hold (an answer settling, the
 * connection coming back) ends here, so a due window never waits on a timer that already fired.
 */
const sendDue = (model: Model): UpdateReturn =>
  Option.match(
    Option.filter(
      model.undo,
      (undo) =>
        undo.state === "due" && model.hasClient && Option.isNone(model.sending)
    ),
    {
      onNone: () => ({ model }),
      onSome: (undo) =>
        respond(model, {
          approvalId: undo.approvalId,
          decision: "accept",
          reason: Option.none(),
          answers: Option.some(undo.answers),
          launch: Option.none(),
        }),
    }
  );

/** Opens the undo window over a question card's answers, when they are complete and fit. */
const startSend = (model: Model, approvalId: ApprovalId): UpdateReturn =>
  Option.match(requestById(model, approvalId), {
    onNone: () => ({ model }),
    onSome: (request) => {
      const questions = questionsOfBody(request.body);

      return Option.match(
        buildAnswers(questions, draftsOf(model, approvalId)),
        {
          onNone: () => ({ model }),
          onSome: (answers) =>
            Option.match(answersProblem(questions, answers), {
              onSome: (problem) => ({
                model: modifyFields(model, {
                  failure: () => Option.some(`Not sent: ${problem}.`),
                }),
              }),
              onNone: () => {
                const timer = model.timer + 1;

                return {
                  model: modifyFields(model, {
                    timer: () => timer,
                    undo: () =>
                      Option.some({
                        approvalId,
                        answers,
                        timer,
                        state: "waiting" as const,
                      }),
                    failure: () => Option.none(),
                  }),
                  commands: [WaitToSend({ approvalId, timer })],
                };
              },
            }),
        }
      );
    },
  });

/** Moves past the question the card is on, or opens the undo window after the last one. */
const advance = (model: Model, approvalId: ApprovalId): UpdateReturn =>
  Option.match(requestById(model, approvalId), {
    onNone: () => ({ model }),
    onSome: (request) => {
      const questions = questionsOfBody(request.body);

      const progress = deriveProgress(
        questions,
        draftsOf(model, approvalId),
        questionIndexOf(model, approvalId)
      );

      if (!progress.canAdvance) {
        return { model };
      }

      if (progress.isLastQuestion) {
        return progress.isComplete ? startSend(model, approvalId) : { model };
      }

      return {
        model: modifyFields(model, {
          timer: (timer) => timer + 1,
          questionIndex: (indexes) => ({
            ...indexes,
            [approvalId]: progress.questionIndex + 1,
          }),
        }),
      };
    },
  });

const withDraft = (
  model: Model,
  approvalId: ApprovalId,
  index: number,
  change: (question: Question, drafts: DraftAnswers) => DraftAnswers
): Option.Option<{ readonly model: Model; readonly question: Question }> =>
  Option.flatMap(requestById(model, approvalId), (request) =>
    Option.map(
      Option.fromUndefinedOr(questionsOfBody(request.body)[index]),
      (question) => ({
        question,
        model: modifyFields(model, {
          drafts: (drafts) => ({
            ...drafts,
            [approvalId]: change(question, draftsOf(model, approvalId)),
          }),
          failure: () => Option.none(),
        }),
      })
    )
  );

const pick = (
  model: Model,
  approvalId: ApprovalId,
  index: number,
  label: string
): UpdateReturn => {
  if (
    !isAnswerable(model, approvalId) ||
    questionIndexOf(model, approvalId) !== index
  ) {
    return { model };
  }

  return Option.match(
    withDraft(model, approvalId, index, (question, drafts) => ({
      ...drafts,
      [draftKey(index)]: toggleOption(
        question,
        drafts[draftKey(index)] ?? EMPTY_DRAFT,
        label
      ),
    })),
    {
      onNone: () => ({ model }),
      onSome: ({ model: picked, question }) => {
        if (question.multiSelect) {
          return { model: picked };
        }

        const timer = picked.timer + 1;

        return {
          model: modifyFields(picked, { timer: () => timer }),
          commands: [WaitToAdvance({ approvalId, index, timer })],
        };
      },
    }
  );
};

/** Asks `models.check` about the models one request names, superseding any check still out for it. */
const askModels = (model: Model, request: PendingRequest): UpdateReturn =>
  Option.match(modelQuestionOf(request.record, request.body), {
    onNone: () => ({ model }),
    onSome: (question) => {
      const generation = model.checkGeneration + 1;
      const approvalId = request.record.id;

      return {
        model: modifyFields(model, {
          checkGeneration: () => generation,
          modelChecks: (checks) => ({
            ...checks,
            [approvalId]: ModelCheckState.Checking({ generation }),
          }),
        }),
        commands: [
          CheckModels({
            approvalId,
            generation,
            specs: question.specs,
          }),
        ],
      };
    },
  });

/**
 * Asks about the shown request's models when nothing was asked for it yet, or `again` (the
 * connection came back): only while there is a client, so a check asked offline is asked on
 * reconnecting instead.
 */
const checkShown = (result: UpdateReturn, again: boolean): UpdateReturn => {
  const { model } = result;

  return Option.match(
    Option.filter(
      shownRequest(model),
      (request) =>
        model.hasClient &&
        (again || model.modelChecks[request.record.id] === undefined)
    ),
    {
      onNone: () => result,
      onSome: (request) => {
        const asked = askModels(model, request);

        return {
          model: asked.model,
          commands: Array.appendAll(
            result.commands ?? [],
            asked.commands ?? []
          ),
        };
      },
    }
  );
};

/** Takes `models.check`'s answer (or why there is none) for the check still out, if it is that one. */
const settleCheck = (
  model: Model,
  approvalId: ApprovalId,
  generation: number,
  settled: ModelCheckState
): UpdateReturn => {
  const state = model.modelChecks[approvalId];

  const isOut =
    state !== undefined &&
    ModelCheckState.guards.Checking(state) &&
    state.generation === generation;

  return isOut
    ? {
        model: modifyFields(model, {
          modelChecks: (checks) => ({ ...checks, [approvalId]: settled }),
        }),
      }
    : { model };
};

/** A brief's or a launch's payload; none for any other body. */
const briefPayloadOf = (
  body: RequestBody
): Option.Option<Brief | WorkflowLaunch> =>
  RequestBody.$is("Brief")(body) ? Option.some(body.payload) : Option.none();

/**
 * What the budget field of `request` says Go sends: none when it has no field, the field is closed
 * or says what was proposed; the changed budget; or why the field is not a budget (ADR 0047).
 */
export const budgetEdit = (
  model: Pick<Model, "budgets">,
  request: PendingRequest
): Result.Result<Option.Option<Budget>, string> =>
  Option.match(
    Option.filter(briefPayloadOf(request.body), () =>
      takesBudgetEdit(request.record, request.body)
    ),
    {
      onNone: () => Result.succeed(Option.none()),
      onSome: (payload) =>
        budgetEditOf(
          proposedBudgetOf(payload),
          Option.fromUndefinedOr(model.budgets[request.record.id])
        ),
    }
  );

/**
 * Go, Run on 1 first, Approve or Allow for this thread, when the shown request takes it now. Go
 * carries the budget field's budget when it changed; a field that is not a budget sends nothing
 * and says why.
 */
const accept = (
  model: Model,
  approvalId: ApprovalId,
  decision: Decision
): UpdateReturn =>
  Option.match(requestById(model, approvalId), {
    onNone: () => ({ model }),
    onSome: (request) => {
      if (
        (request.record.kind === "brief" && goHeld(model, request)) ||
        (decision === "accept_sample" && !takesRunOnOne(request.body))
      ) {
        return { model };
      }

      const edit = budgetEdit(model, request);

      if (Result.isFailure(edit)) {
        return {
          model: modifyFields(model, {
            failure: () => Option.some(`Not sent: ${edit.failure}`),
          }),
        };
      }

      return respond(model, {
        approvalId,
        decision,
        reason: Option.none(),
        answers: Option.none(),
        launch: Option.map(edit.success, (budget) => ({ budget })),
      });
    },
  });

/** Changes one field of a request's open budget field. */
const typeBudget = (
  model: Model,
  approvalId: ApprovalId,
  change: (draft: BudgetDraft) => BudgetDraft
): UpdateReturn => {
  const draft = model.budgets[approvalId];

  return draft === undefined || !isAnswerable(model, approvalId)
    ? { model }
    : {
        model: modifyFields(model, {
          budgets: (budgets) => ({ ...budgets, [approvalId]: change(draft) }),
          failure: () => Option.none(),
        }),
      };
};

/** Sends a brief back with the notes typed; refuses without notes, as the brain does. */
const sendBack = (model: Model, approvalId: ApprovalId): UpdateReturn => {
  const notes = (model.notes[approvalId] ?? "").trim();

  if (notes === "") {
    return {
      model: modifyFields(model, {
        failure: () =>
          Option.some("Say what should change before sending it back."),
      }),
    };
  }

  return respond(model, {
    approvalId,
    decision: "revise",
    reason: Option.some(notes),
    answers: Option.none(),
    launch: Option.none(),
  });
};

/** The card's update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    PickedOption: ({ approvalId, index, label }) =>
      pick(model, approvalId, index, label),
    ChangedCustom: ({ approvalId, index, value }) =>
      isAnswerable(model, approvalId)
        ? {
            model: Option.match(
              withDraft(model, approvalId, index, (question, drafts) => ({
                ...drafts,
                [draftKey(index)]: setCustomAnswer(
                  question,
                  drafts[draftKey(index)] ?? EMPTY_DRAFT,
                  value
                ),
              })),
              {
                onNone: () => model,
                onSome: (changed) =>
                  modifyFields(changed.model, { timer: (timer) => timer + 1 }),
              }
            ),
          }
        : { model },
    ElapsedAdvance: ({ approvalId, index, timer }) =>
      timer === model.timer &&
      questionIndexOf(model, approvalId) === index &&
      isAnswerable(model, approvalId)
        ? advance(model, approvalId)
        : { model },
    ClickedNext: ({ approvalId }) =>
      isAnswerable(model, approvalId) ? advance(model, approvalId) : { model },
    ClickedBack: ({ approvalId }) => ({
      model: modifyFields(model, {
        timer: (timer) => timer + 1,
        questionIndex: (indexes) => ({
          ...indexes,
          [approvalId]: Math.max(0, questionIndexOf(model, approvalId) - 1),
        }),
      }),
    }),
    ClickedSend: ({ approvalId }) =>
      isAnswerable(model, approvalId)
        ? startSend(model, approvalId)
        : { model },
    ClickedUndo: () => ({
      model: modifyFields(model, {
        undo: () => Option.none(),
        timer: (timer) => timer + 1,
      }),
    }),
    ElapsedUndo: ({ approvalId, timer }) =>
      Option.exists(
        model.undo,
        (undo) => undo.approvalId === approvalId && undo.timer === timer
      )
        ? sendDue(
            modifyFields(model, {
              undo: (undo) =>
                Option.map(undo, (pending) => ({
                  ...pending,
                  state: "due" as const,
                })),
            })
          )
        : { model },
    ClickedAccept: ({ approvalId, decision }) =>
      accept(model, approvalId, decision),
    ClickedDecline: ({ approvalId }) =>
      isAnswerable(model, approvalId)
        ? {
            model: modifyFields(model, {
              declining: () => Option.some(approvalId),
              sendingBack: () => Option.none(),
            }),
          }
        : { model },
    ClickedSendBack: ({ approvalId }) =>
      isAnswerable(model, approvalId) &&
      Option.exists(requestById(model, approvalId), (request) =>
        takesSendBack(request.record, request.body)
      )
        ? {
            model: modifyFields(model, {
              sendingBack: () => Option.some(approvalId),
              declining: () => Option.none(),
            }),
          }
        : { model },
    ChangedNotes: ({ approvalId, value }) => ({
      model: modifyFields(model, {
        notes: (notes) => ({ ...notes, [approvalId]: value }),
        failure: () => Option.none(),
      }),
    }),
    ClickedCancelSendBack: () => ({
      model: modifyFields(model, {
        sendingBack: () => Option.none(),
        failure: () => Option.none(),
      }),
    }),
    ClickedConfirmSendBack: ({ approvalId }) => sendBack(model, approvalId),
    ClickedChangeBudget: ({ approvalId }) =>
      Option.match(
        Option.flatMap(
          Option.filter(
            requestById(model, approvalId),
            (request) =>
              isAnswerable(model, approvalId) &&
              model.budgets[approvalId] === undefined &&
              takesBudgetEdit(request.record, request.body)
          ),
          (request) => briefPayloadOf(request.body)
        ),
        {
          onNone: () => ({ model }),
          onSome: (payload) => ({
            model: modifyFields(model, {
              budgets: (budgets) => ({
                ...budgets,
                [approvalId]: budgetDraftOf(proposedBudgetOf(payload)),
              }),
            }),
          }),
        }
      ),
    ChangedBudgetDollars: ({ approvalId, value }) =>
      typeBudget(model, approvalId, (draft) => ({ ...draft, dollars: value })),
    ChangedBudgetTokens: ({ approvalId, value }) =>
      typeBudget(model, approvalId, (draft) => ({ ...draft, tokens: value })),
    ClickedKeepBudget: ({ approvalId }) => ({
      model: modifyFields(model, {
        budgets: (budgets) =>
          Object.fromEntries(
            Object.entries(budgets).filter(([id]) => id !== approvalId)
          ),
        failure: () => Option.none(),
      }),
    }),
    ClickedCheckModels: ({ approvalId }) =>
      Option.match(requestById(model, approvalId), {
        onNone: () => ({ model }),
        onSome: (request) => askModels(model, request),
      }),
    ReceivedModelChecks: ({ approvalId, generation, checks }) =>
      settleCheck(
        model,
        approvalId,
        generation,
        ModelCheckState.Checked({ checks })
      ),
    FailedModelChecks: ({ approvalId, generation, message: text }) =>
      settleCheck(
        model,
        approvalId,
        generation,
        ModelCheckState.Unchecked({ message: text })
      ),
    ChangedReason: ({ approvalId, value }) => ({
      model: modifyFields(model, {
        reasons: (reasons) => ({ ...reasons, [approvalId]: value }),
      }),
    }),
    ClickedCancelDecline: () => ({
      model: modifyFields(model, { declining: () => Option.none() }),
    }),
    ClickedConfirmDecline: ({ approvalId }) => {
      const reason = (model.reasons[approvalId] ?? "").trim();

      return respond(model, {
        approvalId,
        decision: "decline",
        reason: reason === "" ? Option.none() : Option.some(reason),
        answers: Option.none(),
        launch: Option.none(),
      });
    },
    // An answer settles only the request in flight: one for a request the card let go of (another
    // thread opened meanwhile) is the stream's to show.
    SucceededRespond: ({ approvalId }) => {
      if (!Option.contains(model.sending, approvalId)) {
        return { model };
      }

      const stillPending = recordsOf(model.approvals).some(
        (record) => record.id === approvalId && record.status === "pending"
      );

      // The next request shows now, so its models are asked about now; answers due go now.
      return andThen(
        checkShown(
          {
            model: modifyFields(model, {
              sending: () => Option.none(),
              declining: (declining) =>
                Option.filter(declining, (id) => id !== approvalId),
              sendingBack: (sendingBack) =>
                Option.filter(sendingBack, (id) => id !== approvalId),
              answered: (answered) =>
                stillPending && !answered.includes(approvalId)
                  ? [...answered, approvalId]
                  : answered,
              shown: () =>
                Option.map(
                  shownRequest({
                    approvals: model.approvals,
                    answered: stillPending
                      ? [...model.answered, approvalId]
                      : model.answered,
                  }),
                  (request) => request.record.id
                ),
            }),
          },
          false
        ),
        sendDue
      );
    },
    FailedRespond: ({ approvalId, message: text }) =>
      Option.contains(model.sending, approvalId)
        ? andThen(
            sendDue(modifyFields(model, { sending: () => Option.none() })),
            (sent) => ({
              model: modifyFields(sent, { failure: () => Option.some(text) }),
            })
          )
        : { model },
    DismissedClosed: () => ({
      model: modifyFields(model, { closed: () => Option.none() }),
    }),
  });

const sameThreadId = Option.makeEquivalence<ThreadId>(Equal.equals);

/** Whether `context` is what the card already holds. */
export const sameContext = (model: Model, context: CardContext): boolean =>
  model.approvals === context.approvals &&
  model.hasClient === context.hasClient &&
  sameThreadId(model.threadId, context.threadId);

/**
 * Takes the open thread's records. Another thread starts the card over. Drafts, reasons, notes,
 * model checks and question places of requests no longer pending are dropped; a request that left
 * the card without this device answering it closes with its settled line and the words typed on
 * it. The shown request's models are asked about when it first shows and again when the connection
 * comes back, since the table or a model's readiness may have changed meanwhile (a brain restart).
 */
export const inform = (model: Model, context: CardContext): InformReturn => {
  const sameThread = sameThreadId(model.threadId, context.threadId);

  // The check generation and the timer carry over, so an answer to another thread's check is never
  // taken, and a pause or an undo window's wait from before the switch, which keeps running, never
  // ends a later one.
  const base = sameThread
    ? model
    : {
        ...initial,
        checkGeneration: model.checkGeneration,
        timer: model.timer,
      };

  const reconnected = sameThread && !model.hasClient && context.hasClient;

  const records = recordsOf(context.approvals);

  const pendingIds = records
    .filter((record) => record.status === "pending")
    .map((record) => record.id);

  const isPending = (id: ApprovalId) => pendingIds.includes(id);

  // A request the card showed or this device answered, now settled by someone else: not by this
  // device, by this device's answer losing to another device's different one, or with no answer
  // at all (stopped or expired).
  const candidates = new Set<string>([
    ...Option.toArray(base.shown),
    ...base.answered,
    ...Option.toArray(base.sending),
  ]);

  const settledElsewhere = Option.fromUndefinedOr(
    records.find(
      (record) =>
        sameThread &&
        candidates.has(record.id) &&
        record.status !== "pending" &&
        (record.answer === null ||
          base.sent[record.id] !== record.answer.decision)
    )
  );

  const closed = Option.match(settledElsewhere, {
    onNone: () => base.closed,
    onSome: (record) =>
      Option.map(settledLineOf(record), (line) => ({
        approvalId: record.id,
        text: line.text,
        typed: typedWords(base, record.id),
      })),
  });

  const answered = base.answered.filter(isPending);

  const next: Model = modifyFields(base, {
    threadId: () => context.threadId,
    hasClient: () => context.hasClient,
    approvals: () => context.approvals,
    drafts: (drafts) => pruneResolvedDrafts(drafts, pendingIds),
    questionIndex: (indexes) => pruneResolvedDrafts(indexes, pendingIds),
    reasons: (reasons) => pruneResolvedDrafts(reasons, pendingIds),
    sent: (sent) =>
      pruneResolvedDrafts(sent, [
        ...pendingIds,
        ...Option.toArray(base.sending),
      ]),
    notes: (notes) => pruneResolvedDrafts(notes, pendingIds),
    budgets: (budgets) => pruneResolvedDrafts(budgets, pendingIds),
    modelChecks: (checks) => pruneResolvedDrafts(checks, pendingIds),
    declining: (declining) => Option.filter(declining, isPending),
    sendingBack: (sendingBack) => Option.filter(sendingBack, isPending),
    undo: (undo) => Option.filter(undo, (found) => isPending(found.approvalId)),
    answered: () => answered,
    shown: () =>
      Option.map(
        shownRequest({ approvals: context.approvals, answered }),
        (request) => request.record.id
      ),
    closed: () => closed,
  });

  // The words typed on a request that just closed go back into the thread's composer draft.
  const carried = Option.flatMap(
    Option.filter(
      Option.filter(closed, (found) => found.typed !== ""),
      (found) =>
        !Option.exists(
          base.closed,
          (before) => before.approvalId === found.approvalId
        )
    ),
    (found) =>
      Option.map(context.threadId, (threadId) =>
        OutMessage.CarriedTypedWords({ threadId, text: found.typed })
      )
  );

  // Answers whose window ended while Cairn was reconnecting go once it is back.
  return Update.withOutMessage(
    andThen(checkShown({ model: next }, reconnected), sendDue),
    Option.getOrUndefined(carried)
  );
};

/** The card's update and its root hooks. */
export const requestCard = { update, inform, sameContext } as const;
