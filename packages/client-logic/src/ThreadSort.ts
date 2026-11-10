// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/threadSort.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the settled, pinned and active orders, with their
// tie-breaks, which the shelf partition reads (`Sidebar.ts`); the fractional pin-order keys and the
// reorder planners went with the classic sidebar's drag and move (ADR 0050). Changed: rows are
// Cairn's shell rows (times are `DateTime.Utc`, optional fields are `Option`), so the malformed
// timestamp fallbacks are gone; one environment, so ties break by thread id alone; a key that
// cannot be placed is `Option.none()` rather than `null`.
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

import { Array, DateTime, Option, Order } from "effect";

/** Milliseconds since the epoch of an optional time, or `fallback` when there is none. */
const millisOr = (
  time: Option.Option<DateTime.Utc>,
  fallback: number
): number =>
  Option.match(time, {
    onNone: () => fallback,
    onSome: DateTime.toEpochMillis,
  });

/** The fields the settled shelf orders by. */
export interface SettledSortInput {
  readonly id: string;
  readonly settledAt: Option.Option<DateTime.Utc>;
  readonly latestUserMessageAt: Option.Option<DateTime.Utc>;
  readonly latestRunRequestedAt: Option.Option<DateTime.Utc>;
  readonly latestRunStartedAt: Option.Option<DateTime.Utc>;
  readonly latestRunCompletedAt: Option.Option<DateTime.Utc>;
  readonly updatedAt: DateTime.Utc;
}

/**
 * When a settled thread settled: its settle stamp, or for a thread settled automatically (no
 * stamp), its latest activity, or its last update.
 */
export const resolveSettledThreadTimestamp = (
  thread: SettledSortInput
): DateTime.Utc =>
  Option.getOrElse(
    Option.orElse(thread.settledAt, () =>
      Array.reduce(
        Array.getSomes([
          thread.latestUserMessageAt,
          thread.latestRunRequestedAt,
          thread.latestRunStartedAt,
          thread.latestRunCompletedAt,
        ]),
        Option.none<DateTime.Utc>(),
        (latest, candidate) =>
          Option.match(latest, {
            onNone: () => Option.some(candidate),
            onSome: (current) => Option.some(DateTime.max(current, candidate)),
          })
      )
    ),
    () => thread.updatedAt
  );

const byId = Order.mapInput(
  Order.String,
  (thread: { readonly id: string }) => thread.id
);

/** The settled shelf: most recently settled first, ties by id. */
export const sortSettledThreads = <T extends SettledSortInput>(
  threads: ReadonlyArray<T>
): Array<T> => {
  const stamped = threads.map((thread) => ({
    thread,
    at: DateTime.toEpochMillis(resolveSettledThreadTimestamp(thread)),
  }));

  type Stamped = (typeof stamped)[number];

  return Array.sort(
    stamped,
    Order.combine(
      Order.mapInput(Order.flip(Order.Number), (entry: Stamped) => entry.at),
      Order.mapInput(byId, (entry: Stamped) => entry.thread)
    )
  ).map((entry) => entry.thread);
};

/** The fields the active shelf orders by. */
export interface ActiveSortInput {
  readonly id: string;
  readonly createdAt: DateTime.Utc;
  readonly unsettledAt: Option.Option<DateTime.Utc>;
  readonly activeOrderKey: Option.Option<string>;
}

/** When a thread entered the active list: its creation, or its latest un-settle if later. */
export const activeThreadAnchorTimestampMs = (thread: {
  readonly createdAt: DateTime.Utc;
  readonly unsettledAt: Option.Option<DateTime.Utc>;
}): number =>
  Math.max(
    DateTime.toEpochMillis(thread.createdAt),
    millisOr(thread.unsettledAt, 0)
  );

const activeOrder =
  <T extends ActiveSortInput>(): Order.Order<T> =>
  (left, right) => {
    const order = Option.match(left.activeOrderKey, {
      onNone: () =>
        Option.match(right.activeOrderKey, {
          onNone: () =>
            Order.flip(Order.Number)(
              activeThreadAnchorTimestampMs(left),
              activeThreadAnchorTimestampMs(right)
            ),
          onSome: () => -1 as const,
        }),
      onSome: (leftKey) =>
        Option.match(right.activeOrderKey, {
          onNone: () => 1 as const,
          onSome: (rightKey) => Order.String(leftKey, rightKey),
        }),
    });

    return order === 0 ? byId(left, right) : order;
  };

/**
 * The active shelf. Rows without an order key (new or just reopened) come first, newest first;
 * then the arranged rows by key. Activity never reorders the list.
 */
export const sortActiveThreadsByOrderKey = <T extends ActiveSortInput>(
  threads: ReadonlyArray<T>
): Array<T> => Array.sort(threads, activeOrder<T>());

/** The fields the pinned shelf orders by. */
export interface PinnedSortInput {
  readonly id: string;
  readonly createdAt: DateTime.Utc;
  readonly pinOrderKey: Option.Option<string>;
}

/** The pinned shelf: rows with a pin-order key by key, then the rest newest first. */
export const sortPinnedThreadsByOrderKey = <T extends PinnedSortInput>(
  threads: ReadonlyArray<T>
): Array<T> => {
  const keyed = Array.filter(threads, (thread) =>
    Option.isSome(thread.pinOrderKey)
  );

  const keyless = Array.filter(threads, (thread) =>
    Option.isNone(thread.pinOrderKey)
  );

  const sortedKeyed = Array.sort(
    keyed,
    Order.combine(
      Order.mapInput(Order.String, (thread: T) =>
        Option.getOrElse(thread.pinOrderKey, () => "")
      ),
      byId
    )
  );

  const sortedKeyless = Array.sort(
    keyless,
    Order.combine(
      Order.mapInput(Order.flip(Order.Number), (thread: T) =>
        DateTime.toEpochMillis(thread.createdAt)
      ),
      byId
    )
  );

  return [...sortedKeyed, ...sortedKeyless];
};
