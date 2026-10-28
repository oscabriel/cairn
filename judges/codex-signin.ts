// The Codex sign-in on the deployed brain, for the phase 2 wizard's Codex stage (ADR 0037). It
// drives `providers.login.start` on `cairn.service` straight to its port with the headers Caddy
// would add (as `ops/cairn/deploy-check.ts` does), prints the device code and the page to enter it
// on, waits for the user to finish (from any device), then checks `providers.status` says Codex is
// ready and `models.list` offers `openai-codex/gpt-6-luna`.
//
//   node judges/codex-signin.ts [--port 3774] [--config ~/.config/cairn/cairn.json]
//
// The tokens never pass through this script: the brain stores them in its own `cairn.sqlite`.
// What is printed is the one-time device code the user types, the account's email and the states.
// Prints one JSON line last and exits 0 when the sign-in ended `SignedIn` and Codex is ready.

import { homedir } from "node:os";
import { parseArgs } from "node:util";

import type { LoginProgress } from "@cairn/protocol/Models";
import { NodeServices } from "@effect/platform-node";
import {
  Console,
  Effect,
  FileSystem,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";

import * as ProtocolClient from "./lib/ProtocolClient.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3774" },
    config: {
      type: "string",
      default: `${homedir()}/.config/cairn/cairn.json`,
    },
  },
});

const CODEX = "openai-codex";

const CairnJson = Schema.fromJsonString(
  Schema.Struct({
    owner: Schema.String,
    host: Schema.String,
    origin: Schema.String,
  })
);

const decodeCairnJson = Schema.decodeEffect(CairnJson);

/** What the terminal shows for one step. */
const describe = (step: LoginProgress): string => {
  if (Predicate.isTagged(step, "DeviceCode")) {
    return `\n  Open ${step.verificationUri} on any device and enter the code\n\n      ${step.userCode}\n\n  (it expires in ${Math.round(step.expiresInSeconds / 60)} minutes)\n`;
  }

  if (Predicate.isTagged(step, "AuthUrl")) {
    return `  Open ${step.url}`;
  }

  if (Predicate.isTagged(step, "Progress")) {
    return `  ${step.message}`;
  }

  if (Predicate.isTagged(step, "SignedIn")) {
    return `  Signed in${Option.match(step.account, { onNone: () => "", onSome: (account) => ` as ${account}` })}.`;
  }

  return `  Sign-in ${step.reason}: ${step.message}`;
};

/** A step's tag, or a failure's reason. */
const labelOf = (step: LoginProgress) =>
  Predicate.isTagged(step, "Failed") ? step.reason : step._tag;

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const config = yield* decodeCairnJson(
    yield* fs.readFileString(values.config)
  );

  const client = yield* ProtocolClient.cairn({
    base: `http://127.0.0.1:${values.port}`,
    origin: config.origin,
    headers: { Host: config.host, "X-Cairn-User": config.owner },
  });

  yield* client["session.hello"]();

  const steps = yield* client["providers.login.start"]({
    provider: CODEX,
  }).pipe(
    Stream.tap((step) => Console.log(describe(step))),
    Stream.runCollect
  );

  const last = Option.fromUndefinedOr(steps.at(-1));
  const result = Option.match(last, { onNone: () => "none", onSome: labelOf });

  const account = Option.getOrElse(
    Option.flatMap(last, (step) =>
      Predicate.isTagged(step, "SignedIn") ? step.account : Option.none()
    ),
    () => ""
  );

  const statuses = yield* client["providers.status"]();
  const codex = statuses.find((status) => status.provider === CODEX);
  const catalog = yield* client["models.list"]();

  const luna = catalog.models.find(
    (model) => model.provider === CODEX && model.modelId === "gpt-6-luna"
  );

  const state = codex?.state ?? "absent";
  const lunaAvailable = luna?.available ?? false;

  return {
    judge: "codex-signin",
    pass: result === "SignedIn" && state === "ready" && lunaAvailable,
    result,
    account,
    state,
    lunaAvailable,
  };
});

const line = await Effect.runPromise(
  Effect.scoped(program).pipe(
    Effect.provide(NodeServices.layer),
    Effect.catch((error) =>
      Effect.succeed({
        judge: "codex-signin",
        pass: false,
        error: String(error).slice(0, 300),
      })
    )
  )
);

process.stdout.write(`${JSON.stringify(line)}\n`);

process.exitCode = line.pass ? 0 : 1;
