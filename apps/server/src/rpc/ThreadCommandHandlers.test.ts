// The phase 2 inputs this brain cannot act on yet are refused with `InvalidInput` naming the field,
// and reach no service. Each package that builds one lifts its guard and turns its test here around:
// 4A `revise`, 5A `accept_sample` and `launch`, 4C `subagents`. 1A lifted `reason` and `answers`;
// permission modes lifted `runtimeMode` (all but `auto`, which is not offered) and
// `accept_for_thread`.

import { InvalidInput } from "@cairn/protocol/Errors";
import { ApprovalId } from "@cairn/protocol/Ids";
import type { ApprovalDecision } from "@cairn/protocol/Policy";
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
    "refuses Stop all on a thread's subagents, and stops one that keeps them",
    () =>
      Effect.gen(function* () {
        reached.length = 0;

        const handlers = yield* threadCommandHandlers;

        const refused = yield* outcome(
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
          [refused, kept, reached],
          ["subagents", "ok", ["stop"]]
        );
      }).pipe(Effect.provide(TestLayer))
  );

  it.effect(
    "refuses each respond field it cannot record, and passes accept, Allow for this thread or decline with a reason or answers",
    () =>
      Effect.gen(function* () {
        reached.length = 0;

        const handlers = yield* threadCommandHandlers;

        const decisions: ReadonlyArray<ApprovalDecision> = [
          "accept_sample",
          "revise",
        ];

        const refused = yield* Effect.forEach(
          [
            ...decisions.map((decision) => respond({ decision })),
            respond({
              launch: Option.some({
                budget: DEFAULT_BUDGET,
                roleOverrides: {},
              }),
            }),
          ],
          (input) => outcome(handlers.respond(input, requestId))
        );

        const taken = yield* Effect.forEach(
          [
            respond(),
            respond({ decision: "accept_for_thread" }),
            respond({ decision: "decline" }),
            respond({ decision: "decline", reason: Option.some("not now") }),
            respond({
              answers: Option.some([
                { index: 0, picks: ["Yes"], custom: null },
              ]),
            }),
          ],
          (input) => outcome(handlers.respond(input, requestId))
        );

        assert.deepStrictEqual(
          [refused, taken, reached],
          [
            ["decision", "decision", "launch"],
            ["ok", "ok", "ok", "ok", "ok"],
            ["respond", "respond", "respond", "respond", "respond"],
          ]
        );
      }).pipe(Effect.provide(TestLayer))
  );
});
