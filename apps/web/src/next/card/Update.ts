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
//   them.
// - Approve, Allow for this thread and Go answer at once; Decline (on every body, a question's
//   too) opens a reason field first, and the reason (when there is one) reaches the model.
// - A brief or a workflow's launch (6B, `BriefGo.ts`): the roles it names are checked with
//   `roles.check` when it shows, again when the connection comes back (a brain restart) and on
//   Check again. Go and Run on 1 first are held while the check is out and blocked while a role
//   does not resolve; a check that could not be made holds nothing, since the brain resolves again
//   at Go. Send back (a subagent's brief only) opens a notes field and needs notes; Run on 1 first
//   (a launch of more than one node only) answers `accept_sample`.
// - One answer in flight at a time. An answer the brain took is hidden at once and stays hidden
//   until the stream shows it settled, so a slow stream never shows it twice.
// - A request that leaves the card without this device answering it (another device, the parent,
//   a stop) closes with its settled line, and keeps any words the user typed on it in the closed
//   notice, so nothing typed is lost. (t3code carries them into the composer's draft,
//   `carryDisplacedCustomAnswerIntoPrompt`; that needs a composer capability the composer's owner
//   adds.)

import {
  goBlockOf,
  roleQuestionOf,
  takesRunOnOne,
  takesSendBack,
} from "@cairn/client-logic/BriefGo";
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
import type { ApprovalRecord, Question } from "@cairn/protocol/Policy";
import { ApprovalDecision } from "@cairn/protocol/Policy";
import { RoleOverrides } from "@cairn/protocol/Roles";
import {
  Array,
  Cause,
  Duration,
  Effect,
  Equal,
  Option,
  Predicate,
  Schema,
} from "effect";
import { Command } from "foldkit";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { CairnConnection } from "../../connection/Connection.ts";
import type { CairnConnectionService } from "../../connection/Connection.ts";
import { failureMessage } from "../../connection/Failure.ts";
import { Message } from "./Message.ts";
import type { Decision } from "./Message.ts";
import { CardAnswer, initial, RoleCheckState } from "./Model.ts";
import type { CardContext, Model } from "./Model.ts";

/** The pause after a single pick before the card moves to the next question (t3code's). */
export const ADVANCE_MS = 200;

/** How long an answer to a question card can be taken back before it is sent. */
export const UNDO_MS = 3000;

type UpdateReturn = Update.Return<Model, Message, CairnConnectionService>;

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
 * Whether Go (and Run on 1 first) waits on a request's roles: not checked yet, being checked, or
 * checked with one that does not resolve. A request that names no role never waits; a check that
 * could not be made does not hold Go, since the brain resolves the role again at Go.
 */
export const goHeld = (model: Model, request: PendingRequest): boolean => {
  if (Option.isNone(roleQuestionOf(request.body))) {
    return false;
  }

  const state: RoleCheckState | undefined = model.roleChecks[request.record.id];

  return state === undefined
    ? true
    : RoleCheckState.match(state, {
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

/**
 * Answers `message` when the call was cut off: a connection dropped while a call was out releases
 * its client, which interrupts the call, and an interrupted Command would end the page (seen when
 * the brain restarts while a call is out, 6B's `brief-go`). Only interruption is caught; a defect
 * still surfaces.
 */
const whenCutOff =
  <B>(message: B) =>
  <A, R>(call: Effect.Effect<A, never, R>): Effect.Effect<A | B, never, R> =>
    Effect.catchCauseIf(call, Cause.hasInterruptsOnly, () =>
      Effect.succeed(message)
    );

/** Asks the brain to settle one request. */
export const RespondToRequest = Command.define("RespondToRequest", {
  args: {
    threadId: ThreadId,
    approvalId: ApprovalId,
    decision: ApprovalDecision,
    reason: Schema.Option(Schema.String),
    answers: Schema.Option(Schema.Array(CardAnswer)),
  },
  messages: [Message.SucceededRespond, Message.FailedRespond],
  execute: (input) =>
    CairnConnection.get.pipe(
      Effect.flatMap((client) =>
        client["thread.respond"]({ ...input, launch: Option.none() }).pipe(
          Effect.match({
            onSuccess: () =>
              Message.SucceededRespond({ approvalId: input.approvalId }),
            onFailure: (failure) =>
              Message.FailedRespond({
                approvalId: input.approvalId,
                message: failureMessage(
                  failure,
                  "The answer did not reach Cairn. Try again."
                ),
              }),
          })
        )
      ),
      Effect.catchTag("ResourceNotAvailable", () =>
        Effect.succeed(
          Message.FailedRespond({
            approvalId: input.approvalId,
            message: "Cairn is reconnecting. Answer again once it is back.",
          })
        )
      ),
      whenCutOff(
        Message.FailedRespond({
          approvalId: input.approvalId,
          message:
            "The connection dropped before Cairn answered. Answer again once it is back.",
        })
      )
    ),
});

/** Asks the brain what a brief's or a launch's roles resolve to now. */
export const CheckRoles = Command.define("CheckRoles", {
  args: {
    approvalId: ApprovalId,
    generation: Schema.Int,
    specs: Schema.Array(Schema.String),
    overrides: Schema.Option(RoleOverrides),
  },
  messages: [Message.ReceivedRoleChecks, Message.FailedRoleChecks],
  execute: ({ approvalId, generation, specs, overrides }) =>
    CairnConnection.get.pipe(
      Effect.flatMap((client) =>
        client["roles.check"](
          Option.match(overrides, {
            onNone: () => ({ specs }),
            onSome: (given) => ({ specs, overrides: given }),
          })
        ).pipe(
          Effect.match({
            onSuccess: (checks) =>
              Message.ReceivedRoleChecks({ approvalId, generation, checks }),
            onFailure: (failure) =>
              Message.FailedRoleChecks({
                approvalId,
                generation,
                message: failureMessage(
                  failure,
                  "The roles could not be checked."
                ),
              }),
          })
        )
      ),
      Effect.catchTag("ResourceNotAvailable", () =>
        Effect.succeed(
          Message.FailedRoleChecks({
            approvalId,
            generation,
            message: "Cairn is reconnecting.",
          })
        )
      ),
      whenCutOff(
        Message.FailedRoleChecks({
          approvalId,
          generation,
          message: "The connection dropped before Cairn answered.",
        })
      )
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
}

/** Sends one answer, unless one is in flight or there is no thread. */
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
              undo: () => Option.none(),
              failure: () => Option.none(),
            }),
            commands: [
              RespondToRequest({
                threadId,
                approvalId: answer.approvalId,
                decision: answer.decision,
                reason: answer.reason,
                answers: answer.answers,
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
                    undo: () => Option.some({ approvalId, answers, timer }),
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

/** Asks `roles.check` about one request's roles, superseding any check still out for it. */
const askRoles = (model: Model, request: PendingRequest): UpdateReturn =>
  Option.match(roleQuestionOf(request.body), {
    onNone: () => ({ model }),
    onSome: (question) => {
      const generation = model.checkGeneration + 1;
      const approvalId = request.record.id;

      return {
        model: modifyFields(model, {
          checkGeneration: () => generation,
          roleChecks: (checks) => ({
            ...checks,
            [approvalId]: RoleCheckState.Checking({ generation }),
          }),
        }),
        commands: [
          CheckRoles({
            approvalId,
            generation,
            specs: question.specs,
            overrides: question.overrides,
          }),
        ],
      };
    },
  });

/**
 * Asks about the shown request's roles when nothing was asked for it yet, or `again` (the
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
        (again || model.roleChecks[request.record.id] === undefined)
    ),
    {
      onNone: () => result,
      onSome: (request) => {
        const asked = askRoles(model, request);

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

/** Takes `roles.check`'s answer (or why there is none) for the check still out, if it is that one. */
const settleCheck = (
  model: Model,
  approvalId: ApprovalId,
  generation: number,
  settled: RoleCheckState
): UpdateReturn => {
  const state = model.roleChecks[approvalId];

  const isOut =
    state !== undefined &&
    RoleCheckState.guards.Checking(state) &&
    state.generation === generation;

  return isOut
    ? {
        model: modifyFields(model, {
          roleChecks: (checks) => ({ ...checks, [approvalId]: settled }),
        }),
      }
    : { model };
};

/** Go, Run on 1 first, Approve or Allow for this thread, when the shown request takes it now. */
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

      return respond(model, {
        approvalId,
        decision,
        reason: Option.none(),
        answers: Option.none(),
      });
    },
  });

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
      Option.match(
        Option.filter(
          model.undo,
          (undo) => undo.approvalId === approvalId && undo.timer === timer
        ),
        {
          onNone: () => ({ model }),
          onSome: (undo) =>
            respond(model, {
              approvalId,
              decision: "accept",
              reason: Option.none(),
              answers: Option.some(undo.answers),
            }),
        }
      ),
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
    ClickedCheckRoles: ({ approvalId }) =>
      Option.match(requestById(model, approvalId), {
        onNone: () => ({ model }),
        onSome: (request) => askRoles(model, request),
      }),
    ReceivedRoleChecks: ({ approvalId, generation, checks }) =>
      settleCheck(
        model,
        approvalId,
        generation,
        RoleCheckState.Checked({ checks })
      ),
    FailedRoleChecks: ({ approvalId, generation, message: text }) =>
      settleCheck(
        model,
        approvalId,
        generation,
        RoleCheckState.Unchecked({ message: text })
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
      });
    },
    SucceededRespond: ({ approvalId }) => {
      const stillPending = recordsOf(model.approvals).some(
        (record) => record.id === approvalId && record.status === "pending"
      );

      // The next request shows now, so its roles are asked about now.
      return checkShown(
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
      );
    },
    FailedRespond: ({ message: text }) => ({
      model: modifyFields(model, {
        sending: () => Option.none(),
        failure: () => Option.some(text),
      }),
    }),
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
 * role checks and question places of requests no longer pending are dropped; a request that left
 * the card without this device answering it closes with its settled line and the words typed on
 * it. The shown request's roles are asked about when it first shows and again when the connection
 * comes back, since the table or a model's readiness may have changed meanwhile (a brain restart).
 */
export const inform = (model: Model, context: CardContext): UpdateReturn => {
  const sameThread = sameThreadId(model.threadId, context.threadId);

  // The check generation carries over, so an answer to another thread's check is never taken.
  const base = sameThread
    ? model
    : { ...initial, checkGeneration: model.checkGeneration };

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
    roleChecks: (checks) => pruneResolvedDrafts(checks, pendingIds),
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

  return checkShown({ model: next }, reconnected);
};

/** The card's update and its root hooks, as the `next` chunk hands them to the root. */
export const requestCard = { update, inform, sameContext } as const;

/** The card's update and root hooks. */
export type RequestCardModule = typeof requestCard;
