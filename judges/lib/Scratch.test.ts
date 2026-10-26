// Judges `Scratch`: the folder and Claude Code's transcript folder for it are gone once the scope
// closes, also when the transcript is written again during the exit grace.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";

import * as Scratch from "./Scratch.ts";

describe("scratch folders", () => {
  it.effect(
    "removes the folder and its transcripts when the scope closes",
    () =>
      Effect.gen(function* () {
        const made = yield* Ref.make("");

        const fiber = yield* Effect.gen(function* () {
          const root = yield* Scratch.make("cairn-scratch-test-");

          yield* Ref.set(made, root);
          writeFileSync(path.join(root, "brain.sqlite"), "");
          mkdirSync(Scratch.projectFolder(root), { recursive: true });
        }).pipe(Effect.scoped, Effect.forkChild);

        yield* Effect.yieldNow;

        const root = yield* Ref.get(made);

        assert.isFalse(existsSync(root));
        assert.isFalse(existsSync(Scratch.projectFolder(root)));

        // A child exiting late writes its transcript again; the second pass removes it.
        mkdirSync(Scratch.projectFolder(root), { recursive: true });
        yield* TestClock.adjust(Scratch.CHILD_EXIT_GRACE);
        yield* Fiber.join(fiber);

        assert.isFalse(existsSync(Scratch.projectFolder(root)));
      })
  );
});
