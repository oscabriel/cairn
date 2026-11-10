// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/threadSort.test.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the settled, pinned and active order cases.
// Removed: the pin-order key and planner cases, which went with the classic sidebar (ADR 0050);
// malformed timestamp cases (Cairn's times are decoded `DateTime`s), environment tie-breaks (one
// environment), and `sortThreads` and `getLatestThreadForProject`, which Cairn's sidebar does not
// use.
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

import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import {
  activeThreadAnchorTimestampMs,
  resolveSettledThreadTimestamp,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "./ThreadSort.ts";
import type { SettledSortInput } from "./ThreadSort.ts";

const time = (iso: string) => DateTime.makeUnsafe(iso);

const some = (iso: string) => Option.some(time(iso));

const settled = (
  input: Partial<SettledSortInput> & { readonly id: string }
): SettledSortInput => ({
  settledAt: Option.none(),
  latestUserMessageAt: Option.none(),
  latestRunRequestedAt: Option.none(),
  latestRunStartedAt: Option.none(),
  latestRunCompletedAt: Option.none(),
  updatedAt: time("2026-03-09T09:00:00.000Z"),
  ...input,
});

describe(activeThreadAnchorTimestampMs, () => {
  it("uses the later unsettle time when an old thread re-enters the active list", () => {
    assert.strictEqual(
      activeThreadAnchorTimestampMs({
        createdAt: time("2026-01-01T00:00:00.000Z"),
        unsettledAt: some("2026-08-01T00:00:00.000Z"),
      }),
      Date.parse("2026-08-01T00:00:00.000Z")
    );
  });
});

describe(resolveSettledThreadTimestamp, () => {
  it("prefers the persisted settlement stamp over later activity", () => {
    const stamp = resolveSettledThreadTimestamp(
      settled({
        id: "a",
        settledAt: some("2026-03-09T10:00:00.000Z"),
        latestUserMessageAt: some("2026-03-09T11:00:00.000Z"),
        updatedAt: time("2026-03-09T12:00:00.000Z"),
      })
    );

    assert.strictEqual(DateTime.formatIso(stamp), "2026-03-09T10:00:00.000Z");
  });

  it("falls back to the latest activity, then to the last update", () => {
    assert.strictEqual(
      DateTime.formatIso(
        resolveSettledThreadTimestamp(
          settled({
            id: "a",
            latestUserMessageAt: some("2026-03-09T11:00:00.000Z"),
            updatedAt: time("2026-03-09T12:00:00.000Z"),
          })
        )
      ),
      "2026-03-09T11:00:00.000Z"
    );
    assert.strictEqual(
      DateTime.formatIso(
        resolveSettledThreadTimestamp(
          settled({ id: "a", updatedAt: time("2026-03-09T12:00:00.000Z") })
        )
      ),
      "2026-03-09T12:00:00.000Z"
    );
  });
});

const settledIds = (threads: ReadonlyArray<SettledSortInput>) =>
  sortSettledThreads(threads).map((thread) => thread.id);

describe(sortSettledThreads, () => {
  it("orders by settle time, most recently settled first", () => {
    assert.deepStrictEqual(
      settledIds([
        settled({
          id: "settled-first",
          settledAt: some("2026-03-09T10:00:00.000Z"),
          latestUserMessageAt: some("2026-03-09T09:59:00.000Z"),
        }),
        settled({
          id: "settled-last",
          settledAt: some("2026-03-09T12:00:00.000Z"),
          latestUserMessageAt: some("2026-03-09T08:00:00.000Z"),
        }),
      ]),
      ["settled-last", "settled-first"]
    );
  });

  it("falls back to last activity for auto-settled threads without a stamp", () => {
    assert.deepStrictEqual(
      settledIds([
        settled({
          id: "auto-old",
          latestUserMessageAt: some("2026-03-09T08:00:00.000Z"),
        }),
        settled({
          id: "explicit",
          settledAt: some("2026-03-09T10:00:00.000Z"),
        }),
        settled({
          id: "auto-recent",
          latestUserMessageAt: some("2026-03-09T11:00:00.000Z"),
        }),
      ]),
      ["auto-recent", "explicit", "auto-old"]
    );
  });

  it("counts a run completion as activity for auto-settled threads", () => {
    assert.deepStrictEqual(
      settledIds([
        settled({
          id: "message-only",
          latestUserMessageAt: some("2026-03-09T10:04:00.000Z"),
        }),
        settled({
          id: "completed-later",
          latestUserMessageAt: some("2026-03-09T10:00:00.000Z"),
          latestRunRequestedAt: some("2026-03-09T10:00:00.000Z"),
          latestRunStartedAt: some("2026-03-09T10:00:00.000Z"),
          latestRunCompletedAt: some("2026-03-09T10:30:00.000Z"),
        }),
      ]),
      ["completed-later", "message-only"]
    );
  });

  it("breaks timestamp ties by id so the order is stable", () => {
    assert.deepStrictEqual(
      settledIds([
        settled({ id: "b", settledAt: some("2026-03-09T10:00:00.000Z") }),
        settled({ id: "a", settledAt: some("2026-03-09T10:00:00.000Z") }),
      ]),
      ["a", "b"]
    );
  });
});

describe(sortPinnedThreadsByOrderKey, () => {
  it("puts keyed rows by key first, then keyless rows newest first", () => {
    const sorted = sortPinnedThreadsByOrderKey([
      {
        id: "old-keyless",
        createdAt: time("2026-03-09T08:00:00.000Z"),
        pinOrderKey: Option.none(),
      },
      {
        id: "keyed-t",
        createdAt: time("2026-03-09T09:00:00.000Z"),
        pinOrderKey: Option.some("t"),
      },
      {
        id: "new-keyless",
        createdAt: time("2026-03-09T12:00:00.000Z"),
        pinOrderKey: Option.none(),
      },
      {
        id: "keyed-f",
        createdAt: time("2026-03-09T10:00:00.000Z"),
        pinOrderKey: Option.some("f"),
      },
    ]);

    assert.deepStrictEqual(
      sorted.map((thread) => thread.id),
      ["keyed-f", "keyed-t", "new-keyless", "old-keyless"]
    );
  });
});

const row = (
  id: string,
  createdAt: string,
  activeOrderKey: string | null,
  unsettledAt: string | null = null
) => ({
  id,
  createdAt: time(createdAt),
  unsettledAt: Option.map(Option.fromNullOr(unsettledAt), time),
  activeOrderKey: Option.fromNullOr(activeOrderKey),
});

describe(sortActiveThreadsByOrderKey, () => {
  it("keeps new and reopened threads ahead of the saved order", () => {
    const sorted = sortActiveThreadsByOrderKey([
      row("arranged-first", "2026-03-09T09:00:00.000Z", "f"),
      row("new", "2026-03-09T11:00:00.000Z", null),
      row(
        "arranged-last",
        "2026-03-09T12:00:00.000Z",
        "t",
        "2026-03-09T13:00:00.000Z"
      ),
      row(
        "reopened",
        "2026-03-01T09:00:00.000Z",
        null,
        "2026-03-09T12:00:00.000Z"
      ),
    ]);

    assert.deepStrictEqual(
      sorted.map((thread) => thread.id),
      ["reopened", "new", "arranged-first", "arranged-last"]
    );
  });

  it("breaks equal order keys and timestamps by thread id", () => {
    for (const key of [null, "m"]) {
      const sorted = sortActiveThreadsByOrderKey([
        row("thread-b", "2026-03-09T10:00:00.000Z", key),
        row("thread-a", "2026-03-09T10:00:00.000Z", key),
      ]);

      assert.deepStrictEqual(
        sorted.map((thread) => thread.id),
        ["thread-a", "thread-b"]
      );
    }
  });
});
