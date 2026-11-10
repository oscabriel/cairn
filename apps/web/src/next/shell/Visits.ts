// What the shell does each time the shell rows, the route or the clock move (ADR 0050, from the
// classic sidebar's state): it forgets the visits the rows now show, sends a visit for the open
// thread when one is due (`shell/Visited.ts`), and keeps the favicon's number on the needs-you
// count. A visit is sent only while the shell is live, and never while one for the open thread
// still waits to show.

import { needsYouCount } from "@cairn/client-logic/Badge";
import { onlyIf } from "@cairn/client-logic/OnlyIf";
import { ThreadId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Array, DateTime, Option, Predicate, Schema } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { planVisit } from "../../shell/Visited.ts";
import { MintVisit, SetBadge } from "./Command.ts";
import type { Services } from "./Command.ts";
import type { Message } from "./Message.ts";
import { PENDING_VISIT_TTL_MS } from "./Model.ts";
import type { Model, PendingVisit } from "./Model.ts";

type Synced = Update.Return<Model, Message, Services>;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** The thread the route opens, when it names one. */
export const routedThreadIdOf = (model: Model): Option.Option<ThreadId> =>
  Predicate.isTagged(model.context.route, "Thread")
    ? decodeThreadId(model.context.route.threadId)
    : Option.none();

const rowsOf = (model: Model): ReadonlyArray<ThreadShell> =>
  Option.match(model.context.shell, {
    onNone: () => [],
    onSome: (shell) => shell.threads,
  });

/** True once the row shows a visit at `at` or later. */
const isShown = (rows: ReadonlyArray<ThreadShell>, visit: PendingVisit) =>
  rows.some(
    (row) =>
      row.id === visit.threadId &&
      Option.exists(row.lastVisitedAt, (visitedAt) =>
        DateTime.isGreaterThanOrEqualTo(visitedAt, visit.at)
      )
  );

/** The visits still waiting: not shown on a row the shell holds, and not past their time. */
const stillWaiting = (model: Model): ReadonlyArray<PendingVisit> => {
  const rows = rowsOf(model);

  return model.pendingVisits.filter(
    (visit) =>
      rows.some((row) => row.id === visit.threadId) &&
      !isShown(rows, visit) &&
      model.nowMs - visit.sentAtMs < PENDING_VISIT_TTL_MS
  );
};

/** The visit due for the open thread now, with the throttle's next state. */
const plannedVisit = (model: Model, waiting: ReadonlyArray<PendingVisit>) => {
  const open = routedThreadIdOf(model);

  const isWaiting = Option.exists(open, (threadId) =>
    waiting.some((visit) => visit.threadId === threadId)
  );

  return model.context.isLive && !isWaiting
    ? planVisit(
        model.visits,
        Option.flatMap(open, (threadId) =>
          Array.findFirst(rowsOf(model), (row) => row.id === threadId)
        ),
        DateTime.makeUnsafe(model.nowMs)
      )
    : { state: model.visits, visit: Option.none() };
};

/** The favicon's number for the shell, the scratch thread this page holds and the open thread. */
const badgeOf = (model: Model): number =>
  Option.match(model.context.shell, {
    onNone: () => 0,
    onSome: (shell) =>
      needsYouCount(shell, {
        scratchThreadId: model.scratch.threadId,
        openThreadId: routedThreadIdOf(model),
      }),
  });

/** Brings the visits and the favicon in line with the rows, the route and the clock. */
export const syncVisits = (model: Model): Synced => {
  const waiting = stillWaiting(model);

  // Before the first clock reading there is no time to stamp a visit with.
  if (model.nowMs === 0) {
    return {
      model:
        waiting.length === model.pendingVisits.length
          ? model
          : modifyFields(model, { pendingVisits: () => waiting }),
    };
  }

  const planned = plannedVisit(model, waiting);
  const count = badgeOf(model);

  const sent = Option.toArray(
    Option.map(planned.visit, ({ threadId, at }) => ({
      threadId,
      at,
      sentAtMs: model.nowMs,
    }))
  );

  return {
    model: modifyFields(model, {
      visits: () => planned.state,
      pendingVisits: () =>
        sent.length === 0 && waiting.length === model.pendingVisits.length
          ? model.pendingVisits
          : [...waiting, ...sent],
      badgeCount: () => count,
    }),
    commands: [
      ...sent.map(({ threadId, at }) => MintVisit({ threadId, at })),
      ...onlyIf(count !== model.badgeCount, SetBadge({ count })),
    ],
  };
};
