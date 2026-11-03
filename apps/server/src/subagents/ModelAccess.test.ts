// `modelAccess` keeps a read that failed apart from a model that is not ready: a
// `ModelSpecsUnavailable` is marked `retry` (the start rereads, the spawn says to call again), a
// `ModelSpecError` is final.

import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Result } from "effect";

import type { ModelSpecs } from "../models/ModelSpecs.ts";
import { ModelSpecError, ModelSpecsUnavailable } from "../models/ModelSpecs.ts";
import { modelAccess } from "./Subagents.ts";

const failingWith = (
  error: ModelSpecError | ModelSpecsUnavailable
): ModelSpecs["Service"] => ({
  resolve: () => Effect.fail(error),
  check: () => Effect.succeed([]),
  list: (caller) => Effect.succeed({ caller, providers: [], search: [] }),
});

describe("a model check for the spawn and the start", () => {
  it.effect("marks an unreadable catalog as one to retry", () =>
    Effect.promise(async () => {
      const access = modelAccess(
        failingWith(
          new ModelSpecsUnavailable({
            message: "ModelSpecs.resolve could not read the catalog.",
            operation: "ModelSpecs.resolve",
            cause: new Error("disk"),
          })
        ),
        Context.empty()
      );

      const resolved = await access.resolve("opencode-go/gpt-6-luna");

      assert.deepStrictEqual(Result.isFailure(resolved) && resolved.failure, {
        retry: true,
        why: "ModelSpecs.resolve could not read the catalog.",
      });
    })
  );

  it.effect("marks a model that is not ready as final", () =>
    Effect.promise(async () => {
      const access = modelAccess(
        failingWith(
          new ModelSpecError({
            message: "opencode-go/gpt-6-luna has no usable credential.",
            spec: "opencode-go/gpt-6-luna",
            reason: "missing_credential",
          })
        ),
        Context.empty()
      );

      const resolved = await access.resolve("opencode-go/gpt-6-luna");

      assert.deepStrictEqual(Result.isFailure(resolved) && resolved.failure, {
        retry: false,
        why: "opencode-go/gpt-6-luna has no usable credential.",
      });
    })
  );
});
