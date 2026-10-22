// The grant's import and its one holder, on temporary paths (never the deployed grant or lock).
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Layer, Option } from "effect";

import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { Executor0004 } from "../db/migrations/0004Executor.ts";
import { ExecutorGrant } from "./ExecutorGrant.ts";

const Sql = Database.layerTest({
  ...migrations,
  "0004_Executor": Executor0004,
});

const paths = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cairn-grant-"));

  return {
    grantFile: path.join(directory, "executor-grant.json"),
    lockFile: path.join(directory, "state", "executor.lock"),
  };
};

const grant = {
  serverUrl: "http://127.0.0.1:9/mcp?connection=con_cairn",
  clientInformation: { client_id: "client_1" },
  tokens: {
    access_token: "at_one",
    token_type: "Bearer",
    refresh_token: "rt_one",
  },
  // pi-mcp's discovery cache is not a grant field and never reaches the row.
  discoveryState: { authorizationServerUrl: "http://127.0.0.1:9/auth" },
};

describe("the Executor grant", () => {
  it.live(
    "is imported once, the file renamed, then deleted after new tokens",
    () =>
      Effect.gen(function* () {
        const where = paths();

        writeFileSync(where.grantFile, JSON.stringify(grant));

        const context = yield* Layer.build(ExecutorGrant.layerWith(where));
        const holder = Context.get(context, ExecutorGrant);
        const loaded = yield* holder.load;

        assert.isTrue(holder.held);
        assert.strictEqual(
          Option.getOrThrow(loaded).tokens?.access_token,
          "at_one"
        );
        assert.notProperty(Option.getOrThrow(loaded), "discoveryState");
        assert.isFalse(existsSync(where.grantFile));
        assert.isTrue(existsSync(`${where.grantFile}.imported`));

        yield* holder.save({
          ...Option.getOrThrow(loaded),
          tokens: {
            access_token: "at_two",
            token_type: "Bearer",
            refresh_token: "rt_two",
          },
        });

        assert.isFalse(existsSync(`${where.grantFile}.imported`));
        assert.strictEqual(
          Option.getOrThrow(yield* holder.load).tokens?.refresh_token,
          "rt_two"
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(Sql, NodeServices.layer))
      )
  );

  it.live("has one holder: a second process never reads or writes it", () =>
    Effect.gen(function* () {
      const where = paths();

      writeFileSync(where.grantFile, JSON.stringify(grant));

      const first = Context.get(
        yield* Layer.build(ExecutorGrant.layerWith(where)),
        ExecutorGrant
      );

      const second = Context.get(
        yield* Layer.build(ExecutorGrant.layerWith(where)),
        ExecutorGrant
      );

      assert.isTrue(first.held);
      assert.isFalse(second.held);
      assert.isTrue(Option.isNone(yield* second.load));

      const refused = yield* second
        .save(Option.getOrThrow(yield* first.load))
        .pipe(Effect.flip);

      assert.strictEqual(refused.operation, "save");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(Sql, NodeServices.layer))
    )
  );
});
