// The client's copy of one thread's projected view, kept by applying the thread stream: a snapshot
// replaces it, ops change it through chord's immutable applier. Ops arrive from the brain but their
// paths can echo model output, so every op is checked before it is applied: chord refuses
// prototype-reaching segments, and this module refuses splices and permutations whose indices do
// not fit the array they address. A refused op leaves the view untouched and asks the caller to
// resubscribe, which always brings a fresh snapshot.
//
// The view may be a window: `entriesOffset` older active entries are left out, and op indices count
// from the window's start. Pages from `thread.history` are kept apart, in `older`, so they never
// shift the indices ops address.
import type {
  Entry,
  HistoryPage,
  Op,
  ThreadStreamItem,
} from "@cairn/protocol/Thread";
import { ConversationView } from "@cairn/protocol/Thread";
import { applyImmutable } from "@earendil-works/chord/delta";
import type { Op as ChordOp } from "@earendil-works/chord/delta";
import { Match, Option, Predicate, Result, Schema } from "effect";

/** Why an item could not be applied. Every reason is answered by resubscribing. */
export class ThreadViewError extends Schema.TaggedError<ThreadViewError>()(
  "ThreadViewError",
  {
    message: Schema.String,
    reason: Schema.Literals([
      /** Ops arrived before any snapshot. */
      "no_snapshot",
      /** An item's `seq` did not move forward. */
      "out_of_order",
      /** An op's path reached the prototype chain, did not resolve, or indexed past an array. */
      "unsafe_path",
      /** The ops left something that is not a conversation view. */
      "malformed_view",
    ]),
  }
) {}

/** One thread's view on the client. */
export interface ThreadViewState {
  /** The `seq` of the last item applied. */
  readonly seq: number;
  readonly view: ConversationView;
  /** Active entries before `view.entries` that the window leaves out. */
  readonly entriesOffset: number;
  readonly hasMoreHistory: boolean;
  /** Entries paged in by `thread.history`, oldest first, ending right before the window. */
  readonly older: ReadonlyArray<Entry>;
}

const isConversationView = Schema.is(ConversationView);

const refuse = (reason: ThreadViewError["reason"], message: string) =>
  Result.fail(new ThreadViewError({ reason, message }));

/** Follows `path` through plain objects and arrays; none when a segment does not resolve. */
const resolve = (
  root: ConversationView,
  path: ReadonlyArray<string | number>
) => {
  let current: Option.Option<unknown> = Option.some(root);

  for (const segment of path) {
    current = Option.flatMap(current, (value) => {
      if (Array.isArray(value) && Predicate.isNumber(segment)) {
        return Option.fromUndefinedOr(value[segment]);
      }

      if (
        Predicate.isString(segment) &&
        Predicate.hasProperty(value, segment) &&
        Object.hasOwn(value, segment)
      ) {
        return Option.some(value[segment]);
      }

      return Option.none();
    });
  }

  return current;
};

/** True when a splice or permutation fits the array at its path. Other verbs are checked by chord. */
const indicesFit = (view: ConversationView, op: Op): boolean => {
  if (op[0] === "p") {
    const [, path, at, remove] = op;

    return Option.exists(
      resolve(view, path),
      (target) => Array.isArray(target) && at + remove <= target.length
    );
  }

  if (op[0] === "m") {
    const [, path, permutation] = op;

    return Option.exists(
      resolve(view, path),
      (target) =>
        Array.isArray(target) &&
        permutation.length === target.length &&
        new Set(permutation).size === permutation.length &&
        permutation.every((index) => index < target.length)
    );
  }

  return true;
};

/** Applies one op, checking it against the value it will change. */
const applyOp = (
  current: ConversationView,
  op: Op
): Result.Result<ConversationView, ThreadViewError> => {
  if (!indicesFit(current, op)) {
    return refuse(
      "unsafe_path",
      `An op indexed past the array at its path: ${JSON.stringify(op.slice(0, 2))}.`
    );
  }

  // SAFETY: `Op` is chord's op decoded by the protocol's schema, with readonly arrays where
  // chord's type has mutable ones; `applyImmutable` copies every container it changes and never
  // writes to the op.
  // Verified by: ThreadView.test.ts "applies ops without mutating the previous view"
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const chordOp = op as ChordOp;

  const next = Result.try({
    try: () => applyImmutable<unknown>(current, [chordOp]),
    catch: (cause) =>
      new ThreadViewError({
        reason: "unsafe_path",
        message: `An op was refused by the applier: ${Predicate.hasProperty(cause, "message") ? String(cause.message) : "unknown reason"}.`,
      }),
  });

  if (Result.isFailure(next)) {
    return Result.fail(next.failure);
  }

  // Root and top-level changes can replace the view's structure; deeper ones cannot.
  const reachesTopLevel =
    op[0] === "r" || (op[0] !== "p" && op[0] !== "m" && op[1].length <= 1);

  if (reachesTopLevel && !isConversationView(next.success)) {
    return refuse(
      "malformed_view",
      "The ops left a value that is not a conversation view."
    );
  }

  // SAFETY: `current` was a ConversationView and this op changed it below the top level, or the
  // result was just checked with `Schema.is(ConversationView)`; JSON ops cannot change the type of
  // a value they do not reach.
  // Verified by: ThreadView.test.ts "refuses ops that would break the view's shape"
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return Result.succeed(next.success as ConversationView);
};

/** Applies a batch of ops in order; the first refused op refuses the batch. */
const applyOps = (
  view: ConversationView,
  ops: ReadonlyArray<Op>
): Result.Result<ConversationView, ThreadViewError> => {
  let current = view;

  for (const op of ops) {
    const next = applyOp(current, op);

    if (Result.isFailure(next)) {
      return next;
    }

    current = next.success;
  }

  return Result.succeed(current);
};

/**
 * Applies one thread stream item. A snapshot always succeeds and replaces everything, history
 * included; ops need a snapshot first and a `seq` that moves forward.
 */
export const applyThreadStreamItem = (
  state: Option.Option<ThreadViewState>,
  item: ThreadStreamItem
): Result.Result<ThreadViewState, ThreadViewError> =>
  Match.valueTags(item, {
    Snapshot: ({ entriesOffset, hasMoreHistory, seq, view }) =>
      Result.succeed({ seq, view, entriesOffset, hasMoreHistory, older: [] }),
    Ops: ({ ops, seq }) => {
      if (Option.isNone(state)) {
        return refuse("no_snapshot", "Ops arrived before the first snapshot.");
      }

      if (seq <= state.value.seq) {
        return refuse(
          "out_of_order",
          `Ops seq ${seq} did not move past ${state.value.seq}.`
        );
      }

      return Result.map(applyOps(state.value.view, ops), (view) => ({
        ...state.value,
        seq,
        view,
      }));
    },
  });

/** Adds an older page from `thread.history` in front of what the client holds. */
export const prependHistory = (
  state: ThreadViewState,
  page: HistoryPage
): ThreadViewState => ({
  ...state,
  older: [...page.entries, ...state.older],
  entriesOffset: Math.max(0, state.entriesOffset - page.entries.length),
  hasMoreHistory: page.hasMore,
});

/** Every entry the client holds, oldest first: paged history, then the window. */
export const threadEntries = (state: ThreadViewState): ReadonlyArray<Entry> => [
  ...state.older,
  ...state.view.entries,
];

/** The entry id to page history back from: the oldest entry the client holds. */
export const historyCursor = (
  state: ThreadViewState
): Option.Option<Entry["id"]> =>
  Option.map(
    Option.fromUndefinedOr(threadEntries(state)[0]),
    (entry) => entry.id
  );
