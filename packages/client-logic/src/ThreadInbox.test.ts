// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/threadInbox.test.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the send-order case. Removed: the return tracker
// cases (the tracker is not ported). Added: what "working" means on Cairn's rows, and the return
// order with an observed return time.
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
import { ApprovalId, ThreadId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import {
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "./ThreadInbox.ts";

const time = (iso: string) => DateTime.makeUnsafe(iso);

const some = (iso: string) => Option.some(time(iso));

const row = (id: string) => ({
  id: ThreadId.make(id),
  createdAt: time("2026-06-01T00:00:00.000Z"),
  unsettledAt: Option.none<DateTime.Utc>(),
  latestUserMessageAt: Option.none<DateTime.Utc>(),
  latestRunRequestedAt: Option.none<DateTime.Utc>(),
  latestRunCompletedAt: Option.none<DateTime.Utc>(),
});

describe(isThreadWorking, () => {
  it("is true while the agent is busy and nothing waits on the user", () => {
    for (const activity of ["preparing", "running", "waiting"] as const) {
      assert.isTrue(
        isThreadWorking({ activity, pendingRuntimeRequest: Option.none() })
      );
    }

    for (const activity of ["idle", "parked", "failed"] as const) {
      assert.isFalse(
        isThreadWorking({ activity, pendingRuntimeRequest: Option.none() })
      );
    }
  });

  it("is false while a request waits on the user", () => {
    assert.isFalse(
      isThreadWorking({
        activity: "running",
        pendingRuntimeRequest: Option.some({
          id: ApprovalId.make("apr_1"),
          kind: "tool-call",
          createdAt: time("2026-06-01T00:00:00.000Z"),
        }),
      })
    );
  });
});

describe(sortWorkingThreadsBySend, () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...row("01890a5d-ac96-774b-bcce-b302099a8001"),
      latestUserMessageAt: some("2026-06-01T01:00:00.000Z"),
      latestRunRequestedAt: some("2026-06-01T04:00:00.000Z"),
    };

    const sentLast = {
      ...row("01890a5d-ac96-774b-bcce-b302099a8002"),
      latestUserMessageAt: some("2026-06-01T02:00:00.000Z"),
    };

    const launched = row("01890a5d-ac96-774b-bcce-b302099a8003");

    assert.deepStrictEqual(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]),
      [sentLast, sentFirst, launched]
    );
  });
});

describe(sortInboxThreadsByReturn, () => {
  it("orders by the latest return, including one this client observed", () => {
    const completedLate = {
      ...row("01890a5d-ac96-774b-bcce-b302099a8001"),
      latestRunCompletedAt: some("2026-06-01T03:00:00.000Z"),
    };

    const observed = row("01890a5d-ac96-774b-bcce-b302099a8002");
    const quiet = row("01890a5d-ac96-774b-bcce-b302099a8003");

    assert.deepStrictEqual(
      sortInboxThreadsByReturn([quiet, completedLate, observed], (thread) =>
        thread === observed
          ? Option.some(Date.parse("2026-06-01T05:00:00.000Z"))
          : Option.none()
      ),
      [observed, completedLate, quiet]
    );
  });
});
