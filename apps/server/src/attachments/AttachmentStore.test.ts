// Judges the attachment store's running sweep on the `TestClock`: the boot repair sweeps at boot,
// and the store sweeps once a day after that, a day apart, never every other day.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../Config.ts";
import { Database } from "../db/Database.ts";
import { attachmentMigrations } from "./AttachmentsTestLayer.ts";
import { AttachmentStore } from "./AttachmentStore.ts";

/** The store over a temporary data folder and an in-memory database. */
const storeIn = (dataDir: string) =>
  AttachmentStore.layerNoDeps.pipe(
    Layer.provide(Database.layerTest(attachmentMigrations)),
    Layer.provide(ServerConfig.layerWith({ dataDir })),
    Layer.provide(NodeServices.layer)
  );

describe("attachment sweep", () => {
  it.effect("sweeps a day after boot and then every day", () =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-sweep-"));
      let swept = 0;

      const capture = Logger.make((options) => {
        const annotations = options.fiber.getRef(
          References.CurrentLogAnnotations
        );

        if (annotations.event === "attachment.swept") {
          swept += 1;
        }
      });

      /**
       * Waits, in real time, for the sweep count to reach `count`: a sweep reads real folders,
       * which the `TestClock` does not wait for. Answers the count then, or after two seconds.
       */
      const sweptBecomes = (count: number) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            if (swept >= count) {
              break;
            }

            yield* TestClock.withLive(Effect.sleep("10 millis"));
          }

          // One more beat, so the sweep that logged has gone back to sleep.
          yield* TestClock.withLive(Effect.sleep("20 millis"));

          return swept;
        });

      yield* Effect.gen(function* () {
        yield* TestClock.adjust("23 hours");
        assert.strictEqual(yield* sweptBecomes(0), 0, "no sweep within a day");

        for (const day of [1, 2, 3]) {
          yield* TestClock.adjust(day === 1 ? "1 hour" : "24 hours");
          assert.strictEqual(
            yield* sweptBecomes(day),
            day,
            `one sweep a day (day ${String(day)})`
          );
        }
      }).pipe(
        Effect.provide(
          storeIn(dataDir).pipe(
            Layer.provide(Logger.layer([capture], { mergeWithExisting: true }))
          )
        )
      );
    })
  );
});
