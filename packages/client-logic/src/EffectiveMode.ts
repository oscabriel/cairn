// A thread's effective permission mode (ADR 0031, subagents note section 7): the narrower of its own
// stored mode and its parent's effective mode, read again at each ask, so a parent switched to
// Supervised after a spawn narrows its child's next gated call, and a child never widens past its
// parent. Shared by the brain (the approval ledger, `thread.configure`'s refusal) and the client
// (the mode picker). The order is t3code's `RuntimeMode` order, narrowest first.

import type { ThreadId } from "@cairn/protocol/Ids";
import type { RuntimeMode } from "@cairn/protocol/Policy";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Option } from "effect";

/** The modes from narrowest (asks for most) to widest (asks for nothing). */
export const RUNTIME_MODE_ORDER: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

const RANK: Readonly<Record<RuntimeMode, number>> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

/** The narrower of two modes. */
export const narrowerMode = (
  left: RuntimeMode,
  right: RuntimeMode
): RuntimeMode => (RANK[right] < RANK[left] ? right : left);

/** True when `mode` lets through something `limit` would ask about. */
export const isWiderThan = (mode: RuntimeMode, limit: RuntimeMode): boolean =>
  RANK[mode] > RANK[limit];

/** The fields of a row the effective mode reads. */
export type ModeRow = Pick<ThreadShell, "id" | "runtimeMode" | "lineage">;

/**
 * The mode `thread` asks under: its own, narrowed by every ancestor's own mode up the lineage.
 * `lookup` finds a row by id; a missing parent or a loop ends the walk with what was read so far.
 */
export const effectiveMode = (
  thread: ModeRow,
  lookup: (threadId: ThreadId) => Option.Option<ModeRow>
): RuntimeMode => {
  const seen = new Set<ThreadId>([thread.id]);
  let mode = thread.runtimeMode;
  let parent = Option.map(thread.lineage, (lineage) => lineage.parentThreadId);

  while (Option.isSome(parent) && !seen.has(parent.value)) {
    seen.add(parent.value);

    const row = lookup(parent.value);

    if (Option.isNone(row)) {
      break;
    }

    mode = narrowerMode(mode, row.value.runtimeMode);
    parent = Option.map(row.value.lineage, (lineage) => lineage.parentThreadId);
  }

  return mode;
};

/** The ceiling a child's own mode may reach: its parent's effective mode; none for a top thread. */
export const modeCeiling = (
  thread: ModeRow,
  lookup: (threadId: ThreadId) => Option.Option<ModeRow>
): Option.Option<RuntimeMode> =>
  Option.flatMap(thread.lineage, (lineage) =>
    Option.map(lookup(lineage.parentThreadId), (parent) =>
      effectiveMode(parent, lookup)
    )
  );

/**
 * True when setting `thread`'s own mode to `next` would widen it past its parent, which
 * `thread.configure` refuses. A top thread may take any mode.
 */
export const widensPastParent = (
  thread: ModeRow,
  next: RuntimeMode,
  lookup: (threadId: ThreadId) => Option.Option<ModeRow>
): boolean =>
  Option.exists(modeCeiling(thread, lookup), (ceiling) =>
    isWiderThan(next, ceiling)
  );

/** The modes `thread` may be set to, in order: every mode up to its parent's effective mode. */
export const allowedModes = (
  thread: ModeRow,
  lookup: (threadId: ThreadId) => Option.Option<ModeRow>
): ReadonlyArray<RuntimeMode> =>
  Option.match(modeCeiling(thread, lookup), {
    onNone: () => RUNTIME_MODE_ORDER,
    onSome: (ceiling) =>
      RUNTIME_MODE_ORDER.filter((mode) => !isWiderThan(mode, ceiling)),
  });

/** A lookup over a list of rows, for callers that hold the shell's threads. */
export const lookupIn =
  (threads: ReadonlyArray<ModeRow>) =>
  (threadId: ThreadId): Option.Option<ModeRow> =>
    Option.fromUndefinedOr(threads.find((thread) => thread.id === threadId));
