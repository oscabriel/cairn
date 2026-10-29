import { NO_SUBAGENTS } from "@cairn/protocol/Subagents";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { hasLiveChildren, tallyOf, tallyOfRegistry } from "./SubagentTally.ts";

/** A registry item with only the fields the tally reads; every settlement delivered by default. */
const item = (
  status: string,
  outcomes: ReadonlyArray<string> = [],
  delivered = outcomes.length
) => ({
  threadId: "t",
  status,
  delivered,
  settlements: outcomes.map((outcome, index) => ({
    seq: index + 1,
    outcome,
    answerEntry: null,
    reportedAt: 0,
    inputs: [],
  })),
});

describe("SubagentTally", () => {
  it("counts each child by its status, a settled one by its latest settlement", () => {
    assert.deepStrictEqual(
      tallyOf([
        { status: "working", latest: Option.none(), undelivered: false },
        {
          status: "working",
          latest: Option.some("failed"),
          undelivered: false,
        },
        { status: "waiting", latest: Option.none(), undelivered: false },
        {
          status: "settled",
          latest: Option.some("completed"),
          undelivered: false,
        },
        {
          status: "settled",
          latest: Option.some("stopped"),
          undelivered: false,
        },
        {
          status: "settled",
          latest: Option.some("failed"),
          undelivered: false,
        },
      ]),
      { working: 2, asking: 1, settled: 2, failed: 1 }
    );
  });

  it("counts a settled child whose result is still on the way as working, so its parent stays live", () => {
    const tally = tallyOfRegistry({
      items: {
        "call-1": item("settled", ["completed"], 0),
        "call-2": item("settled", ["completed", "failed"], 1),
        "call-3": item("settled", ["completed"], 1),
      },
    });

    assert.deepStrictEqual(
      [tally, hasLiveChildren(tally)],
      [{ working: 2, asking: 0, settled: 1, failed: 0 }, true]
    );
  });

  it("reads a stored registry: a failed run then a completed one is settled, not failed", () => {
    assert.deepStrictEqual(
      tallyOfRegistry({
        items: {
          "call-1": item("settled", ["failed", "completed"]),
          "call-2": item("settled", ["completed", "failed"]),
          "call-3": item("waiting", ["completed"]),
          "call-4": item("working"),
        },
      }),
      { working: 1, asking: 1, settled: 1, failed: 1 }
    );
  });

  it("reads no children from a missing or unreadable registry, and skips items it cannot read", () => {
    assert.deepStrictEqual(
      [
        tallyOfRegistry(null),
        tallyOfRegistry({ items: [] }),
        tallyOfRegistry({
          items: { a: item("stopped"), b: 3, c: item("working") },
        }),
      ],
      [NO_SUBAGENTS, NO_SUBAGENTS, { ...NO_SUBAGENTS, working: 1 }]
    );
  });

  it("says children are live while any works or asks", () => {
    assert.deepStrictEqual(
      [
        hasLiveChildren(NO_SUBAGENTS),
        hasLiveChildren({ ...NO_SUBAGENTS, settled: 3, failed: 1 }),
        hasLiveChildren({ ...NO_SUBAGENTS, asking: 1 }),
        hasLiveChildren({ ...NO_SUBAGENTS, working: 1 }),
      ],
      [false, false, true, true]
    );
  });
});
