// The `bridge-cwd` extension: before every request attempt (recovery included) of a conversation on
// a `claude-bridge` model, it tells the bridge where that conversation runs and which thread it is,
// so the Claude Code child starts in the realpath of the thread's own cwd (plan D6) and the bridge
// can report the thread waiting for a generation slot. pi's provider call carries no cwd, and one
// Harness serves every thread, so a per-request hook is the only place that knows both the
// conversation's `pi.agent` cwd and its `pi.provider` session id.
//
// It also remembers which provider session ids each thread used since boot, which is how a stop
// reaches the bridge: `BridgeStopHook` kills those sessions' children, because a Claude Code query
// held on a tool call outlives the generation pi-durable aborted.
//
// The extension is installed whether or not the bridge is on, so switching the bridge off never
// changes the extension set (footgun "moving default selections"); off, the hook does nothing.
// The hook runs Effects through one runtime made from the layer's scope (S43): interrupted when the
// brain closes, and logging through the brain's logger.
import { ThreadId } from "@cairn/protocol/Ids";
import type { Context as ChordContext } from "@earendil-works/chord";
import type { HookApi } from "@earendil-works/pi-durable";
import {
  AgentDoc,
  defineExtension,
  GenerationTask,
  hook,
  ProviderDoc,
} from "@earendil-works/pi-durable";
import { Context, Effect, FiberSet, Layer, Option, Ref, Schema } from "effect";

import { BridgeProvider } from "../models/BridgeProvider.ts";
import { BRIDGE_PROVIDER } from "../models/HarnessSettings.ts";
import { ThreadMeta } from "./CairnDocs.ts";
import { ExtensionOrder } from "./Extensions.ts";
import type { CairnExtension } from "./Extensions.ts";

/** The extension's name in pi-durable's registry. */
export const BRIDGE_CWD_EXTENSION = "cairn.bridge-cwd";

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** Where one bridge request runs, as the conversation's documents say. */
export interface BridgePlace {
  readonly sessionId: string;
  readonly cwd: string;
  readonly threadId: Option.Option<ThreadId>;
}

/**
 * Reads the place of the conversation `api` belongs to: none unless its model is a bridge model
 * and it has a cwd and a provider session id.
 */
const placeOf = async (
  api: HookApi,
  context: ChordContext
): Promise<Option.Option<BridgePlace>> => {
  const agent = await api.snapshot(AgentDoc, api.conversationId, context);

  if (
    agent?.model?.provider !== BRIDGE_PROVIDER ||
    agent.cwd === undefined ||
    agent.cwd === ""
  ) {
    return Option.none();
  }

  const provider = await api.snapshot(ProviderDoc, api.conversationId, context);

  if (provider === undefined) {
    return Option.none();
  }

  const meta = await api.snapshot(ThreadMeta, api.conversationId, context);

  return Option.some({
    sessionId: provider.sessionId,
    cwd: agent.cwd,
    threadId: decodeThreadId(meta?.threadId),
  });
};

/** How many provider sessions a thread keeps: a compaction or a fork starts a new one. */
export const SESSIONS_PER_THREAD = 8;

/** How many threads keep their sessions; the least recently used is dropped first. */
export const THREADS_KEPT = 256;

/**
 * Records `sessionId` as `threadId`'s most recent session, bounded on both axes, so a brain that
 * runs for months does not grow the map or the stop hook's abort list.
 */
export const rememberSession = (
  all: ReadonlyMap<ThreadId, ReadonlyArray<string>>,
  threadId: ThreadId,
  sessionId: string
): ReadonlyMap<ThreadId, ReadonlyArray<string>> => {
  const known = all.get(threadId) ?? [];

  if (known.at(-1) === sessionId) {
    return all;
  }

  const next = new Map(all);

  // Deleted and set again, so the map's order is least recently used first.
  next.delete(threadId);
  next.set(
    threadId,
    [...known.filter((id) => id !== sessionId), sessionId].slice(
      -SESSIONS_PER_THREAD
    )
  );

  for (const oldest of next.keys()) {
    if (next.size <= THREADS_KEPT) {
      break;
    }

    next.delete(oldest);
  }

  return next;
};

/** The `bridge-cwd` extension and the sessions it has seen. */
export class BridgeCwd extends Context.Service<
  BridgeCwd,
  {
    /** The extension, for the installed set. */
    readonly extension: CairnExtension;
    /** Records `place` with the bridge: what the hook does before each bridge request. */
    note(place: BridgePlace): Effect.Effect<void>;
    /**
     * The provider session ids `threadId` ran bridge requests under since boot, oldest first: the
     * last `SESSIONS_PER_THREAD`, for the last `THREADS_KEPT` threads that used the bridge.
     */
    sessionsOf(threadId: ThreadId): Effect.Effect<ReadonlyArray<string>>;
  }
>()("cairn/server/brain/BridgeCwdExtension/BridgeCwd") {
  /** Over the brain's `BridgeProvider`. */
  static readonly layer = Layer.effect(
    BridgeCwd,
    Effect.gen(function* () {
      const bridge = yield* BridgeProvider;
      const run = yield* FiberSet.makeRuntimePromise();

      const sessions = yield* Ref.make<
        ReadonlyMap<ThreadId, ReadonlyArray<string>>
      >(new Map());

      const note = Effect.fn("BridgeCwd.note")(function* (place: BridgePlace) {
        if (Option.isNone(bridge.claude)) {
          return;
        }

        if (Option.isSome(place.threadId)) {
          const threadId = place.threadId.value;

          yield* Ref.update(sessions, (all) =>
            rememberSession(all, threadId, place.sessionId)
          );
        }

        yield* bridge.claude.value.noteConversation(place.sessionId, {
          cwd: place.cwd,
          threadId: place.threadId,
        });
      });

      const sessionsOf = (threadId: ThreadId) =>
        Effect.map(Ref.get(sessions), (all) => all.get(threadId) ?? []);

      const extension = defineExtension({
        name: BRIDGE_CWD_EXTENSION,
        hooks: [
          hook(GenerationTask, {
            beforeRequest: async (_request, api, context) => {
              const place = Option.isSome(bridge.claude)
                ? await placeOf(api, context)
                : Option.none<BridgePlace>();

              if (Option.isSome(place)) {
                await run(note(place.value));
              }
            },
          }),
        ],
      });

      return BridgeCwd.of({
        extension: { order: ExtensionOrder.bridgeCwd, extension },
        note,
        sessionsOf,
      });
    })
  );
}
