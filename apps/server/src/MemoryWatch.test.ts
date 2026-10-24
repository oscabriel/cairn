// When the memory watch logs a peak: the first reading, then only one past the last by the step.
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { MEMORY_PEAK_STEP, nextPeak } from "./MemoryWatch.ts";
import type { MemorySample } from "./MemoryWatch.ts";

const mb = 1024 * 1024;

const reading = (
  cgroup: Option.Option<number>,
  rss = 200 * mb
): MemorySample => ({
  rss,
  heapUsed: 100 * mb,
  external: 10 * mb,
  arrayBuffers: 5 * mb,
  cgroup,
});

describe("the memory watch", () => {
  it("logs the first reading, then only a reading past the last logged peak by the step", () => {
    const first = nextPeak(Option.none(), reading(Option.some(300 * mb)));

    expect([
      first,
      nextPeak(first, reading(Option.some(300 * mb + MEMORY_PEAK_STEP - 1))),
      nextPeak(first, reading(Option.some(300 * mb + MEMORY_PEAK_STEP))),
      nextPeak(first, reading(Option.some(100 * mb))),
    ]).toStrictEqual([
      Option.some(300 * mb),
      Option.none(),
      Option.some(300 * mb + MEMORY_PEAK_STEP),
      Option.none(),
    ]);
  });

  it("measures the process's own memory outside a cgroup", () => {
    expect(
      nextPeak(Option.none(), reading(Option.none(), 250 * mb))
    ).toStrictEqual(Option.some(250 * mb));
  });
});
