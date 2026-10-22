// Judges `Events` against lines written by Effect's own `Logger.formatJson` (the format the brain is
// asked to write), plus the torn and foreign lines a killed process leaves behind.
import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Logger, Option, Stream } from "effect";
import type { Scope } from "effect";

import * as Events from "./Events.ts";

const tempLog = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "cairn-events-",
  });

  return `${directory}/events.log`;
});

/** Writes log lines to `path` exactly as a brain using `Logger.formatJson` would. */
const brainLog = (
  path: string,
  write: Effect.Effect<void>
): Effect.Effect<void, never, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileLogger = yield* Logger.toFile(Logger.formatJson, path, {
      flag: "a",
      batchWindow: 0,
    }).pipe(Effect.orDie);

    yield* write.pipe(
      Effect.provide(Logger.layer([fileLogger], { mergeWithExisting: false }))
    );
  }).pipe(Effect.scoped);

const listening = (port: number) =>
  Effect.log("listening").pipe(
    Effect.annotateLogs({ event: "listening", host: "127.0.0.1", port })
  );

/** One complete `partial` line with its newline, as the brain writes it. */
const line = (n: number) =>
  `{"message":"partial","level":"INFO","timestamp":"2026-10-22T09:00:00.000Z","annotations":{"event":"partial","n":${n}}}\n`;

describe("parseLine", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("names a line by its event annotation, else by its message", () =>
      Effect.gen(function* () {
        const path = yield* tempLog;

        yield* brainLog(
          path,
          Effect.gen(function* () {
            yield* listening(4100);

            yield* Effect.logWarning("closing");

            yield* Effect.log("two", "parts");
          })
        );

        const events = yield* Events.read(path);

        assert.deepStrictEqual(
          events.map((event) => [event.event, event.level]),
          [
            ["listening", "INFO"],
            ["closing", "WARN"],
          ]
        );

        const [first] = events;

        assert.isDefined(first);

        assert.deepStrictEqual(
          Events.numberField(first, "port"),
          Option.some(4100)
        );

        assert.deepStrictEqual(
          Events.stringField(first, "host"),
          Option.some("127.0.0.1")
        );
      }).pipe(Effect.scoped)
    );

    it.effect("skips lines that are not structured log lines", () =>
      Effect.sync(() => {
        const events = Events.parseLines(
          [
            "(node:1234) ExperimentalWarning: SQLite is an experimental feature",
            '{"message":"listening","level":"INFO","timestamp":"2026-10-22T09:00:00.000Z","annotations":{"event":"listening","port":4100}}',
            '{"message":"torn","level":"INF',
            '{"message":["a","b"],"level":"INFO","timestamp":"2026-10-22T09:00:00.000Z"}',
            "",
          ].join("\n")
        );

        assert.deepStrictEqual(
          events.map((event) => event.event),
          ["listening"]
        );
      })
    );
  });
});

describe("follow", () => {
  layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect(
      "finds the port of a brain that starts after the judge waits",
      () =>
        Effect.gen(function* () {
          const path = yield* tempLog;

          const waiting = yield* Events.waitForListening(path, {
            timeout: "5 seconds",
          }).pipe(Effect.forkScoped);

          yield* Effect.sleep("100 millis");

          yield* brainLog(path, listening(41_234));

          assert.strictEqual(yield* Fiber.join(waiting), 41_234);
        }).pipe(Effect.scoped)
    );

    it.effect("starts at `from`, so an earlier run's line does not count", () =>
      Effect.gen(function* () {
        const path = yield* tempLog;

        yield* brainLog(path, listening(1111));

        const from = yield* Events.size(path);

        const waiting = yield* Events.waitForListening(path, {
          from,
          timeout: "5 seconds",
        }).pipe(Effect.forkScoped);

        yield* Effect.sleep("100 millis");

        yield* brainLog(path, listening(2222));

        assert.strictEqual(yield* Fiber.join(waiting), 2222);
      }).pipe(Effect.scoped)
    );

    it.effect("waits for a line to be finished before reading it", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const path = yield* tempLog;

        const collecting = yield* Events.follow(path, {
          interval: "10 millis",
        }).pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped);

        // A whole line, then half of the next: only the whole one may be read now.
        yield* fs.writeFileString(path, line(1) + line(2).slice(0, 40));

        yield* Effect.sleep("60 millis");

        yield* fs.writeFileString(path, line(2).slice(40) + line(3), {
          flag: "a",
        });

        const events = yield* Fiber.join(collecting);

        assert.deepStrictEqual(
          events.map((event) => Events.numberField(event, "n")),
          [Option.some(1), Option.some(2), Option.some(3)]
        );
      }).pipe(Effect.scoped)
    );

    it.effect("reads a replaced, shorter log from its start", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const path = yield* tempLog;

        yield* brainLog(
          path,
          Effect.gen(function* () {
            yield* listening(1);

            yield* listening(2);

            yield* listening(3);
          })
        );

        const from = yield* Events.size(path);

        const waiting = yield* Events.waitForListening(path, {
          from,
          timeout: "5 seconds",
        }).pipe(Effect.forkScoped);

        yield* Effect.sleep("100 millis");

        yield* fs.remove(path);

        yield* brainLog(path, listening(4));

        assert.strictEqual(yield* Fiber.join(waiting), 4);
      }).pipe(Effect.scoped)
    );

    it.effect("fails with EventTimeout when the event never comes", () =>
      Effect.gen(function* () {
        const path = yield* tempLog;

        yield* brainLog(path, Effect.log("starting"));

        const error = yield* Events.waitForListening(path, {
          timeout: "200 millis",
        }).pipe(Effect.flip);

        assert.instanceOf(error, Events.EventTimeout);

        assert.strictEqual(error.waitedFor, "listening");
      }).pipe(Effect.scoped)
    );
  });
});
