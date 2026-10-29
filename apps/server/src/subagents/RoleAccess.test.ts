// `roleAccess` keeps a read that failed apart from a role that does not resolve: a
// `RoleAliasesUnavailable` is marked `retry` (the start rereads, the spawn says to call again), a
// `RoleError` is final.

import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Result } from "effect";

import type { RoleAliases } from "../models/RoleAliases.ts";
import { RoleAliasesUnavailable, RoleError } from "../models/RoleAliases.ts";
import { roleAccess } from "./Subagents.ts";

const failingWith = (
  error: RoleError | RoleAliasesUnavailable
): RoleAliases["Service"] => ({
  resolve: () => Effect.fail(error),
  check: () => Effect.succeed([]),
  rows: () => Effect.succeed([]),
});

describe("a role read for the spawn and the start", () => {
  it.effect("marks an unreadable role table as one to retry", () =>
    Effect.promise(async () => {
      const access = roleAccess(
        failingWith(
          new RoleAliasesUnavailable({
            message: "RoleAliases.resolve could not read the role table.",
            operation: "RoleAliases.resolve",
            cause: new Error("disk"),
          })
        ),
        Context.empty()
      );

      const resolved = await access.resolve("@worker");

      assert.isTrue(Result.isFailure(resolved));
      assert.deepStrictEqual(Result.isFailure(resolved) && resolved.failure, {
        retry: true,
        why: "RoleAliases.resolve could not read the role table.",
      });
    })
  );

  it.effect("marks a role nothing ready answers to as final", () =>
    Effect.promise(async () => {
      const access = roleAccess(
        failingWith(
          new RoleError({
            message: "@nobody is not bound.",
            spec: "@nobody",
            reason: "unbound_role",
            skipped: [],
          })
        ),
        Context.empty()
      );

      const resolved = await access.resolve("@nobody");

      assert.deepStrictEqual(Result.isFailure(resolved) && resolved.failure, {
        retry: false,
        why: "@nobody is not bound.",
      });
    })
  );
});
