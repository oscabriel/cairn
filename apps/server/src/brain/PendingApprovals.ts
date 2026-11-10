// Which conversations hold a pending record in `cairn.approvals`. Conversations are never
// deleted (ADR 0016), so reading every one's records is the cost that grows with the store: the
// boot sweeps (`cancelAbandonedApprovalsAtBoot`, `expireLapsedApprovalsAtBoot`) and every
// `inspect()` (the boot reconcile, each thread refresh) want only the conversations that hold a
// pending record. The brain scans every conversation once, the first time it is asked, and keeps
// the answer from then on by the commits it sees, so each later reader reads the records of those
// conversations alone. The same scan reads each conversation's `pi.live` too, for the threads whose
// newest run failed with no run since, which `inspect()` reports (server-edges.V5).
// `PiDurableHarness` provides it beside the seam.

import type { ConversationId } from "@earendil-works/pi-durable";
import type { Effect } from "effect";
import { Context } from "effect";

import type { HarnessError } from "./HarnessSeam.ts";

/** The conversations that hold a pending approval record, kept from one scan per process. */
export class PendingApprovals extends Context.Service<
  PendingApprovals,
  {
    /**
     * The conversations whose `cairn.approvals` holds a pending record now. The first call scans
     * every conversation; later calls answer from the commits seen since.
     */
    readonly conversations: Effect.Effect<
      ReadonlySet<ConversationId>,
      HarnessError
    >;
  }
>()("cairn/server/brain/PendingApprovals") {}
