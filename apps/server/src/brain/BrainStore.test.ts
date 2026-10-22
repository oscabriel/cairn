// Judges the brain store's guard against pi-durable's one-way migrations: a store last opened by
// another pi-durable version is copied before this one opens it, the copy is a sound SQLite file
// holding the old data, and an unchanged version copies nothing.

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";

import { BrainConfig } from "./BrainConfig.ts";
import { BrainStore, SIDECAR_FILE } from "./BrainStore.ts";

const decodeSidecar = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ piDurableVersion: Schema.String }))
);

const storeIn = (dataDir: string) =>
  BrainStore.layer.pipe(Layer.provide(BrainConfig.layerFrom(dataDir)));

/** Opens the store, writes one conversation through pi-durable and closes it. */
const seed = (dataDir: string) =>
  Effect.gen(function* () {
    const store = yield* BrainStore;
    const storage = yield* store.open;

    yield* Effect.promise(async () => {
      const harness = await Harness.open(
        storage,
        { models: createModels(), registry: createRegistry() },
        BACKGROUND_CONTEXT
      );

      await harness.createConversation(
        { ownership: { kind: "ownerless" } },
        BACKGROUND_CONTEXT
      );
      await harness.close(BACKGROUND_CONTEXT);
    });
  }).pipe(Effect.provide(storeIn(dataDir)));

const backups = (dataDir: string) =>
  readdirSync(path.join(dataDir, "backups")).toSorted();

describe("brain store", () => {
  it.live("copies the store before a new pi-durable version opens it", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-store-"));

      yield* seed(dataDir);
      assert.deepStrictEqual(
        backups(dataDir),
        [],
        "a new store has nothing to copy"
      );

      // As if the store was last opened by pi-durable 1.3.0 on schema 1.
      writeFileSync(
        path.join(dataDir, SIDECAR_FILE),
        JSON.stringify({ piDurableVersion: "1.3.0", sqliteSchemaVersion: 1 })
      );

      const previous = yield* BrainStore.useSync(
        (store) => store.previous
      ).pipe(Effect.provide(storeIn(dataDir)));

      assert.deepStrictEqual(
        Option.map(previous, (found) => found.piDurableVersion),
        Option.some("1.3.0")
      );

      const copies = backups(dataDir);

      assert.strictEqual(copies.length, 1);
      assert.match(copies[0] ?? "", /^brain-1\.3\.0-.+\.sqlite$/u);

      const copy = new DatabaseSync(
        path.join(dataDir, "backups", copies[0] ?? ""),
        {
          readOnly: true,
        }
      );

      try {
        const integrity = copy.prepare("PRAGMA integrity_check").get();

        const tables = copy
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'"
          )
          .get();

        assert.deepStrictEqual(integrity, { integrity_check: "ok" });
        assert.isAbove(Number(tables?.n ?? 0), 0);
      } finally {
        copy.close();
      }

      // The sidecar now names the installed version, so the next open copies nothing.
      const sidecar = decodeSidecar(
        readFileSync(path.join(dataDir, SIDECAR_FILE), "utf-8")
      );

      assert.notStrictEqual(sidecar.piDurableVersion, "1.3.0");

      yield* Effect.void.pipe(Effect.provide(storeIn(dataDir)));
      assert.strictEqual(backups(dataDir).length, 1);
    })
  );
});
