import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { FauxModels } from "../brain/FauxModels.ts";
import { FAUX_MODEL, ModelSource } from "../brain/ModelSource.ts";
import { scriptedAnswer } from "../brain/ScriptedHarness.ts";
import {
  BranchNames,
  buildBranchNamePrompt,
  slugBranchName,
} from "./BranchNames.ts";
import {
  buildThreadTitlePrompt,
  placeholderTitle,
  sanitizeThreadTitle,
  ThreadTitles,
} from "./ThreadTitles.ts";
import { TitleModel } from "./TitleModel.ts";

const Faux = ModelSource.layerFaux({ tokensPerSecond: 10_000, settings: {} });

const naming = (model: Layer.Layer<TitleModel, never, ModelSource>) =>
  Layer.mergeAll(ThreadTitles.layerNoDeps, BranchNames.layerNoDeps).pipe(
    Layer.provide(model),
    Layer.provideMerge(Faux)
  );

const answer = (text: string) =>
  FauxModels.use(({ faux }) =>
    Effect.sync(() => {
      faux.setResponses([scriptedAnswer(text, 0)]);
    })
  );

describe("ThreadTitles and BranchNames", () => {
  it("keep t3code's prompts with Cairn's name", () => {
    const title = buildThreadTitlePrompt("Fix the login page");

    assert.include(title, "recognize this Cairn thread weeks later");
    assert.include(title, "User message:\nFix the login page");
    assert.include(
      buildBranchNamePrompt("Fix it"),
      "Return a JSON object with key: branch."
    );
  });

  it("sanitize titles and derive the placeholder and slug fallbacks", () => {
    assert.deepStrictEqual(
      sanitizeThreadTitle('  "Login Fix"\nmore'),
      Option.some("Login Fix")
    );
    assert.isTrue(Option.isNone(sanitizeThreadTitle("  \n ")));
    assert.strictEqual(placeholderTitle(""), "New thread");
    assert.strictEqual(placeholderTitle("First line\nsecond"), "First line");
    assert.strictEqual(
      slugBranchName("Fix the flaky login test, then tell me"),
      "fix-the-flaky-login-test"
    );
  });

  it.effect(
    "name a thread and a branch from the cheap model's JSON answer",
    () =>
      Effect.gen(function* () {
        yield* answer(
          '```json\n{"title": "Login page fix", "needsRefinement": false}\n```'
        );
        assert.deepStrictEqual(
          yield* (yield* ThreadTitles).generate("Fix the login page"),
          Option.some("Login page fix")
        );

        yield* answer('{"branch": "Fix/Login Page"}');
        assert.strictEqual(
          yield* (yield* BranchNames).generate("Fix the login page"),
          "fix/login-page"
        );
      }).pipe(Effect.provide(naming(TitleModel.layerFixed(FAUX_MODEL))))
  );

  it.effect(
    "fall back when the model fails, is unknown or is the Claude bridge",
    () =>
      Effect.gen(function* () {
        yield* answer("not json at all and no braces");
        assert.strictEqual(
          yield* (yield* BranchNames).generate("Add a dark mode toggle"),
          "add-a-dark-mode-toggle"
        );

        // A title answer that is not the JSON asked for keeps the placeholder (T34).
        yield* answer("I can't help name this thread.");
        assert.isTrue(
          Option.isNone(yield* (yield* ThreadTitles).generate("Anything"))
        );
      }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            assert.isTrue(
              Option.isNone(yield* (yield* ThreadTitles).generate("Anything"))
            );
            assert.strictEqual(
              yield* (yield* BranchNames).generate("Two words"),
              "two-words"
            );
          }).pipe(
            Effect.provide(
              naming(
                TitleModel.layerFixed({
                  provider: "claude-bridge",
                  modelId: "claude-haiku-5-5",
                })
              )
            )
          )
        ),
        Effect.andThen(
          Effect.gen(function* () {
            assert.isTrue(
              Option.isNone(yield* (yield* ThreadTitles).generate("Anything"))
            );
          }).pipe(
            Effect.provide(
              naming(
                TitleModel.layerFixed({ provider: "nobody", modelId: "none" })
              )
            )
          )
        ),
        Effect.provide(naming(TitleModel.layerFixed(FAUX_MODEL)))
      )
  );
});
