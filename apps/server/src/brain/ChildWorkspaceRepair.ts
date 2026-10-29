// The boot repair for child workspaces (docs/phase-2/notes/subagents.md sections 6 and 10). A
// spawn writes its worktree plan, makes the worktree, then commits the child; a crash before that
// commit leaves a plan, and maybe a worktree and a branch, for a child that does not exist. Before
// the Harness resumes, this finds each such plan by the missing `cairn.thread` receipt of its child
// and hands it to `ChildWorkspaces.repair`, which removes what git made unless it holds work.
//
// A rerun of the interrupted spawn after boot plans and makes the same worktree again, since the
// branch and path come from the child's thread id. A receipt that cannot be read counts as landed,
// so a read failure never removes anything.

import type { ThreadId } from "@cairn/protocol/Ids";
import { Effect, Option } from "effect";

import { ChildWorkspaces } from "../workspaces/ChildWorkspaces.ts";
import { Brain } from "./Brain.ts";
import { ThreadReceipt } from "./CairnDocs.ts";
import { durable } from "./Durable.ts";

/**
 * Repairs child workspaces whose spawn never landed. A brain with no pi-durable (the scripted
 * harness) has no receipts to read and nothing to repair, so it skips.
 */
export const repairChildWorkspacesAtBoot = Effect.gen(function* () {
  const found = yield* Effect.serviceOption(Brain);

  if (Option.isNone(found)) {
    return;
  }

  const { harness } = yield* found.value.session;
  const workspaces = yield* ChildWorkspaces;

  const landed = (child: ThreadId) =>
    durable(
      "receipt.read",
      async (context) => await harness.snapshot(ThreadReceipt, child, context)
    ).pipe(
      Effect.map(
        (receipt) => receipt !== undefined && receipt.conversationId > 0
      ),
      Effect.catchTag("DurableCallError", (failure) =>
        Effect.logWarning("child workspace receipt unreadable").pipe(
          Effect.annotateLogs({
            event: "child_workspace_receipt_unreadable",
            child,
            cause: failure.message,
          }),
          Effect.as(true)
        )
      )
    );

  yield* workspaces.repair(landed);
});
