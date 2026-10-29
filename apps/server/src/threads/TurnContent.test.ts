import { RequestId, ThreadId } from "@cairn/protocol/Ids";
import type { TurnInput } from "@cairn/protocol/Thread";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";

import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { ScriptedStore } from "../brain/ScriptedHarness.ts";
import { Threads } from "./Threads.ts";
import { addProject, HeldModel, threadsTestLayer } from "./ThreadsTestKit.ts";
import { TitleModel } from "./TitleModel.ts";
import {
  CAIRN_USER_ENTRY,
  TurnContent,
  TurnContentError,
  textStage,
} from "./TurnContent.ts";
import type { TurnContentStage } from "./TurnContent.ts";
import { turnContentStages } from "./TurnContentStages.ts";

const threadId = ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-000000000001");

const input = (text: string): TurnInput => ({
  requestId: RequestId.make("r1"),
  text,
  attachments: [],
  skillRefs: [],
});

/** A stage that appends `text` as one more content block. */
const appending = (text: string): TurnContentStage<never> => ({
  name: `append-${text}`,
  run: (draft) =>
    Effect.succeed({
      ...draft,
      content: [...draft.content, { type: "text", text }],
    }),
});

const refusing: TurnContentStage<never> = {
  name: "refuse",
  run: () =>
    Effect.fail(
      new TurnContentError({
        message: "The refusing stage refused the turn.",
        stage: "refuse",
        reason: "invalid_input",
        field: Option.some("attachments"),
      })
    ),
};

const build = (stages: ReadonlyArray<TurnContentStage<never>>, text: string) =>
  TurnContent.use((turns) =>
    turns.build(threadId, "owner@test", input(text))
  ).pipe(Effect.provide(TurnContent.layerFrom(stages)));

describe("turn content stages", () => {
  it.effect(
    "runs the stages in their order and records the turn as cairn.user",
    () =>
      Effect.gen(function* () {
        const built = yield* build(
          [textStage, appending("b"), appending("c")],
          "a"
        );

        assert.deepStrictEqual(
          built.content.map((part) =>
            part.type === "text" ? part.text : "image"
          ),
          ["a", "b", "c"]
        );
        assert.deepStrictEqual(
          built.entry,
          Option.some({
            kind: CAIRN_USER_ENTRY,
            data: { from: "owner@test", attachments: [] },
          })
        );
      })
  );

  it.effect("the production order starts with the text stage", () =>
    Effect.sync(() => {
      assert.strictEqual(turnContentStages[0], textStage);
    })
  );

  it.effect("a turn with no content is refused as empty", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(build([textStage], "   "));

      assert.strictEqual(failure.reason, "empty");
    })
  );

  it.effect("a failing stage stops the stages after it", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        build([textStage, refusing, appending("never")], "a")
      );

      assert.strictEqual(failure.stage, "refuse");
    })
  );

  it.live("a failing stage fails the send and nothing is submitted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());

      yield* Effect.gen(function* () {
        const projectId = yield* addProject(root);

        yield* (yield* HarnessSeam).ensureThread({
          threadId,
          projectId,
          model: { provider: "scripted", modelId: "scripted" },
          thinkingLevel: "off",
          cwd: root,
          instructions: Option.none(),
          runtimeMode: "full-access",
        });

        const failure = yield* Effect.flip(
          (yield* Threads).send(
            { threadId, input: input("hello"), whenBusy: "followUp" },
            "owner@test"
          )
        );

        assert.strictEqual(failure._tag, "TurnContentError");

        const thread = (yield* ScriptedStore).threads.get(threadId);

        assert.strictEqual(thread?.entries.length, 0);
        assert.strictEqual(thread?.byRequest.size, 0);
      }).pipe(
        Effect.provide(
          threadsTestLayer({
            dataDir: root,
            titleModel: TitleModel.layerNone,
            model: HeldModel,
            turnContent: TurnContent.layerFrom([textStage, refusing]),
          })
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
