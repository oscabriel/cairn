// The view the conformance suite judges: the client's projected thread view reduced to what the
// seam's contract promises, so two implementations with different ids, timestamps, prompt deltas
// and bookkeeping can be held to the same expectations.
//
// - `transcript`: the visible entries in order (hidden placeholders left out), each with its kind,
//   role, text, tool calls, tool name, error flag and image count.
// - `queue`: queued inputs with their mode and text; `queueLength`.
// - `running`: whether `pi.live` has a run.
// - `approvals`: approval records by age, with their status and tool; `pendingApprovals`.
// - `decisions`: the same records' status, who decided (the `decidedBy` kind) and the reason.
// - `model` and `thinkingLevel`: the thread's model and level, as its `pi.agent` holds them.
// - `subagents`: on a parent with children only, each child's registry status, its settlements,
//   the last one delivered, where its questions to the parent stand and the model its dispatch
//   record names, by thread id.
//
// A named device's view (`normalizeDeviceView`) adds what its client reads from the records
// through `PendingRequests`: `card`, the requests the card offers in order (tool, body, "i/N"),
// and `lines`, each settled record's transcript line (status, words, a question's answers).

import {
  approvalRecordsOf,
  pendingRequests,
  settledLines,
} from "@cairn/client-logic/PendingRequests";
import type { ConversationView } from "@cairn/protocol/Thread";
import { Option, Predicate } from "effect";
import type { Schema } from "effect";

import { HIDDEN_ENTRY_KIND } from "../ThreadWire.ts";

type Json = Schema.Json;

const isRecord = (value: Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const isList = (value: Json | undefined): value is Schema.JsonArray =>
  Array.isArray(value);

/** Text blocks of a content value, joined; a plain string is its own text. */
const textOf = (content: Json | undefined): string => {
  if (Predicate.isString(content)) {
    return content;
  }

  if (!isList(content)) {
    return "";
  }

  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && Predicate.isString(part.text)
        ? [part.text]
        : []
    )
    .join("");
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

const normalizeEntry = (entry: ConversationView["entries"][number]) => {
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

/** The fields of a normalized view. */
const viewFields = (view: ConversationView) => {
  const transcript = view.entries
    .filter((entry) => entry.kind !== HIDDEN_ENTRY_KIND)
    .map(normalizeEntry);

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

  const parentOnly = subagents.length > 0 ? { subagents } : {};

  return {
    ...parentOnly,
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
