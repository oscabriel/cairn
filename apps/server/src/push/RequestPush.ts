// The rules of approval push (briefs note B7, ADR 0027): which pending requests a push may be about,
// what it says, and when a follow-up is owed. Pure, so `Notifier.ts` keeps the effects (claims,
// presence, delivery) and the tests can walk the rules on their own.
//
// - A push is about a request the user can answer now: pending, routed to the user, and not the
//   child's side of an escalated question (its mirror in the parent is pushed instead, once).
// - Its claim keys live in `notified_runs` beside the run ends': `req:<id>` for the first decision
//   (sent, or suppressed while a page showed the thread, its request's home thread or an ancestor),
//   `req:<id>:late` for the push owed after a suppressed or missed first decision once the request
//   is 60 seconds old, `req:<id>:remind` for the one reminder 15 minutes after the last push.
// - The body says what is asked: "Go? <brief title>", "Approve <summary>", "<header>: <question>",
//   prefixed "<child> asks:" for an escalated question, "<n> things need you." when more wait on the
//   thread, and "Still waiting." on the reminder.

import { pendingRequests } from "@cairn/client-logic/PendingRequests";
import type { ApprovalRecord } from "@cairn/protocol/Policy";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Duration, Option } from "effect";

/** The claim key of a request's first push decision. */
export const requestKey = (approvalId: string): string => `req:${approvalId}`;

/** The claim key of the push owed after a suppressed or missed first decision. */
export const lateKey = (approvalId: string): string => `req:${approvalId}:late`;

/** The claim key of a request's one reminder. */
export const remindKey = (approvalId: string): string =>
  `req:${approvalId}:remind`;

/** The tag every approval push of one thread shares, so a newer one replaces the older. */
export const requestTag = (threadId: string): string => `ask:${threadId}`;

/**
 * The requests a push may be about, in card order: pending and routed to the user. The child's
 * side of an escalated question (`escalatedAt` set, no `mirrorOf`) is left out, because the parent
 * holds its mirror and a push for both would ask twice.
 */
export const requestsToPush = (
  records: ReadonlyArray<ApprovalRecord>
): ReadonlyArray<ApprovalRecord> =>
  pendingRequests(records)
    .map((request) => request.record)
    .filter(
      (record) => record.mirrorOf !== null || record.escalatedAt === null
    );

/** The newest of `records` by `askedAt`, the id breaking ties; none when empty. */
export const newestRequest = (
  records: ReadonlyArray<ApprovalRecord>
): Option.Option<ApprovalRecord> =>
  Option.fromUndefinedOr(
    records.toSorted(
      (a, b) => b.askedAt - a.askedAt || b.id.localeCompare(a.id)
    )[0]
  );

/** What one request asks, in a line. */
export const requestLine = (record: ApprovalRecord): string => {
  const { payload } = record;

  if (payload?.type === "brief") {
    return `Go? ${payload.title}`;
  }

  if (payload?.type === "workflow") {
    return `Go? ${payload.name}`;
  }

  if (payload?.type === "questions") {
    const [first] = payload.questions;
    const more = payload.questions.length - 1;

    return `${first.header}: ${first.question}${more > 0 ? ` (and ${String(more)} more)` : ""}`;
  }

  if (payload?.type === "criteria") {
    const more = payload.criteria.length - 1;

    return `Approve criteria: ${payload.criteria[0].text}${more > 0 ? ` (and ${String(more)} more)` : ""}`;
  }

  if (record.kind === "sign-in") {
    return record.summary;
  }

  return `Approve ${record.summary}`;
};

/** One approval push, before it is cut to the message's limits. */
export interface RequestPush {
  /** The row whose card shows the request: its title heads the push and a tap opens it. */
  readonly thread: ThreadShell;
  /** The request the push is about: the newest of those it was sent for. */
  readonly request: ApprovalRecord;
  /** Requests waiting for the user on the thread, this one included. */
  readonly count: number;
  /** The asking child's title, for an escalated question's mirror. */
  readonly asker: Option.Option<string>;
  /** The reminder 15 minutes after the last push. */
  readonly reminder: boolean;
}

/** The push's body: "Still waiting." on a reminder, the count, the asker, then the line. */
export const requestBody = (
  push: Pick<RequestPush, "request" | "count" | "asker" | "reminder">
): string => {
  const line = requestLine(push.request);

  const asked = Option.match(push.asker, {
    onNone: () => line,
    onSome: (child) => `${child} asks: ${line}`,
  });

  const counted =
    push.count > 1 ? `${String(push.count)} things need you. ${asked}` : asked;

  return push.reminder ? `Still waiting. ${counted}` : counted;
};

/** A claim recorded in `notified_runs`. */
export interface Claim {
  readonly outcome: "sent" | "suppressed";
  /** Epoch milliseconds. */
  readonly at: number;
}

/** The claims of one request. */
export interface RequestClaims {
  readonly first: Option.Option<Claim>;
  readonly late: Option.Option<Claim>;
  readonly remind: boolean;
}

/** When follow-ups are owed. */
export interface FollowUpTimings {
  /** A request no push went out for is pushed once it is this old and no page shows it. */
  readonly lateAfter: Duration.Duration;
  /** A request still pending this long after its last push is pushed once more. */
  readonly remindAfter: Duration.Duration;
}

/** A follow-up a request is owed. */
export type FollowUp = "late" | "remind";

/**
 * The follow-up `request` is owed at `now` (epoch milliseconds), if any. A request no push went out
 * for (its first decision suppressed, or never made because its event was missed) is owed a late
 * push once it is `lateAfter` old; a request that was pushed is owed one reminder `remindAfter`
 * after its last push. Nothing more after the reminder.
 */
export const followUpDue = (
  request: Pick<ApprovalRecord, "askedAt">,
  claims: RequestClaims,
  now: number,
  timings: FollowUpTimings
): Option.Option<FollowUp> => {
  if (claims.remind) {
    return Option.none();
  }

  const sent = [claims.first, claims.late].flatMap((claim) =>
    Option.isSome(claim) && claim.value.outcome === "sent"
      ? [claim.value.at]
      : []
  );

  if (sent.length > 0) {
    return now - Math.max(...sent) >= Duration.toMillis(timings.remindAfter)
      ? Option.some("remind")
      : Option.none();
  }

  if (Option.isSome(claims.late)) {
    return Option.none();
  }

  return now - request.askedAt >= Duration.toMillis(timings.lateAfter)
    ? Option.some("late")
    : Option.none();
};
