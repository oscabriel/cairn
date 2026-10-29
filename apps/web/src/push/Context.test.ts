import {
  asking,
  EARLIER,
  NOW,
  shellRow,
} from "@cairn/client-logic/ShellRowTestKit";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { pushContextOf } from "./Context.ts";

const contextOf = (threads: Array<Parameters<typeof shellRow>[1]>) =>
  pushContextOf({
    epoch: 1,
    hasClient: true,
    hello: Option.none(),
    openThreadId: Option.none(),
    shell: Option.some({
      snapshotSequence: 1,
      projects: [],
      threads: threads.map((overrides, index) =>
        shellRow(index + 1, overrides)
      ),
    }),
  });

describe("push context", () => {
  it("badges a waiting request the way the push does, beside an unseen result", () => {
    assert.strictEqual(contextOf([asking("q-1")]).badge, 1);
    assert.strictEqual(
      contextOf([
        asking("q-1"),
        {
          latestRunCompletedAt: Option.some(NOW),
          lastVisitedAt: Option.some(EARLIER),
        },
        {},
      ]).badge,
      2
    );
  });

  it("badges nothing before the shell arrives", () => {
    assert.strictEqual(
      pushContextOf({
        epoch: 1,
        hasClient: true,
        hello: Option.none(),
        openThreadId: Option.none(),
        shell: Option.none(),
      }).badge,
      0
    );
  });
});
