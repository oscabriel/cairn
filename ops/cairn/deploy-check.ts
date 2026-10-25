// The deploy's outside judge: the unit's current invocation logged `listening`, and a `session.hello`
// over `/ws` answers, within the time limit.
//
//   node ops/cairn/deploy-check.ts [--unit cairn] [--seconds 60] [--config ~/.config/cairn/cairn.json]
//
// Only this invocation's journal lines count (by `InvocationID`), so a previous run's start-up cannot
// pass for the new one. The hello goes straight to the brain's port with the headers Caddy would add
// (Host, the copied `X-Cairn-User`) and Cairn's Origin, so the check does not depend on the Caddy route;
// any process on the Beelink may do this (ADR 0008's accepted consequence). The line also carries the
// brain's PATH directories, read from /proc without the rest of its environment. Prints one JSON line and
// exits 0 on a pass, 1 otherwise. Reads ~/.config/cairn/cairn.json, which holds no secret.
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Clock,
  Console,
  Effect,
  FileSystem,
  Option,
  Schedule,
  Schema,
} from "effect";

import * as Events from "../../judges/lib/Events.ts";
import * as ProtocolClient from "../../judges/lib/ProtocolClient.ts";
import * as Unit from "../../judges/lib/Unit.ts";

const { values } = parseArgs({
  options: {
    unit: { type: "string", default: "cairn" },
    seconds: { type: "string", default: "60" },
    config: {
      type: "string",
      default: `${homedir()}/.config/cairn/cairn.json`,
    },
  },
});

const { unit, seconds: secondsText, config: configPath } = values;

const seconds = Number(secondsText);

const CairnJson = Schema.fromJsonString(
  Schema.Struct({
    owner: Schema.String,
    host: Schema.String,
    origin: Schema.String,
  })
);

const decodeCairnJson = Schema.decodeEffect(CairnJson);

class DeployCheckFailed extends Schema.TaggedError<DeployCheckFailed>()(
  "DeployCheckFailed",
  { step: Schema.String, detail: Schema.String }
) {
  override get message(): string {
    return `Deploy check failed at ${this.step}: ${this.detail}.`;
  }
}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const started = yield* Clock.currentTimeMillis;

  const config = yield* decodeCairnJson(yield* fs.readFileString(configPath));

  const invocation = yield* Unit.invocationId(unit);

  if (invocation === "") {
    return yield* new DeployCheckFailed({
      step: "invocation",
      detail: `${unit} has no current invocation; is it running?`,
    });
  }

  // The bound port from this invocation's `listening` line.
  const port = yield* Unit.journal(unit, invocation).pipe(
    Effect.map((text) =>
      Events.parseLines(text)
        .filter(Events.named("listening"))
        .flatMap((event) => Option.toArray(Events.numberField(event, "port")))
        .at(0)
    ),
    Effect.flatMap(Effect.fromNullishOr),
    Effect.retry({ schedule: Schedule.spaced("250 millis") }),
    Effect.timeoutOrElse({
      duration: `${seconds} seconds`,
      orElse: () =>
        Effect.fail(
          new DeployCheckFailed({
            step: "listening",
            detail: `no listening line with a port from invocation ${invocation}`,
          })
        ),
    })
  );

  const listeningAt = yield* Clock.currentTimeMillis;

  // `/ws` answers 503 until boot finishes, so the hello is retried on a fresh socket each time.
  const hello = yield* ProtocolClient.cairn({
    base: `http://127.0.0.1:${port}`,
    origin: config.origin,
    headers: { Host: config.host, "X-Cairn-User": config.owner },
  }).pipe(
    Effect.flatMap((client) => client["session.hello"]()),
    Effect.scoped,
    Effect.retry({ schedule: Schedule.spaced("250 millis") }),
    Effect.timeoutOrElse({
      duration: `${Math.max(1, seconds - (listeningAt - started) / 1000)} seconds`,
      orElse: () =>
        Effect.fail(
          new DeployCheckFailed({
            step: "hello",
            detail: `session.hello on port ${port} did not answer`,
          })
        ),
    })
  );

  const done = yield* Clock.currentTimeMillis;

  // The PATH thread tools inherit (T28); judges/deployed-unit.ts path compares it with the login PATH.
  const path = yield* Unit.pathOf(yield* Unit.mainPid(unit));

  return {
    pass: true,
    unit,
    invocation,
    port,
    listeningMs: listeningAt - started,
    helloMs: done - started,
    protocol: hello.protocol,
    build: hello.build,
    path: Option.getOrElse(path, () => []),
  };
}).pipe(
  Effect.matchEffect({
    onSuccess: (result) => Console.log(JSON.stringify(result)),
    onFailure: (error) =>
      Console.log(
        JSON.stringify({ pass: false, unit, error: error.message })
      ).pipe(Effect.andThen(Effect.sync(() => process.exit(1)))),
  })
);

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
