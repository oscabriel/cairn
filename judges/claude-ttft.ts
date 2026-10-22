// J13, live: time to the first token through the full bridge path, against the Agent SDK alone.
//   node judges/claude-ttft.ts [--models claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5]
//                              [--turns 20]
//
// Each turn is a new conversation (a cold Claude Code child, as a thread's first message is): one
// short system prompt and one user message asking for one word. Two clocks run on the same turn:
//
// - bridge: from `provider.streamSimple` to pi-ai's first `text_delta`, which is what pi-durable
//   sees (slot, conversation routing, child start, MCP server, prompt stream, event translation);
// - sdk: from `ClaudeSdk.open` (the bridge's thin wrapper over the Agent SDK's `query()`) to the
//   child's first `text_delta` stream event, which is what a direct SDK caller sees.
//
// The difference is the bridge's own overhead. Prints one JSON line per model with p50 and p95 of
// both, in milliseconds, and the overhead's p50. The judge records rather than gates (bridge note,
// J13): it exits 0 when every turn answered, 1 otherwise. Children get no idle time to live, so
// each closes after its turn and the live-child cap never fills. Costs a little plan usage per turn.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { Claude } from "@cairn/bridge/Claude";
import type { ClaudeEvent } from "@cairn/bridge/ClaudeEvents";
import { claudeModel, DEFAULT_LONG_CONTEXT } from "@cairn/bridge/ClaudeModels";
import { providerContext } from "@cairn/bridge/ClaudeProvider";
import { ClaudeSdk } from "@cairn/bridge/ClaudeSdk";
import { ClaudeSettings } from "@cairn/bridge/ClaudeSettings";
import { ClaudeUsage } from "@cairn/bridge/ClaudeUsage";
import type { Message } from "@earendil-works/pi-ai";
import { NodeRuntime } from "@effect/platform-node";
import {
  Clock,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";

const { values } = parseArgs({
  options: {
    models: {
      type: "string",
      default: "claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5",
    },
    turns: { type: "string", default: "20" },
  },
});

const turns = Number(values.turns);

const modelIds = values.models.split(",").filter((id) => id !== "");

/** A turn did not answer. */
class ClaudeTtftFailed extends Schema.TaggedError<ClaudeTtftFailed>()(
  "ClaudeTtftFailed",
  { message: Schema.String }
) {}

/** When the last child opened, and when its first text token arrived. */
interface SdkClock {
  readonly openedAt: Option.Option<number>;
  readonly firstTokenAt: Option.Option<number>;
}

const NO_CLOCK: SdkClock = {
  openedAt: Option.none(),
  firstTokenAt: Option.none(),
};

const TextDeltaEvent = Schema.Struct({
  type: Schema.Literal("stream_event"),
  event: Schema.Struct({
    type: Schema.Literal("content_block_delta"),
    delta: Schema.Struct({ type: Schema.Literal("text_delta") }),
  }),
});

const isTextDelta = (event: ClaudeEvent) => Schema.is(TextDeltaEvent)(event);

/** The real Agent SDK, timing each child from `open` to its first text token. */
const timedSdk = (clock: Ref.Ref<SdkClock>) =>
  Layer.effect(
    ClaudeSdk,
    Effect.gen(function* () {
      const real = yield* ClaudeSdk;

      return ClaudeSdk.of({
        ...real,
        open: (options, onToolCall) =>
          Effect.gen(function* () {
            const openedAt = yield* Clock.currentTimeMillis;

            yield* Ref.set(clock, {
              openedAt: Option.some(openedAt),
              firstTokenAt: Option.none(),
            });

            const query = yield* real.open(options, onToolCall);

            return {
              ...query,
              events: query.events.pipe(
                Stream.tap((event) =>
                  isTextDelta(event)
                    ? Effect.flatMap(Clock.currentTimeMillis, (at) =>
                        Ref.update(clock, (current) =>
                          Option.isSome(current.firstTokenAt)
                            ? current
                            : { ...current, firstTokenAt: Option.some(at) }
                        )
                      )
                    : Effect.void
                )
              ),
            };
          }),
      });
    })
  ).pipe(Layer.provide(ClaudeSdk.layer));

const percentile = (samples: ReadonlyArray<number>, fraction: number) => {
  const sorted = [...samples].toSorted((a, b) => a - b);

  if (sorted.length === 0) {
    return Number.NaN;
  }

  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1)
  );

  return sorted[index] ?? Number.NaN;
};

const system: Message = {
  role: "system",
  content: "You are a terse assistant in a latency test.",
  timestamp: 1,
};

const user: Message = {
  role: "user",
  content: "Reply with exactly one word: ready.",
  timestamp: 2,
};

/** One cold turn on `modelId`: the bridge's and the SDK's time to the first text token. */
const turn = (cwd: string, modelId: string, clock: Ref.Ref<SdkClock>) =>
  Effect.gen(function* () {
    const claude = yield* Claude;
    const now = yield* Clock.Clock;
    const model = Option.getOrThrow(claudeModel(modelId, DEFAULT_LONG_CONTEXT));
    const sessionId = crypto.randomUUID();

    yield* Ref.set(clock, NO_CLOCK);
    yield* claude.noteConversation(sessionId, { cwd, threadId: Option.none() });

    const startedAt = yield* Clock.currentTimeMillis;

    const stream = claude.provider.streamSimple(
      model,
      providerContext([system, user]),
      { sessionId }
    );

    const firstTokenAt = yield* Effect.promise(async () => {
      for await (const event of stream) {
        if (event.type === "text_delta") {
          return Option.some(now.currentTimeMillisUnsafe());
        }
      }

      return Option.none<number>();
    });

    const reply = yield* Effect.promise(async () => await stream.result());
    const sdk = yield* Ref.get(clock);

    yield* claude.abortConversation(sessionId);

    return {
      answered: reply.stopReason === "stop" && Option.isSome(firstTokenAt),
      error: reply.errorMessage ?? "",
      bridgeMs: Option.map(firstTokenAt, (at) => Math.round(at - startedAt)),
      sdkMs: Option.zipWith(sdk.openedAt, sdk.firstTokenAt, (from, to) =>
        Math.round(to - from)
      ),
    };
  });

const program = (clock: Ref.Ref<SdkClock>) =>
  Effect.gen(function* () {
    const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "cairn-ttft-")));

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rmSync(cwd, { recursive: true, force: true });
      })
    );

    let failures = 0;

    for (const modelId of modelIds) {
      const bridge: Array<number> = [];
      const sdk: Array<number> = [];
      const overhead: Array<number> = [];
      const errors: Array<string> = [];

      for (let index = 0; index < turns; index += 1) {
        const result = yield* turn(cwd, modelId, clock);

        if (!result.answered) {
          failures += 1;
          errors.push(result.error === "" ? "no text" : result.error);
        }

        if (Option.isSome(result.bridgeMs)) {
          bridge.push(result.bridgeMs.value);
        }

        if (Option.isSome(result.sdkMs)) {
          sdk.push(result.sdkMs.value);
        }

        if (Option.isSome(result.bridgeMs) && Option.isSome(result.sdkMs)) {
          overhead.push(result.bridgeMs.value - result.sdkMs.value);
        }
      }

      yield* Effect.sync(() => {
        process.stdout.write(
          `${JSON.stringify({
            model: modelId,
            turns,
            answered: turns - errors.length,
            bridge: {
              p50: percentile(bridge, 0.5),
              p95: percentile(bridge, 0.95),
            },
            sdk: { p50: percentile(sdk, 0.5), p95: percentile(sdk, 0.95) },
            overhead: { p50: percentile(overhead, 0.5) },
            errors,
          })}\n`
        );
      });
    }

    if (failures > 0) {
      return yield* new ClaudeTtftFailed({
        message: `${failures} turns did not answer`,
      });
    }

    return modelIds.length;
  });

// One bridge for every turn, so its usage probe runs once, at start, and not during a measured turn.
const main = Effect.gen(function* () {
  const clock = yield* Ref.make(NO_CLOCK);

  const settings = yield* ClaudeSettings;

  return yield* program(clock).pipe(
    Effect.provide(
      ClaudeUsage.layerBridgeNoDeps.pipe(Layer.provideMerge(timedSdk(clock)))
    ),
    // No idle time to live: each turn's child closes when its turn ends, so the live-child cap,
    // which counts idle conversations too, never fills.
    Effect.provideService(ClaudeSettings, {
      ...settings,
      idleTimeToLive: Duration.zero,
    })
  );
});

NodeRuntime.runMain(Effect.scoped(main));
