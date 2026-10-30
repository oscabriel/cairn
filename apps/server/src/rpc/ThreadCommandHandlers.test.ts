// The phase 2 inputs this brain could not act on were refused with `InvalidInput` naming the field
// and reached no service; each package that built one lifted its guard and turned its test here
// around. 1A lifted `reason` and `answers`; 5A lifted `accept_sample` and `launch` (the record
// refuses them on anything but a workflow's launch); permission modes lifted `runtimeMode` (all but
// `auto`, which is not offered) and `accept_for_thread`; 4C lifted `thread.stop`'s
// `subagents: "stop"` (Stop all); 6B lifted `revise` (Send back: the record refuses it on anything
// but a subagent's brief, and without notes).

import { InvalidInput } from "@cairn/protocol/Errors";
import { ApprovalId } from "@cairn/protocol/Ids";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import type { RespondInput } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Result } from "effect";

import { testThreadId } from "../shell/ShellTestKit.ts";
import { ThreadLaunch } from "../threads/ThreadLaunch.ts";
import { Threads } from "../threads/Threads.ts";
import { threadCommandHandlers } from "./ThreadCommandHandlers.ts";

/** The calls that reached `Threads`, by method. */
const reached: Array<string> = [];

const RecordingThreads = Layer.mock(Threads)({
  stop: () =>
    Effect.sync(() => {
      reached.push("stop");
    }),
  configure: () =>
    Effect.sync(() => {
      reached.push("configure");
    }),
  respond: () =>
    Effect.sync(() => {
      reached.push("respond");
    }),
});

const TestLayer = Layer.mergeAll(
  RecordingThreads,
  Layer.mock(ThreadLaunch)({})
);

const threadId = testThreadId(1);

const requestId = Option.some("7");

const respond = (fields: Partial<RespondInput> = {}): RespondInput => ({
  threadId,
  approvalId: ApprovalId.make("apr_1"),
  decision: "accept",
  reason: Option.none(),
  answers: Option.none(),
  launch: Option.none(),
  ...fields,
});

/** The field a refusal names, or `ok` when the call reached `Threads`. */
const outcome = <A, E extends { readonly _tag: string }>(
  call: Effect.Effect<A, E>
) =>
  call.pipe(
    Effect.result,
    Effect.map(
      Result.match({
        onSuccess: () => "ok",
        onFailure: (refusal: E) =>
          refusal instanceof InvalidInput
            ? Option.getOrElse(refusal.field, () => "no field")
            : refusal._tag,
      })
    )
  );

describe("thread commands not handled yet", () => {
  it.effect(
    "configures a permission mode, and refuses Auto, which is not offered",
    () =>
      Effect.gen(function* () {
        reached.length = 0;

        const handlers = yield* threadCommandHandlers;

        const base = {
          threadId,
          model: Option.none(),
          thinkingLevel: Option.none(),
        };

        const refused = yield* outcome(
          handlers.configure(
            { ...base, runtimeMode: Option.some("auto") },
            requestId
          )
        );

        const taken = yield* Effect.forEach(
          [
            Option.some("approval-required" as const),
            Option.some("auto-accept-edits" as const),
            Option.some("full-access" as const),
            Option.none(),
          ],
          (runtimeMode) =>
            outcome(handlers.configure({ ...base, runtimeMode }, requestId))
        );

        assert.deepStrictEqual(
          [refused, taken, reached],
          [
            "runtimeMode",
            ["ok", "ok", "ok", "ok"],
            ["configure", "configure", "configure", "configure"],
          ]
        );
      }).pipe(Effect.provide(TestLayer))
  );

  it.effect(
    "passes Stop all on a thread's subagents, and a stop that keeps them",
    () =>
      Effect.gen(function* () {
        reached.length = 0;

        const handlers = yield* threadCommandHandlers;

        const stopped = yield* outcome(
          handlers.stop(
            { threadId, clearQueue: false, subagents: Option.some("stop") },
            requestId
          )
        );

        const kept = yield* outcome(
          handlers.stop(
            { threadId, clearQueue: false, subagents: Option.some("keep") },
            requestId
          )
        );

        assert.deepStrictEqual(
          [stopped, kept, reached],
          ["ok", "ok", ["stop", "stop"]]
        );
      }).pipe(Effect.provide(TestLayer))
  );

  it.effect(
    "passes accept, Run on 1 first, launch edits, Allow for this thread, Send back with notes, or decline with a reason or answers",
    () =>
      Effect.gen(function* () {
        reached.length = 0;

        const handlers = yield* threadCommandHandlers;

        const taken = yield* Effect.forEach(
          [
            respond(),
            respond({ decision: "accept_sample" }),
            respond({
              launch: Option.some({
                budget: DEFAULT_BUDGET,
                roleOverrides: {},
              }),
            }),
            respond({ decision: "accept_for_thread" }),
            respond({ decision: "decline" }),
            respond({ decision: "decline", reason: Option.some("not now") }),
            respond({
              answers: Option.some([
                { index: 0, picks: ["Yes"], custom: null },
              ]),
            }),
            respond({ decision: "revise", reason: Option.some("narrower") }),
          ],
          (input) => outcome(handlers.respond(input, requestId))
        );

        assert.deepStrictEqual(
          [taken, reached],
          [
            ["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok"],
            [
              "respond",
              "respond",
              "respond",
              "respond",
              "respond",
              "respond",
              "respond",
              "respond",
            ],
          ]
        );
      }).pipe(Effect.provide(TestLayer))
  );
});
