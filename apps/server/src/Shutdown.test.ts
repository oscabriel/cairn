// The SIGTERM path end to end (ADR 0022): a judge brain in its own process with one socket open,
// SIGTERM, then the process must be gone within 3 s, the socket must have been closed with 1001
// (going away, so the page reconnects at once), and the log must show `closing` then `closed <ms>`.
// The shutdown hooks' order and timeouts are checked in process below it.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  Clock,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
} from "effect";
import { TestClock } from "effect/testing";

import { Shutdown, shutdownHook } from "./Shutdown.ts";

const judgeMain = path.join(import.meta.dirname, "judge-main.ts");

const repoRoot = path.join(import.meta.dirname, "..", "..", "..");

const LogLine = Schema.Struct({
  message: Schema.Unknown,
  annotations: Schema.Record(Schema.String, Schema.Unknown),
});

const decodeLogLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(LogLine)
);

const eventOf = (line: string) =>
  Option.flatMap(decodeLogLine(line), (decoded) =>
    Option.fromNullishOr(decoded.annotations.event)
  );

const portOf = (line: string) =>
  Option.flatMap(decodeLogLine(line), (decoded) => {
    const { port } = decoded.annotations;

    return Schema.is(Schema.Int)(port) ? Option.some(port) : Option.none();
  });

/** Opens `/ws` with a judge's headers; resolves with the raw socket once upgraded. */
const openSocket = (port: number) =>
  Effect.callback<Socket>((resume) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/ws?protocol=1",
      headers: {
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
        "x-cairn-user": "owner@loopback",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });

    request.on("upgrade", (_response, socket) => {
      resume(Effect.succeed(socket));
    });
    request.on("response", (response) => {
      resume(
        Effect.die(
          new Error(`upgrade refused with ${response.statusCode ?? 0}`)
        )
      );
    });
    request.on("error", (cause) => {
      resume(Effect.die(cause));
    });
    request.end();
  });

/** The status code of the first close frame in what the server sent; 0 when there is none. */
const closeCode = (bytes: Buffer) => {
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    // FIN plus opcode 8, then an unmasked payload of at least two bytes.
    if (bytes[index] === 0x88 && (bytes[index + 1] ?? 0) >= 2) {
      return bytes.readUInt16BE(index + 2);
    }
  }

  return 0;
};

/** A judge brain in its own process, killed when the test's scope ends whatever happened. */
const startJudgeBrain = (dataDir: string, eventsLog: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      spawn(process.execPath, [judgeMain], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CAIRN_PORT: "0",
          CAIRN_DATA_DIR: dataDir,
          CAIRN_EVENTS_LOG: eventsLog,
          CAIRN_LOG_LEVEL: "Info",
        },
        stdio: ["ignore", "pipe", "inherit"],
      })
    ),
    (child) =>
      Effect.sync(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      })
  );

/** The bound port, once the brain has logged both `listening` and `ready`. */
const readyPort = (child: ChildProcess) =>
  Effect.callback<number>((resume) => {
    let buffered = "";
    let port = Option.none<number>();
    let isReady = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf-8");
      const lines = buffered.split("\n");

      buffered = lines.pop() ?? "";

      for (const line of lines) {
        port = Option.orElse(port, () => portOf(line));
        isReady ||= Option.contains(eventOf(line), "ready");
      }

      if (isReady && Option.isSome(port)) {
        resume(Effect.succeed(port.value));
      }
    });
  });

/** The exit code (or 128 plus the signal number) once the process has gone. */
const exited = (child: ChildProcess) =>
  Effect.callback<number>((resume) => {
    child.on("exit", (code, signal) => {
      resume(
        Effect.succeed(
          code ?? (signal === null ? -1 : 128 + os.constants.signals[signal])
        )
      );
    });
  });

const loggedLines = (eventsLog: string) =>
  readFileSync(eventsLog, "utf-8")
    .split("\n")
    .flatMap((line) => Option.toArray(decodeLogLine(line)));

describe("SIGTERM", () => {
  it.live(
    "closes an open socket with 1001 and exits within 3 s",
    () =>
      Effect.gen(function* () {
        const dataDir = mkdtempSync(path.join(os.tmpdir(), "cairn-shutdown-"));
        const eventsLog = path.join(dataDir, "events.log");
        const child = yield* startJudgeBrain(dataDir, eventsLog);
        const port = yield* readyPort(child).pipe(Effect.timeout("15 seconds"));
        const socket = yield* openSocket(port);
        const received: Array<Buffer> = [];

        socket.on("data", (chunk: Buffer) => {
          received.push(chunk);
        });

        const exit = yield* Effect.forkChild(exited(child));
        const before = yield* Clock.currentTimeMillis;

        child.kill("SIGTERM");

        const exitCode = yield* Fiber.join(exit).pipe(
          Effect.timeout("10 seconds")
        );

        const elapsed = (yield* Clock.currentTimeMillis) - before;

        socket.destroy();

        const lines = loggedLines(eventsLog);

        const events = lines.flatMap((line) =>
          Option.toArray(Option.fromNullishOr(line.annotations.event))
        );

        const closedMs = lines.flatMap((line) =>
          Schema.is(Schema.Int)(line.annotations.ms)
            ? [line.annotations.ms]
            : []
        );

        const code = closeCode(Buffer.concat(received));

        console.info(
          `shutdown: exit ${exitCode} after ${elapsed} ms, close code ${code}, closed in ${String(closedMs[0])} ms`
        );
        assert.isBelow(elapsed, 3000);
        assert.strictEqual(exitCode, 130);
        assert.strictEqual(code, 1001);
        assert.isAtLeast(events.indexOf("closing"), 0);
        assert.isAbove(events.indexOf("closed"), events.indexOf("closing"));
        assert.isBelow(closedMs[0] ?? Number.POSITIVE_INFINITY, 5000);
      }),
    30_000
  );
});

describe("Shutdown hooks", () => {
  it.effect(
    "run in order when the scope closes, past a failing and a hanging hook",
    () =>
      Effect.gen(function* () {
        const order = yield* Ref.make<ReadonlyArray<string>>([]);

        const record = (name: string) =>
          Ref.update(order, (seen) => [...seen, name]);

        const scope = yield* Scope.make();

        yield* Layer.buildWithScope(
          Shutdown.layerFrom([
            shutdownHook("first", record("first")),
            shutdownHook(
              "failing",
              Effect.andThen(record("failing"), Effect.fail("broken"))
            ),
            shutdownHook(
              "hanging",
              Effect.andThen(record("hanging"), Effect.never),
              "1 second"
            ),
            shutdownHook("last", record("last")),
          ]),
          scope
        );

        const closing = yield* Scope.close(scope, Exit.void).pipe(
          Effect.forkChild
        );

        yield* TestClock.adjust("1 second");
        yield* Fiber.join(closing);

        assert.deepStrictEqual(yield* Ref.get(order), [
          "first",
          "failing",
          "hanging",
          "last",
        ]);
      })
  );

  it.effect("reports closing once begin is called, once", () =>
    Effect.gen(function* () {
      const shutdown = yield* Shutdown;

      assert.isFalse(yield* shutdown.isClosing);
      yield* shutdown.begin;
      yield* shutdown.begin;
      assert.isTrue(yield* shutdown.isClosing);
    }).pipe(Effect.provide(Shutdown.layerFrom<never>([])))
  );
});
