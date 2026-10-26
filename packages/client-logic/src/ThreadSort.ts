// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/threadSort.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the settled, pinned and active orders, the
// fractional pin-order keys and the reorder planners, with their tie-breaks. Changed: rows are
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

const PIN_ORDER_DIGITS = "abcdefghijklmnopqrstuvwxyz";

const MIN_DIGIT = "a";

const isValidPinOrderKey = (key: string): boolean =>
  key.length > 0 &&
  Array.every(Array.fromIterable(key), (char) =>
    PIN_ORDER_DIGITS.includes(char)
  ) &&
  // A trailing minimum digit would leave no room to sort a key just before this one; generators
  // never produce it, so it is treated as corrupt.
  !key.endsWith(MIN_DIGIT);

/**
 * The midpoint of two digit strings read as fractions in (0, 1); "" is the open bound on either
 * side. Requires `a < b` when `b` is not "".
 */
const pinOrderMidpoint = (a: string, b: string): string => {
  if (b !== "") {
    let shared = 0;

    while ((a.charAt(shared) || MIN_DIGIT) === b.charAt(shared)) {
      shared += 1;
    }

    if (shared > 0) {
      return (
        b.slice(0, shared) + pinOrderMidpoint(a.slice(shared), b.slice(shared))
      );
    }
  }

  const digitA = a === "" ? 0 : PIN_ORDER_DIGITS.indexOf(a.charAt(0));

  const digitB =
    b === "" ? PIN_ORDER_DIGITS.length : PIN_ORDER_DIGITS.indexOf(b.charAt(0));

  if (digitB - digitA > 1) {
    return PIN_ORDER_DIGITS.charAt(Math.round((digitA + digitB) / 2));
  }

  if (b.length > 1) {
    return b.charAt(0);
  }

  return PIN_ORDER_DIGITS.charAt(digitA) + pinOrderMidpoint(a.slice(1), "");
};

/**
 * A key that sorts strictly between two neighbours; none means "top of the block" or "bottom of
 * the keyed run". None when the existing keys are corrupt or out of order: callers then rewrite
 * the whole section.
 */
export const pinOrderKeyBetween = (
  before: Option.Option<string>,
  after: Option.Option<string>
): Option.Option<string> => {
  const a = Option.getOrElse(before, () => "");
  const b = Option.getOrElse(after, () => "");

  if (
    (a !== "" && !isValidPinOrderKey(a)) ||
    (b !== "" && !isValidPinOrderKey(b)) ||
    (b !== "" && a >= b)
  ) {
    return Option.none();
  }

  return Option.some(pinOrderMidpoint(a, b));
};

/** `count` keys spread evenly, each with room to insert before it. */
export const generateSpreadPinOrderKeys = (count: number): Array<string> => {
  const base = PIN_ORDER_DIGITS.length;
  let width = 2;
  let space = base ** width;

  while (space <= (count + 1) * 2) {
    width += 1;
    space *= base;
  }

  const step = space / (count + 1);

  const keys: Array<string> = [];

  for (let index = 0; index < count; index += 1) {
    let value = Math.round(step * (index + 1));

    if (value % base === 0) {
      value += 1;
    }

    let key = "";

    for (let digit = 0; digit < width; digit += 1) {
      key = PIN_ORDER_DIGITS.charAt(value % base) + key;
      value = Math.floor(value / base);
    }

    keys.push(key);
  }

  return keys;
};

/** One order-key write a reorder needs. */
export interface OrderKeyAssignment {
  readonly id: string;
  readonly orderKey: string;
}

/** What a reorder knows: the wanted order, every row's current key, and the row that moved. */
export interface PinnedReorderInput {
  readonly orderedIds: ReadonlyArray<string>;
  /** Includes the keys of hidden rows; only `orderedIds` receive writes. */
  readonly keysById: ReadonlyMap<string, Option.Option<string>>;
  readonly movedId: string;
}

const keyOf = (
  keysById: ReadonlyMap<string, Option.Option<string>>,
  id: string
): Option.Option<string> =>
  Option.flatten(Option.fromUndefinedOr(keysById.get(id)));

/**
 * The fewest key writes that make the rows sort as `orderedIds`: one write for the moved row when
 * its neighbours have keys, else a fresh spread for the whole section that skips hidden rows' keys.
 */
export const planPinnedReorder = (
  input: PinnedReorderInput
): ReadonlyArray<OrderKeyAssignment> => {
  const { orderedIds, keysById, movedId } = input;
  const visible = new Set(orderedIds);

  const reserved = new Set(
    Array.flatMap(Array.fromIterable(keysById.keys()), (id) =>
      visible.has(id) ? [] : Option.toArray(keyOf(keysById, id))
    )
  );

  const movedIndex = orderedIds.indexOf(movedId);

  if (movedIndex === -1) {
    return [];
  }

  const beforeId = Array.get(orderedIds, movedIndex - 1);
  const afterId = Array.get(orderedIds, movedIndex + 1);
  const beforeKey = Option.flatMap(beforeId, (id) => keyOf(keysById, id));
  const afterKey = Option.flatMap(afterId, (id) => keyOf(keysById, id));
  const beforeUsable = Option.isNone(beforeId) || Option.isSome(beforeKey);
  const afterUsable = Option.isNone(afterId) || Option.isSome(afterKey);

  if (beforeUsable && afterUsable) {
    let key = pinOrderKeyBetween(beforeKey, afterKey);

    while (Option.isSome(key) && reserved.has(key.value)) {
      key = pinOrderKeyBetween(key, afterKey);
    }

    if (Option.isSome(key)) {
      return [{ id: movedId, orderKey: key.value }];
    }
  }

  const keys = generateSpreadPinOrderKeys(orderedIds.length + reserved.size)
    .filter((key) => !reserved.has(key))
    .slice(0, orderedIds.length);

  return orderedIds.flatMap((id, index) => {
    const key = keys[index] ?? "";

    return Option.contains(keyOf(keysById, id), key)
      ? []
      : [{ id, orderKey: key }];
  });
};

/** A one-step move up or down; none when the row would fall off either end. */
export const planPinnedMove = (
  input: PinnedReorderInput & { readonly direction: "up" | "down" }
): Option.Option<ReadonlyArray<OrderKeyAssignment>> => {
  const { orderedIds, movedId, direction } = input;
  const from = orderedIds.indexOf(movedId);
  const to = direction === "up" ? from - 1 : from + 1;

  if (from === -1 || to < 0 || to >= orderedIds.length) {
    return Option.none();
  }

  const reordered = Array.insertAt(Array.remove(orderedIds, from), to, movedId);

  return Option.map(reordered, (order) =>
    planPinnedReorder({ ...input, orderedIds: order })
  );
};
