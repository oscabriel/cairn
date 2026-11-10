// The view the conformance suite judges: the client's projected thread view reduced to what the
// seam's contract promises, so two implementations with different ids, timestamps, prompt deltas
// and bookkeeping can be held to the same expectations.
//
// - `transcript`: the visible entries in order (hidden placeholders left out), each with its kind,
//   role, text, tool calls, tool name, error flag and image count. A text past 8192 characters is
//   written as its head, its length and its tail (`normalizeText`).
// - `queue`: queued inputs with their mode and text; `queueLength`.
// - `running`: whether `pi.live` has a run.
// - `approvals`: approval records by age, with their status and tool; `pendingApprovals`.
// - `decisions`: the same records' status, who decided (the `decidedBy` kind) and the reason.
// - `model` and `thinkingLevel`: the thread's model and level, as its `pi.agent` holds them.
// - `subagents`: on a parent with children only, each child's registry status, its settlements,
//   the last one delivered, where its questions to the parent stand and the model its dispatch
//   record names, by thread id.
// - `escalations`: on a parent with escalated child questions only, each `cairn.escalations`
//   entry's status and why it reached the user, oldest first.
//
// A named device's view (`normalizeDeviceView`) adds what its client reads from the records
// through `PendingRequests`: `card`, the requests the card offers in order (tool, body, "i/N"),
// and `lines`, each settled record's transcript line (status, words, a question's answers).
//
// The seam's reads are judged in the same terms: a history page's or a full entry's entries as
// `transcript` holds them (`normalizeEntries`, `normalizeEntry`), and `inspect`'s states by thread
// alias (`normalizeInspection`).

import {
  approvalRecordsOf,
  pendingRequests,
  settledLines,
} from "@cairn/client-logic/PendingRequests";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { ConversationView, Entry } from "@cairn/protocol/Thread";
import { Option, Predicate } from "effect";
import type { Schema } from "effect";

import type { LiveThreadState } from "../HarnessSeam.ts";
import { HIDDEN_ENTRY_KIND } from "../ThreadWire.ts";

type Json = Schema.Json;

const isRecord = (value: Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const isList = (value: Json | undefined): value is Schema.JsonArray =>
  Array.isArray(value);

/** Texts longer than this are written short: far past any scenario's ordinary text. */
const LONG_TEXT_CHARS = 8192;

/**
 * A text as expectations and goldens write it: whole, or, past `LONG_TEXT_CHARS`, its first 16
 * characters, its length and its last 40, so a text cut for the wire (which ends with the
 * truncation marker) and a whole one read differently without either being written out.
 */
export const normalizeText = (text: string) =>
  text.length <= LONG_TEXT_CHARS
    ? text
    : `${text.slice(0, 16)}…[${String(text.length)} chars]…${text.slice(-40)}`;

/** Text blocks of a content value, joined; a plain string is its own text. */
const textOf = (content: Json | undefined): string => {
  if (Predicate.isString(content)) {
    return normalizeText(content);
  }

  if (!isList(content)) {
    return "";
  }

  return normalizeText(
    content
      .flatMap((part) =>
        isRecord(part) && part.type === "text" && Predicate.isString(part.text)
          ? [part.text]
          : []
      )
      .join("")
  );
};

const countImages = (content: Json | undefined) =>
  isList(content)
    ? content.filter((part) => isRecord(part) && part.type === "image").length
    : 0;

const toolCallsOf = (content: Json | undefined) =>
  isList(content)
    ? content.flatMap((part) =>
        isRecord(part) &&
        part.type === "toolCall" &&
        Predicate.isString(part.name)
          ? [part.name]
          : []
      )
    : [];

/** One entry as the view's `transcript` holds it; `thread.entry`'s read is judged this way too. */
export const normalizeEntry = (entry: Entry): Json => {
  const message = Option.fromUndefinedOr(entry.model?.[0]).pipe(
    Option.filter(isRecord)
  );

  const role = Option.flatMap(message, (found) =>
    Predicate.isString(found.role) ? Option.some(found.role) : Option.none()
  );

  const content = Option.match(message, {
    onNone: () => null,
    onSome: (found) => found.content ?? null,
  });

  const toolName =
    Option.isSome(message) && Predicate.isString(message.value.toolName)
      ? message.value.toolName
      : null;

  return {
    kind: entry.kind,
    role: Option.getOrNull(role),
    text: textOf(content),
    images: countImages(content),
    toolCalls: toolCallsOf(content),
    toolName,
    isError:
      toolName === null
        ? null
        : Option.isSome(message) && message.value.isError === true,
  };
};

/** The visible entries of a list, hidden placeholders left out. */
export const visibleEntries = (entries: ReadonlyArray<Entry>) =>
  entries.filter((entry) => entry.kind !== HIDDEN_ENTRY_KIND);

/** Entries as the view's `transcript` holds them: the visible ones, normalized. */
export const normalizeEntries = (entries: ReadonlyArray<Entry>) =>
  visibleEntries(entries).map(normalizeEntry);

/** The fields of a normalized view. */
const viewFields = (view: ConversationView) => {
  const transcript = normalizeEntries(view.entries);

  const inbox = view.docs["pi.inbox"];
  const items = isRecord(inbox) && isList(inbox.items) ? inbox.items : [];

  const queue = items.flatMap((item) =>
    isRecord(item) && item.mode !== "write"
      ? [{ mode: item.mode ?? null, text: textOf(item.content) }]
      : []
  );

  const live = view.docs["pi.live"];
  const running = isRecord(live) && isRecord(live.run);

  const approvalsDoc = view.docs["cairn.approvals"];

  const records =
    isRecord(approvalsDoc) && isRecord(approvalsDoc.items)
      ? Object.values(approvalsDoc.items).filter(isRecord)
      : [];

  const byAge = records.toSorted(
    (a, b) => Number(a.askedAt ?? 0) - Number(b.askedAt ?? 0)
  );

  const approvals = byAge.map((record) => ({
    status: record.status ?? null,
    tool: record.tool ?? null,
  }));

  const decisions = byAge.map((record) => ({
    status: record.status ?? null,
    decidedBy: isRecord(record.decidedBy)
      ? (record.decidedBy.kind ?? null)
      : null,
    reason: record.reason ?? null,
  }));

  const agent = view.docs["pi.agent"];
  const registry = view.docs["cairn.subagents"];

  // A parent's children, by thread id: where each stands and how many results reached the parent.
  const subagents =
    isRecord(registry) && isRecord(registry.items)
      ? Object.values(registry.items)
          .filter(isRecord)
          .toSorted((a, b) =>
            JSON.stringify(a.threadId ?? null).localeCompare(
              JSON.stringify(b.threadId ?? null)
            )
          )
          .map((item) => ({
            status: item.status ?? null,
            settlements: isList(item.settlements) ? item.settlements.length : 0,
            delivered: item.delivered ?? null,
            // Where each of its questions to the parent stands, sorted: ids differ by harness.
            questions: isRecord(item.questions)
              ? Object.values(item.questions)
                  .map((question) =>
                    isRecord(question) && Predicate.isString(question.state)
                      ? question.state
                      : "unreadable"
                  )
                  .toSorted()
              : [],
            model:
              isRecord(item.dispatch) &&
              isRecord(item.dispatch.resolved) &&
              isRecord(item.dispatch.resolved.model)
                ? item.dispatch.resolved.model
                : null,
          }))
      : [];

  const index = view.docs["cairn.escalations"];

  // A parent's escalated child questions, oldest first: where each stands and why it reached the
  // user. Ids and times differ by harness.
  const escalations =
    isRecord(index) && isRecord(index.items)
      ? Object.values(index.items)
          .filter(isRecord)
          .toSorted(
            (a, b) => Number(a.escalatedAt ?? 0) - Number(b.escalatedAt ?? 0)
          )
          .map((entry) => ({
            status: entry.status ?? null,
            why: entry.why ?? null,
          }))
      : [];

  // A parent's own fields lead, present only on a parent that has them.
  const fields: Record<string, Json> = {};

  if (subagents.length > 0) {
    fields.subagents = subagents;
  }

  if (escalations.length > 0) {
    fields.escalations = escalations;
  }

  return {
    ...fields,
    transcript,
    transcriptLength: transcript.length,
    queue,
    queueLength: queue.length,
    running,
    approvals,
    pendingApprovals: approvals.filter((item) => item.status === "pending")
      .length,
    decisions,
    model: isRecord(agent) && isRecord(agent.model) ? agent.model : null,
    thinkingLevel:
      isRecord(agent) && Predicate.isString(agent.thinkingLevel)
        ? agent.thinkingLevel
        : null,
  };
};

/** The normalized view of a client's projected view. */
export const normalizeView = (view: ConversationView): Json => viewFields(view);

/** A named device's normalized view: the thread's, with its card and settled lines. */
export const normalizeDeviceView = (view: ConversationView): Json => {
  const records = approvalRecordsOf(view.docs["cairn.approvals"]);

  const card = pendingRequests(records).map((request) => ({
    tool: request.record.tool,
    body: request.body._tag,
    position: request.position,
    total: request.total,
  }));

  const lines = settledLines(records).map((line) => ({
    status: line.status,
    text: line.text,
    answers: line.answers.map(
      (answered) => `${answered.header}: ${answered.text}`
    ),
  }));

  return { ...viewFields(view), card, lines };
};

/**
 * `inspect`'s states as an `expect_inspect` line writes them: one per thread in `rank` order, with
 * whether a run is live, the queue's length and the pending records oldest first. Ids and times
 * differ by harness, so a thread is named by its alias and a record by its kind, route and origin.
 */
export const normalizeInspection = (
  states: ReadonlyArray<LiveThreadState>,
  aliasOf: (threadId: ThreadId) => string,
  rank: (threadId: ThreadId) => number
): Json =>
  states
    .toSorted((a, b) => rank(a.threadId) - rank(b.threadId))
    .map((state) => ({
      thread: aliasOf(state.threadId),
      running: Option.isSome(state.runId),
      queueLength: state.queueLength,
      pending: state.pendingApprovals
        .toSorted((a, b) => a.askedAt - b.askedAt)
        .map((record) => ({
          kind: record.kind,
          route: record.route,
          origin: Option.match(record.origin, {
            onNone: () => null,
            onSome: aliasOf,
          }),
        })),
    }));

/** The ids of pending approvals in a client's view, oldest first. */
export const pendingApprovalIds = (view: ConversationView) => {
  const approvalsDoc = view.docs["cairn.approvals"];

  const records =
    isRecord(approvalsDoc) && isRecord(approvalsDoc.items)
      ? Object.values(approvalsDoc.items).filter(isRecord)
      : [];

  return records
    .filter((record) => record.status === "pending")
    .toSorted((a, b) => Number(a.askedAt ?? 0) - Number(b.askedAt ?? 0))
    .flatMap((record) => (Predicate.isString(record.id) ? [record.id] : []));
};

/**
 * The entry kinds the seam reports as MessageCommitted when committed: user and assistant messages,
 * as `CommitFeed.ts` lists them.
 */
export const COMMITTED_MESSAGE_KINDS: ReadonlySet<string> = new Set([
  "pi.user",
  "cairn.user",
  "pi.assistant",
]);

/**
 * The status of each record of a `cairn.*` document with `items` (`cairn.approvals`,
 * `cairn.subagents`) in a client's view, by the record's `key` field.
 */
export const statusesIn = (
  view: ConversationView,
  kind: string,
  key: string
): ReadonlyMap<string, string> => {
  const doc = view.docs[kind];

  const records =
    isRecord(doc) && isRecord(doc.items)
      ? Object.values(doc.items).filter(isRecord)
      : [];

  return new Map(
    records.flatMap((record) => {
      const id = record[key];

      return Predicate.isString(id) && Predicate.isString(record.status)
        ? [[id, record.status] as const]
        : [];
    })
  );
};

/** The value at `path`; negative indices count from the end. None when it does not resolve. */
export const valueAt = (
  value: Json,
  path: ReadonlyArray<string | number>
): Option.Option<Json> => {
  let current: Json = value;

  for (const segment of path) {
    if (isList(current) && Predicate.isNumber(segment)) {
      const item: Json | undefined = current.at(segment);

      if (item === undefined) {
        return Option.none();
      }

      current = item;
    } else if (
      isRecord(current) &&
      Predicate.isString(segment) &&
      Object.hasOwn(current, segment)
    ) {
      const field: Json | undefined = current[segment];

      if (field === undefined) {
        return Option.none();
      }

      current = field;
    } else {
      return Option.none();
    }
  }

  return Option.some(current);
};

/** Structural equality of JSON values. */
export const jsonEquals = (a: Json, b: Json): boolean => {
  if (isList(a) && isList(b)) {
    return (
      a.length === b.length &&
      a.every((item, i) => jsonEquals(item, b[i] ?? null))
    );
  }

  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);

    return (
      keys.length === Object.keys(b).length &&
      keys.every(
        (key) =>
          Object.hasOwn(b, key) && jsonEquals(a[key] ?? null, b[key] ?? null)
      )
    );
  }

  return a === b;
};

/** True when every field `expected` names is in `actual` with a matching value. */
export const jsonContains = (expected: Json, actual: Json): boolean => {
  if (isRecord(expected)) {
    return (
      isRecord(actual) &&
      Object.entries(expected).every(
        ([key, value]) =>
          Object.hasOwn(actual, key) && jsonContains(value, actual[key] ?? null)
      )
    );
  }

  return jsonEquals(expected, actual);
};
