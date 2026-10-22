// The Claude bridge as one Effect service: the `claude-bridge` pi-ai provider, the conversations
// behind it, and the controls the brain needs. Ported in intent from cairn-v1 apps/server/src/Claude.ts
// and the ClaudeBridge class of apps/server/src/claude/conversation.ts at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0 (Cairn's own code). Changed: conversations live in an
// `RcMap` keyed by pi's provider session id, with a cap on live children and an idle time to live;
// the cwd arrives through `noteConversation` (a `beforeRequest` hook) instead of stream metadata;
// generation permits come from `ClaudeSlots`; plan-window readings are a stream for `ClaudeUsage`.
//
// Cairn never reads, copies or proxies Claude Code's OAuth token: the login is whatever the `claude`
// binary has in `~/.claude`.

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

import type { Message, Provider } from "@earendil-works/pi-ai";
import {
  Cause,
  Clock,
  Context,
  Effect,
  FiberSet,
  Layer,
  Option,
  PubSub,
  RcMap,
  Ref,
  Stream,
} from "effect";

import { ClaudeAccount } from "./ClaudeAccount.ts";
import { openConversation } from "./ClaudeConversation.ts";
import type { RateLimitInfo } from "./ClaudeEvents.ts";
import { CAPACITY_TEXT } from "./ClaudeGuards.ts";
import { claudeModels } from "./ClaudeModels.ts";
import { ClaudeOneShot } from "./ClaudeOneShot.ts";
import type { ClaudeCall } from "./ClaudeProvider.ts";
import { claudeProvider } from "./ClaudeProvider.ts";
import { ClaudeSdk } from "./ClaudeSdk.ts";
import { ClaudeSettings } from "./ClaudeSettings.ts";
import { ClaudeSlots } from "./ClaudeSlots.ts";
import { emptyUsage } from "./ClaudeTokens.ts";

/** Where a conversation runs, and which thread it belongs to, as the brain noted it. */
export interface ConversationNote {
  /** The conversation's working directory; the bridge resolves it to its realpath. */
  readonly cwd: string;
  readonly threadId: Option.Option<string>;
}

/** A conversation started or stopped waiting for a generation permit. */
export interface OfferedSlot {
  readonly sessionId: string;
  readonly threadId: Option.Option<string>;
  readonly waiting: boolean;
}

/** The Claude bridge. */
export class Claude extends Context.Service<
  Claude,
  {
    /** The `claude-bridge` provider, for `ModelRuntime.registerNativeProvider`. */
    readonly provider: Provider;
    /**
     * Records where pi's conversation `sessionId` runs. Called before every request attempt; a cwd
     * that differs from a reply's stamp opens a fresh session.
     */
    noteConversation(
      sessionId: string,
      note: ConversationNote
    ): Effect.Effect<void>;
    /**
     * Kills the child of `sessionId`. A held tool call outlives its generation, so a user's stop
     * reaches the bridge only this way. The session is forked on its next call.
     */
    abortConversation(sessionId: string): Effect.Effect<void>;
    /** Shutdown has begun: an `AbortError` from now on means close, leaving sessions resumable. */
    readonly beginClosing: Effect.Effect<void>;
    /** Every plan-window reading a child reports; `ClaudeUsage` merges them. */
    readonly rateLimits: Stream.Stream<RateLimitInfo>;
    /** Who waits for a generation permit, with the thread when the brain noted it. */
    readonly offered: Stream.Stream<OfferedSlot>;
    /** Whether `sessionId` has a live child now. */
    hasChild(sessionId: string): Effect.Effect<boolean>;
    /** The pinned Agent SDK's version. */
    readonly sdkVersion: string;
  }
>()("cairn/bridge/Claude") {
  /** The bridge over the services it reads; the composition root provides them. */
  static readonly layerNoDeps = Layer.effect(
    Claude,
    Effect.gen(function* () {
      const sdk = yield* ClaudeSdk;
      const slots = yield* ClaudeSlots;
      const account = yield* ClaudeAccount;
      const oneShot = yield* ClaudeOneShot;
      const settings = yield* ClaudeSettings;
      const clock = yield* Clock.Clock;

      const places = yield* Ref.make<ReadonlyMap<string, ConversationNote>>(
        new Map()
      );

      const closing = yield* Ref.make(false);
      const readings = yield* PubSub.unbounded<RateLimitInfo>();
      const run = yield* FiberSet.makeRuntime();
      const services = yield* Effect.context();

      const placeOf = (sessionId: string) =>
        Effect.map(Ref.get(places), (all) => ({
          cwd: Option.getOrElse(
            Option.fromNullishOr(all.get(sessionId)?.cwd),
            () => settings.fallbackCwd
          ),
        }));

      const conversations = yield* RcMap.make({
        lookup: (sessionId: string) =>
          openConversation({
            piSessionId: sessionId,
            place: placeOf(sessionId),
            closing: Ref.get(closing),
            onRateLimit: (info) =>
              Effect.asVoid(PubSub.publish(readings, info)),
            runCallback: (effect) => {
              run(effect);
            },
          }),
        idleTimeToLive: settings.idleTimeToLive,
        capacity: settings.liveChildren,
      });

      const failSink = (
        sink: Parameters<ClaudeCall>[3],
        model: Parameters<ClaudeCall>[0],
        text: string
      ) =>
        Effect.sync(() => {
          sink.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: emptyUsage(),
              stopReason: "error",
              errorMessage: text,
              timestamp: clock.currentTimeMillisUnsafe(),
            },
          });
          sink.end();
        });

      const handle = (
        ...[model, context, options, sink]: Parameters<ClaudeCall>
      ) =>
        Effect.gen(function* () {
          const messages: ReadonlyArray<Message> = context.messages;
          const reasoning = Option.fromNullishOr(options?.reasoning);
          const signal = Option.fromNullishOr(options?.signal);

          if (options?.cacheRetention === "none") {
            const place = yield* placeOf(options.sessionId ?? "");

            yield* oneShot.run(
              {
                model,
                messages,
                reasoning,
                signal,
                cwd: place.cwd,
                startedAt: clock.currentTimeMillisUnsafe(),
              },
              sink
            );

            return;
          }

          // pi-durable always sends a session id; a call without one gets a conversation of its own.
          const sessionId = options?.sessionId ?? randomUUID();

          yield* Effect.scoped(
            Effect.gen(function* () {
              const conversation = yield* RcMap.get(conversations, sessionId);

              yield* conversation.call({
                model,
                messages,
                reasoning,
                signal,
                sink,
              });
            })
          ).pipe(
            Effect.catchIf(Cause.isExceededCapacityError, () =>
              failSink(sink, model, CAPACITY_TEXT)
            )
          );
        });

      const call: ClaudeCall = (model, context, options, sink) => {
        run(handle(model, context, options, sink));
      };

      const noteConversation = Effect.fn("Claude.noteConversation")(function* (
        sessionId: string,
        note: ConversationNote
      ) {
        const cwd = yield* Effect.tryPromise(
          async () => await realpath(note.cwd)
        ).pipe(Effect.orElseSucceed(() => note.cwd));

        yield* Ref.update(places, (all) =>
          new Map(all).set(sessionId, { cwd, threadId: note.threadId })
        );
      });

      const abortConversation = Effect.fn("Claude.abortConversation")(
        function* (sessionId: string) {
          const known = yield* RcMap.has(conversations, sessionId);

          if (known) {
            yield* Effect.scoped(
              Effect.flatMap(
                RcMap.get(conversations, sessionId),
                (conversation) => conversation.kill("abort")
              )
            ).pipe(Effect.ignore);
          }
        }
      );

      const hasChild = Effect.fn("Claude.hasChild")(function* (
        sessionId: string
      ) {
        const known = yield* RcMap.has(conversations, sessionId);

        if (!known) {
          return false;
        }

        return yield* Effect.scoped(
          Effect.flatMap(
            RcMap.get(conversations, sessionId),
            (conversation) => conversation.alive
          )
        ).pipe(Effect.orElseSucceed(() => false));
      });

      const provider = claudeProvider(
        claudeModels(settings.longContext),
        call,
        async () => await Effect.runPromiseWith(services)(account.login)
      );

      yield* Effect.logInfo("claude bridge ready").pipe(
        Effect.annotateLogs({ sdk: sdk.sdkVersion, slots: yield* slots.size })
      );

      return Claude.of({
        provider,
        noteConversation,
        abortConversation,
        beginClosing: Ref.set(closing, true),
        rateLimits: Stream.fromPubSub(readings),
        offered: slots.waits.pipe(
          Stream.mapEffect((wait) =>
            Effect.map(Ref.get(places), (all) => ({
              sessionId: wait.sessionId,
              threadId: Option.flatMap(
                Option.fromNullishOr(all.get(wait.sessionId)),
                (note) => note.threadId
              ),
              waiting: wait.waiting,
            }))
          )
        ),
        hasChild,
        sdkVersion: sdk.sdkVersion,
      });
    })
  );

  /** The bridge on the real Agent SDK, with the default slots, login, and one-shot layers. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide([
      ClaudeSdk.layer,
      ClaudeSlots.layer,
      ClaudeAccount.layer,
      ClaudeOneShot.layer,
    ])
  );

  /** The bridge on a scripted Claude Code; needs `ClaudeSdkScripts`. */
  static readonly layerTest = this.layerNoDeps.pipe(
    Layer.provide([
      ClaudeSdk.layerTest,
      ClaudeSlots.layer,
      ClaudeAccount.layer,
      ClaudeOneShot.layer,
    ])
  );
}
