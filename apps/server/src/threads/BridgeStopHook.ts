// The bridge's stop hook: a stopped thread's Claude Code children are killed. pi-durable aborts the
// run's generation, but a child held on a tool call outlives it (its query waits for the tool's
// result, and holds its conversation so it is never evicted), so without this the child would keep
// its session and its memory until the bridge's held time to live. The killed sessions are forked
// on their next call, so the thread resumes natively. Runs for every interrupted run, whoever
// stopped it; a thread with no live child is a no-op, and a later run's child (a provider call
// open on it, or held since the run ended) is left alone.

import type { ThreadId } from "@cairn/protocol/Ids";
import { DateTime, Effect, Option } from "effect";

import { BridgeCwd } from "../models/BridgeCwdExtension.ts";
import { BridgeProvider } from "../models/BridgeProvider.ts";
import type { StopHook } from "./StopHooks.ts";

/** Kills the Claude Code children of every provider session the thread used since boot. */
export const bridgeStopHook: StopHook<never, BridgeCwd> = {
  name: "claude-bridge abort",
  run: Effect.fn("BridgeStopHook.run")(function* (
    threadId: ThreadId,
    stoppedAt: DateTime.Utc
  ) {
    const bridge = yield* BridgeProvider;

    if (Option.isNone(bridge.claude)) {
      return;
    }

    const claude = bridge.claude.value;
    const sessions = yield* BridgeCwd.use((cwd) => cwd.sessionsOf(threadId));

    yield* Effect.forEach(sessions, (sessionId) =>
      claude.abortConversation(sessionId, DateTime.toEpochMillis(stoppedAt))
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
