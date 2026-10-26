// The bridge's stop hook: a stopped thread's Claude Code children are killed. pi-durable aborts the
// run's generation, but a child held on a tool call outlives it (its query waits for the tool's
// result), so without this the child would keep its session and its memory until the idle time to
// live. The killed sessions are forked on their next call, so the thread resumes natively. Runs
// for both stops (keeping or clearing the queue); a thread with no live child is a no-op.

import type { ThreadId } from "@cairn/protocol/Ids";
import { Effect, Option } from "effect";

import { BridgeCwd } from "../brain/BridgeCwdExtension.ts";
import { BridgeProvider } from "../models/BridgeProvider.ts";
import type { StopHook } from "./StopHooks.ts";

/** Kills the Claude Code children of every provider session the thread used since boot. */
export const bridgeStopHook: StopHook<never, BridgeCwd> = {
  name: "claude-bridge abort",
  run: Effect.fn("BridgeStopHook.run")(function* (threadId: ThreadId) {
    const bridge = yield* BridgeProvider;

    if (Option.isNone(bridge.claude)) {
      return;
    }

    const claude = bridge.claude.value;
    const sessions = yield* BridgeCwd.use((cwd) => cwd.sessionsOf(threadId));

    yield* Effect.forEach(sessions, (sessionId) =>
      claude.abortConversation(sessionId)
    );

    if (sessions.length > 0) {
      yield* Effect.logInfo("claude bridge sessions aborted").pipe(
        Effect.annotateLogs({
          event: "claude_stop",
          threadId,
          sessions: sessions.length,
        })
      );
    }
  }),
};
