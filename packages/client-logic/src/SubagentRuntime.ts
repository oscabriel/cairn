// Subagent rows (plan 6C; surfaces note S4): what a parent's transcript shows of each child it
// spawned, read from what the parent's view holds (its `subagent_spawn` calls, its `cairn.approvals`
// briefs, its `cairn.subagents` registry and the settlement notes) and, once Go started the child,
// from the child's own shell row through the one thread-state function (`ThreadState.ts`). Pure, so
// the transcript, the phone and the judges read a child alike.
//
// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/subagentRuntime.ts
// (`isTerminalSubagentStatus`, `isActiveSubagentStatus`, the plain subagent's title of
// `projectedSubagentsToRuntime`), packages/client-runtime/src/state/subagentDisplay.ts
// (`subagentGroupSummary`, `summarizeSubagentStatuses`, `formatSubagentDisplayTitle`,
// `subagentDetailPreview`), apps/web/src/components/chat/MessagesTimeline.tsx
// (`subagentGroupTiming`, the "Subagent of" divider's parent) and the status words of
// apps/web/src/components/chat/V2LifecycleRow.tsx (`STATUS_VISUALS`) at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: a terminal set and an active set of states, a
// group that is live while any member is, never reads a failure as success and dims once nothing in
// it works, the status tally in a fixed order ("1 working · 2 done"), a title without its
// "Subagent:" prefix and a long prompt cut to 80 characters, a settled row previewing its result and
// a live one its progress, and a group's span from its first start to its last end. Changed: the
// states are Cairn's: a brief waiting for Go and a brief that never started come before any child,
// and a started child reads its live state from its own shell row (approval, input, a question to
// its parent, working, waiting on its own children, parked, limited, failed) and, at rest, how its
// latest settlement ended. A spawn call is linked to its brief by the brief's summary, which is the
// call's `description`, newest first, since older calls may not be loaded yet. Not ported: workflow
// coordinators and members (5E's `WorkflowSteps.ts`), provider avatars, model labels, workspaces,
// usage and the ticking elapsed time.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { ThreadId } from "@cairn/protocol/Ids";
import type { ApprovalRecord } from "@cairn/protocol/Policy";
import { APPROVALS_DOCUMENT } from "@cairn/protocol/Policy";
import type { ThreadShell } from "@cairn/protocol/Shell";
import {
  BRIEF_ANSWER_ENTRY,
  CHILD_DOCUMENT,
  SettlementOutcome,
  SUBAGENT_RESULT_ENTRY,
  SUBAGENTS_DOCUMENT,
  SubagentStatus,
} from "@cairn/protocol/Subagents";
import type { Entry } from "@cairn/protocol/Thread";
import { Option, Predicate, Schema } from "effect";

import { approvalRecordsOf } from "./PendingRequests.ts";
import type { SubagentRequest } from "./SubagentRollup.ts";
import type {
  ThreadStateRow,
  ThreadStatus,
  ThreadTone,
} from "./ThreadState.ts";
import { THREAD_LABELS, threadStatus } from "./ThreadState.ts";

/** The tool a parent proposes a subagent with. */
export const SPAWN_TOOL = "subagent_spawn";

/**
 * Where one child stands, as its row shows it. Before any child: `go` while its brief waits for
 * Go, `declined`, `expired` or `cancelled` once the brief ended without one, and `unstarted` once
 * Go's start told the parent it started nothing (a role, budget, workspace or brain room refused
 * it). A started child's live
 * states come from its own row (`threadStatus`); at rest, from its latest settlement: `done`,
 * `failed` or `stopped`.
 */
export type SubagentState =
  | "go"
  | "declined"
  | "expired"
  | "cancelled"
  | "unstarted"
  | "approval"
  | "input"
  | "asking-parent"
  | "working"
  | "waiting"
  | "parked"
  | "limited"
  | "done"
  | "failed"
  | "stopped";

/** A state's words and tone, in the thread labels' vocabulary. */
export interface SubagentLabel {
  readonly word: string;
  readonly tone: ThreadTone;
}

/** Every state's words and tone; a started child's live states say what its own row says. */
export const SUBAGENT_LABELS: Readonly<Record<SubagentState, SubagentLabel>> = {
  go: { word: "Waiting for Go", tone: "attention" },
  declined: { word: "Declined", tone: "muted" },
  expired: { word: "Expired", tone: "muted" },
  cancelled: { word: "Cancelled", tone: "muted" },
  unstarted: { word: "Not started", tone: "error" },
  approval: THREAD_LABELS.approval,
  input: THREAD_LABELS.input,
  "asking-parent": THREAD_LABELS["asking-parent"],
  working: THREAD_LABELS.working,
  waiting: THREAD_LABELS.waiting,
  parked: THREAD_LABELS.parked,
  limited: THREAD_LABELS.limited,
  done: THREAD_LABELS.done,
  failed: THREAD_LABELS.failed,
  stopped: { word: "Stopped", tone: "muted" },
};

const TERMINAL: ReadonlySet<SubagentState> = new Set<SubagentState>([
  "declined",
  "expired",
  "cancelled",
  "unstarted",
  "done",
  "failed",
  "stopped",
]);

/** True once nothing more happens to the row unless someone sends the child more. */
export const isTerminalSubagentState = (state: SubagentState): boolean =>
  TERMINAL.has(state);

/** True while the row is live: a brief waiting, a child working, asking or held. */
export const isActiveSubagentState = (state: SubagentState): boolean =>
  !TERMINAL.has(state);

// ---------------------------------------------------------------------------------------------
// Display

/** A child's title: its description without a "Subagent:" prefix, a long one cut to 80 characters. */
export const formatSubagentDisplayTitle = (title: string): string => {
  const displayTitle = title.replace(/^Subagent:\s*/iu, "").trim();

  if (displayTitle === "") {
    return "Subagent";
  }

  return displayTitle.length > 80
    ? `${displayTitle.slice(0, 77)}...`
    : displayTitle;
};

/**
 * The line under a row's title: a settled child's result before its progress, a live one's
 * progress before its result, on one line and at most 280 characters.
 */
export const subagentDetailPreview = (input: {
  readonly state: SubagentState;
  readonly result: Option.Option<string>;
  readonly progress: Option.Option<string>;
}): Option.Option<string> => {
  const result = Option.filter(
    Option.map(input.result, (text) => text.trim()),
    (text) => text !== ""
  );

  const progress = Option.filter(
    Option.map(input.progress, (text) => text.trim()),
    (text) => text !== ""
  );

  const detail = isTerminalSubagentState(input.state)
    ? Option.orElse(result, () => progress)
    : Option.orElse(progress, () => result);

  return Option.map(detail, (text) => {
    const compact = text.replaceAll(/\s+/gu, " ");

    return compact.length > 280
      ? `${compact.slice(0, 280).trimEnd()}…`
      : compact;
  });
};

/** A group's one line: how many children, whether any is live, whether any failed. */
export interface SubagentGroupSummary {
  readonly label: string;
  readonly active: boolean;
  readonly failed: boolean;
}

/** The summary of a group of children; a live group never dims, a failed member never hides. */
export const subagentGroupSummary = (
  members: ReadonlyArray<{ readonly state: SubagentState }>
): SubagentGroupSummary => ({
  label: `${members.length} ${members.length === 1 ? "subagent" : "subagents"}`,
  active: members.some(({ state }) => isActiveSubagentState(state)),
  failed: members.some(({ state }) => state === "failed"),
});

/** Where a state counts in a group's tally. */
type TallyKey =
  | "need you"
  | "asking"
  | "working"
  | "held"
  | "done"
  | "failed"
  | "stopped"
  | "not started";

const TALLY_ORDER: ReadonlyArray<TallyKey> = [
  "need you",
  "asking",
  "working",
  "held",
  "done",
  "failed",
  "stopped",
  "not started",
];

const TALLY_OF: Readonly<Record<SubagentState, TallyKey>> = {
  go: "need you",
  approval: "need you",
  input: "need you",
  "asking-parent": "asking",
  working: "working",
  waiting: "working",
  parked: "held",
  limited: "held",
  done: "done",
  failed: "failed",
  stopped: "stopped",
  declined: "not started",
  expired: "not started",
  cancelled: "not started",
  unstarted: "not started",
};

/** A group's tally in a fixed order, only the counts above zero: "1 working · 2 done". */
export const summarizeSubagentStates = (
  states: ReadonlyArray<SubagentState>
): string => {
  const counts = new Map<TallyKey, number>();

  for (const state of states) {
    const key = TALLY_OF[state];

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return TALLY_ORDER.flatMap((key) => {
    const count = counts.get(key);

    return count === undefined ? [] : [`${count} ${key}`];
  }).join(" · ");
};

/** When a row or a group ran: its start, and its end once nothing in it is live. */
export interface SubagentTiming {
  readonly startedAt: Option.Option<number>;
  readonly completedAt: Option.Option<number>;
}

/** A group's span: its earliest start, and its latest end once every member ended with one. */
export const subagentGroupTiming = (
  members: ReadonlyArray<SubagentTiming & { readonly state: SubagentState }>
): SubagentTiming => {
  const starts = members.flatMap(({ startedAt }) => Option.toArray(startedAt));

  const ends = members.flatMap(({ completedAt }) =>
    Option.toArray(completedAt)
  );

  const live = members.some(({ state }) => isActiveSubagentState(state));
  const endUnknown = ends.length < members.length;

  return {
    startedAt:
      starts.length === 0 ? Option.none() : Option.some(Math.min(...starts)),
    completedAt:
      live || endUnknown || ends.length === 0
        ? Option.none()
        : Option.some(Math.max(...ends)),
  };
};

// ---------------------------------------------------------------------------------------------
// What the parent's view holds

/** One `subagent_spawn` call in the parent's committed transcript. */
export interface SpawnCall {
  readonly callId: string;
  readonly description: string;
  /** The assistant message's time, which its calls share. */
  readonly createdAt: number;
  /** `pending` until its result is committed; `error` when the spawn was refused. */
  readonly result: "pending" | "ok" | "error";
}

const ToolCallPart = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Json),
});

const AssistantModel = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Json),
  timestamp: Schema.Finite,
});

const ToolResultModel = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  isError: Schema.Boolean,
});

const SpawnArguments = Schema.Struct({ description: Schema.String });

const decodeAssistant = Schema.decodeUnknownOption(AssistantModel);

const decodeToolCall = Schema.decodeUnknownOption(ToolCallPart);

const decodeToolResult = Schema.decodeUnknownOption(ToolResultModel);

const decodeSpawnArguments = Schema.decodeUnknownOption(SpawnArguments);

const firstModel = (entry: Entry): Option.Option<Schema.Json> =>
  Option.fromUndefinedOr(entry.model?.[0]);

/** A call's result: none yet, a refusal, or the brief asked. */
const resultOf = (isError: boolean | undefined): SpawnCall["result"] => {
  if (isError === undefined) {
    return "pending";
  }

  return isError ? "error" : "ok";
};

/** Every `subagent_spawn` call in `entries`, oldest first, with whether its result came. */
export const spawnCallsOf = (
  entries: ReadonlyArray<Entry>
): ReadonlyArray<SpawnCall> => {
  const results = new Map<string, boolean>();

  for (const entry of entries) {
    if (entry.kind !== "pi.tool-result") {
      continue;
    }

    Option.map(Option.flatMap(firstModel(entry), decodeToolResult), (result) =>
      results.set(result.toolCallId, result.isError)
    );
  }

  return entries.flatMap((entry) => {
    if (entry.kind !== "pi.assistant") {
      return [];
    }

    return Option.match(Option.flatMap(firstModel(entry), decodeAssistant), {
      onNone: () => [],
      onSome: (message) =>
        message.content.flatMap((part) =>
          Option.match(
            Option.filter(
              decodeToolCall(part),
              (call) => call.name === SPAWN_TOOL
            ),
            {
              onNone: () => [],
              onSome: (call): ReadonlyArray<SpawnCall> => {
                const isError = results.get(call.id);

                return [
                  {
                    callId: call.id,
                    description: Option.match(
                      decodeSpawnArguments(call.arguments),
                      {
                        onNone: () => "",
                        onSome: (args) => args.description.trim(),
                      }
                    ),
                    createdAt: message.timestamp,
                    result: resultOf(isError),
                  },
                ];
              },
            }
          )
        ),
    });
  });
};

/** What a row reads of a child's registry item; the rest of the record is the brain's. */
export interface RegistryChild {
  readonly threadId: ThreadId;
  readonly briefApprovalId: string;
  readonly status: SubagentStatus;
  readonly dispatchedAt: number;
  /** Each settlement's outcome and time, oldest first. */
  readonly settlements: ReadonlyArray<{
    readonly outcome: SettlementOutcome;
    readonly reportedAt: number;
  }>;
}

const RegistryItem = Schema.Struct({
  threadId: ThreadId,
  briefApprovalId: Schema.String,
  status: SubagentStatus,
  dispatch: Schema.Struct({ dispatchedAt: Schema.Finite }),
  settlements: Schema.Array(
    Schema.Struct({ outcome: SettlementOutcome, reportedAt: Schema.Finite })
  ),
});

const decodeRegistry = Schema.decodeUnknownOption(
  Schema.Struct({ items: Schema.Record(Schema.String, Schema.Json) })
);

const decodeRegistryItem = Schema.decodeUnknownOption(RegistryItem);

/** The children of a `cairn.subagents` document as a client holds it, by brief id. */
export const registryChildrenOf = (
  document: Schema.Json | undefined
): ReadonlyMap<string, RegistryChild> =>
  new Map(
    Option.match(decodeRegistry(document), {
      onNone: () => [],
      onSome: ({ items }) =>
        Object.values(items).flatMap((raw) =>
          Option.toArray(
            Option.map(
              decodeRegistryItem(raw),
              (item) =>
                [
                  item.briefApprovalId,
                  {
                    threadId: item.threadId,
                    briefApprovalId: item.briefApprovalId,
                    status: item.status,
                    dispatchedAt: item.dispatch.dispatchedAt,
                    settlements: item.settlements,
                  },
                ] as const
            )
          )
        ),
    })
  );

/** What a settlement's note in the parent says, newest per child. */
export interface SettlementNote {
  readonly seq: number;
  readonly outcome: SettlementOutcome;
  readonly summary: string;
  readonly error: Option.Option<string>;
}

const SettlementData = Schema.Struct({
  subagent: ThreadId,
  seq: Schema.Int,
  outcome: SettlementOutcome,
  summary: Schema.String,
  error: Schema.NullOr(Schema.String),
});

const decodeSettlement = Schema.decodeUnknownOption(SettlementData);

/** The newest settlement note of each child in `entries`, by the child's thread id. */
export const settlementNotesOf = (
  entries: ReadonlyArray<Entry>
): ReadonlyMap<string, SettlementNote> => {
  const notes = new Map<string, SettlementNote>();

  for (const entry of entries) {
    if (entry.kind !== SUBAGENT_RESULT_ENTRY) {
      continue;
    }

    Option.map(decodeSettlement(entry.data), (data) => {
      const known = notes.get(data.subagent);

      if (known === undefined || known.seq <= data.seq) {
        notes.set(data.subagent, {
          seq: data.seq,
          outcome: data.outcome,
          summary: data.summary,
          error: Option.fromNullOr(data.error),
        });
      }
    });
  }

  return notes;
};

const UnstartedAnswer = Schema.Struct({
  briefId: Schema.String,
  started: Schema.Literal(false),
});

const decodeUnstartedAnswer = Schema.decodeUnknownOption(UnstartedAnswer);

const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

// A note's message carries text parts; a follow-up input's may carry its text as one string.
const AnswerModel = Schema.Struct({
  content: Schema.Union([Schema.String, Schema.Array(Schema.Json)]),
});

const decodeAnswerModel = Schema.decodeUnknownOption(AnswerModel);

const decodeTextPart = Schema.decodeUnknownOption(TextPart);

/**
 * What the parent was told of each brief that started nothing, by brief id: the words of its
 * `cairn.brief-answer` entry with `started: false`. An accepted brief whose start was refused (a
 * role, budget, workspace or the brain's room) ends here; Go's own answer says `started: true`.
 */
export const unstartedAnswersOf = (
  entries: ReadonlyArray<Entry>
): ReadonlyMap<string, string> => {
  const told = new Map<string, string>();

  for (const entry of entries) {
    if (entry.kind !== BRIEF_ANSWER_ENTRY) {
      continue;
    }

    Option.map(decodeUnstartedAnswer(entry.data), ({ briefId }) => {
      const words = Option.getOrElse(
        Option.map(
          Option.flatMap(
            Option.fromUndefinedOr(entry.model?.[0]),
            decodeAnswerModel
          ),
          ({ content }) =>
            Predicate.isString(content)
              ? content
              : content
                  .flatMap((part) => Option.toArray(decodeTextPart(part)))
                  .map(({ text }) => text)
                  .join(" ")
        ),
        () => ""
      );

      told.set(briefId, words);
    });
  }

  return told;
};

/** A spawn call linked to the brief it asked, with the child Go started, if any. */
export interface SubagentLink {
  readonly call: SpawnCall;
  readonly brief: ApprovalRecord;
  readonly child: Option.Option<RegistryChild>;
  readonly note: Option.Option<SettlementNote>;
  /** What the parent was told when the brief started nothing, once it was. */
  readonly unstarted: Option.Option<string>;
}

const isSpawnBrief = (record: ApprovalRecord): boolean =>
  record.kind === "brief" && record.tool === SPAWN_TOOL;

/** Briefs in the order their calls asked them: by time, then by the tool task that asked. */
const byAsking = (a: ApprovalRecord, b: ApprovalRecord): number =>
  a.askedAt - b.askedAt || a.toolTaskId - b.toolTaskId;

/**
 * Each spawn call paired with its brief, oldest first. The newest call takes the newest brief not
 * yet taken whose summary is its description: calls of one step ask in the same instant, so the
 * tool task that asked orders them. A refused call has no brief, and a call whose brief is not in
 * the document yet (or is older than what is loaded) stays unpaired and is left out.
 */
export const linkSpawnCalls = (
  calls: ReadonlyArray<SpawnCall>,
  briefs: ReadonlyArray<ApprovalRecord>
): ReadonlyArray<{
  readonly call: SpawnCall;
  readonly brief: ApprovalRecord;
}> => {
  const spawnBriefs = briefs.filter(isSpawnBrief).toSorted(byAsking);
  const taken = new Set<string>();

  const links: Array<{
    readonly call: SpawnCall;
    readonly brief: ApprovalRecord;
  }> = [];

  for (const call of calls.toReversed()) {
    if (call.result === "error") {
      continue;
    }

    const brief = spawnBriefs.findLast(
      (candidate) =>
        !taken.has(candidate.id) &&
        candidate.summary.trim() === call.description
    );

    if (brief !== undefined) {
      taken.add(brief.id);
      links.push({ call, brief });
    }
  }

  return links.toReversed();
};

/** What the parent's view holds that its subagent rows read. */
export interface SubagentView {
  /** Committed entries, older pages first. */
  readonly entries: ReadonlyArray<Entry>;
  readonly docs: Readonly<Record<string, Schema.Json>>;
}

/** The parent's spawn calls linked to their briefs, children and newest notes, oldest first. */
export const subagentLinksOf = (
  view: SubagentView
): ReadonlyArray<SubagentLink> => {
  const registry = registryChildrenOf(view.docs[SUBAGENTS_DOCUMENT]);
  const notes = settlementNotesOf(view.entries);
  const unstarted = unstartedAnswersOf(view.entries);

  return linkSpawnCalls(
    spawnCallsOf(view.entries),
    approvalRecordsOf(view.docs[APPROVALS_DOCUMENT])
  ).map(({ call, brief }) => {
    const child = Option.fromUndefinedOr(registry.get(brief.id));

    const childThreadId = Option.orElse(
      Option.map(child, ({ threadId }) => threadId),
      () =>
        Option.map(
          Option.fromNullOr(brief.started),
          (started) => started.childThreadId
        )
    );

    return {
      call,
      brief,
      child,
      note: Option.flatMap(childThreadId, (id) =>
        Option.fromUndefinedOr(notes.get(id))
      ),
      unstarted: Option.fromUndefinedOr(unstarted.get(brief.id)),
    };
  });
};

const ChildLink = Schema.Struct({ parentThreadId: ThreadId });

const decodeChildLink = Schema.decodeUnknownOption(ChildLink);

/** The parent of a subagent's thread, from its `cairn.child` document; none for any other thread. */
export const parentThreadIdOf = (
  docs: Readonly<Record<string, Schema.Json>>
): Option.Option<ThreadId> =>
  Option.map(
    decodeChildLink(docs[CHILD_DOCUMENT]),
    (link) => link.parentThreadId
  );

// ---------------------------------------------------------------------------------------------
// One row

/** A child's row, everything it shows. */
export interface SubagentRow {
  readonly key: string;
  readonly title: string;
  readonly state: SubagentState;
  readonly label: SubagentLabel;
  /** The child's thread, once Go started it: the row opens it. */
  readonly childThreadId: Option.Option<ThreadId>;
  readonly detail: Option.Option<string>;
  readonly startedAt: Option.Option<number>;
  readonly completedAt: Option.Option<number>;
}

/** What else a row reads beyond the parent's view: the child's shell row and its descendants' asks. */
export interface SubagentRowContext {
  readonly row: (threadId: ThreadId) => Option.Option<ThreadStateRow>;
  readonly request: (threadId: ThreadId) => Option.Option<SubagentRequest>;
}

/**
 * A brief's state before its child exists: waiting for Go, or ended without one. An accepted brief
 * whose child is not started yet reads as working while Go's start task makes it, and as
 * `unstarted` once the parent was told it started nothing (`briefState`).
 */
const BRIEF_STATE: Readonly<Record<ApprovalRecord["status"], SubagentState>> = {
  pending: "go",
  accepted: "working",
  declined: "declined",
  expired: "expired",
  cancelled: "cancelled",
  revised: "cancelled",
};

const SETTLED_STATE: Readonly<Record<SettlementOutcome, SubagentState>> = {
  completed: "done",
  failed: "failed",
  stopped: "stopped",
};

/** A brief's state with no child: its record's, unless the parent was told its Go started nothing. */
const briefState = (link: SubagentLink): SubagentState =>
  link.brief.status === "accepted" && Option.isSome(link.unstarted)
    ? "unstarted"
    : BRIEF_STATE[link.brief.status];

/** A started child at rest: how its latest settlement ended, else still working toward one. */
const restingState = (child: Option.Option<RegistryChild>): SubagentState =>
  Option.match(
    Option.flatMap(child, (found) =>
      Option.fromUndefinedOr(found.settlements.at(-1))
    ),
    {
      onNone: () => "working",
      onSome: ({ outcome }) => SETTLED_STATE[outcome],
    }
  );

/** A started child's state without its shell row (archived, deleted, or not arrived): its registry's. */
const registryState = (child: Option.Option<RegistryChild>): SubagentState =>
  Option.match(child, {
    onNone: () => "working",
    onSome: (found) => {
      if (found.status === "working") {
        return "working";
      }

      return found.status === "waiting" ? "asking-parent" : restingState(child);
    },
  });

/** A started child's state for each thread status; `ready` reads its latest settlement instead. */
const LIVE_STATE: Readonly<
  Record<Exclude<ThreadStatus, "ready">, SubagentState>
> = {
  approval: "approval",
  go: "go",
  input: "input",
  "asking-parent": "asking-parent",
  working: "working",
  waiting: "waiting",
  parked: "parked",
  failed: "failed",
  limited: "limited",
};

/** A started child's state: what its own row says, or at rest how it settled. */
const startedState = (
  childThreadId: ThreadId,
  child: Option.Option<RegistryChild>,
  context: SubagentRowContext
): SubagentState =>
  Option.match(context.row(childThreadId), {
    onNone: () => registryState(child),
    onSome: (row) => {
      const status = threadStatus(row, context.request(childThreadId));

      return status === "ready" ? restingState(child) : LIVE_STATE[status];
    },
  });

/** A child's row from its link and its live state. */
export const subagentRowOf = (
  link: SubagentLink,
  context: SubagentRowContext
): SubagentRow => {
  const childThreadId = Option.orElse(
    Option.map(link.child, ({ threadId }) => threadId),
    () =>
      Option.map(
        Option.fromNullOr(link.brief.started),
        (started) => started.childThreadId
      )
  );

  const state: SubagentState = Option.match(childThreadId, {
    onNone: () => briefState(link),
    onSome: (id) => startedState(id, link.child, context),
  });

  const ended = isTerminalSubagentState(state);

  return {
    key: link.call.callId,
    title: formatSubagentDisplayTitle(link.brief.summary),
    state,
    label: SUBAGENT_LABELS[state],
    childThreadId,
    detail: subagentDetailPreview({
      state,
      result: Option.orElse(
        Option.map(link.note, (note) =>
          Option.getOrElse(note.error, () => note.summary)
        ),
        () => Option.filter(link.unstarted, () => state === "unstarted")
      ),
      progress: Option.none(),
    }),
    startedAt: Option.map(link.child, ({ dispatchedAt }) => dispatchedAt),
    completedAt: ended
      ? Option.orElse(
          Option.flatMap(link.child, (found) =>
            Option.map(
              Option.fromUndefinedOr(found.settlements.at(-1)),
              ({ reportedAt }) => reportedAt
            )
          ),
          () => Option.fromNullOr(link.brief.answeredAt)
        )
      : Option.none(),
  };
};

/** The rows the open thread's children need: their shell rows and what their descendants ask. */
export const subagentRowContextOf = (
  rows: ReadonlyMap<ThreadId, ThreadShell>,
  requests: ReadonlyMap<ThreadId, SubagentRequest>
): SubagentRowContext => ({
  row: (threadId) => Option.fromUndefinedOr(rows.get(threadId)),
  request: (threadId) => Option.fromUndefinedOr(requests.get(threadId)),
});
