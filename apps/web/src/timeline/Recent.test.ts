// Per-thread caches keep the most recent threads only (T50): opening 25 threads keeps 20, and a
// thread used again moves to the recent end instead of being forgotten first.

import { describe, expect, it } from "@effect/vitest";

import { SAVED_THREAD_LIMIT } from "./Model.ts";
import { setRecent } from "./Rows.ts";

describe(setRecent, () => {
  it("forgets the least recently set threads beyond the saved limit", () => {
    const map = new Map<string, number>();

    for (let n = 0; n < 25; n += 1) {
      setRecent(map, `t${n}`, n);

      if (n === 10) {
        // t0 used again: it is now more recent than t1 to t10.
        setRecent(map, "t0", 0);
      }
    }

    expect(map.size).toBe(SAVED_THREAD_LIMIT);
    expect(map.has("t0")).toBeTruthy();
    expect(map.has("t1")).toBeFalsy();
    expect(map.has("t24")).toBeTruthy();
  });
});
