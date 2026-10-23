// The deployed unit's durability judge (plan 5F; ADR 0022's gate on the real `cairn.service`):
//
//   node judges/deployed-unit.ts restarts  [--unit cairn.service] [--model opencode-go/claude-haiku-5-5] [--keep]
//   node judges/deployed-unit.ts streaming [--unit cairn.service] [--model claude-bridge/claude-haiku-5-5] [--keep]
//
// `judges/shutdown.sh --unit cairn.service` runs `restarts`; `judges/durability.ts --unit
// cairn.service --window streaming` runs `streaming`. The checks are `lib/DeployedUnit.ts`'s. This
// restarts and kills the production brain, so every open client sees a short reconnect; one turn on a
// cheap real model each (cents). Prints one JSON line and exits 0 on a pass. Prints no secret and no
// reply text.
import { parseArgs } from "node:util";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";

import * as DeployedUnit from "./lib/DeployedUnit.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    unit: { type: "string", default: "cairn.service" },
    model: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});

const [check] = positionals;

const program = Effect.gen(function* () {
  if (check === "restarts") {
    return yield* DeployedUnit.restarts({
      unit: values.unit,
      model: values.model ?? "opencode-go/claude-haiku-5-5",
      keep: values.keep,
    });
  }

  if (check === "streaming") {
    return yield* DeployedUnit.streaming({
      unit: values.unit,
      model: values.model ?? "claude-bridge/claude-haiku-5-5",
      keep: values.keep,
    });
  }

  return { pass: false, notes: ["usage: deployed-unit.ts restarts|streaming"] };
}).pipe(
  Effect.matchEffect({
    onSuccess: (result) =>
      Effect.andThen(Console.log(JSON.stringify(result)), () =>
        result.pass ? Effect.void : Effect.sync(() => process.exit(1))
      ),
    onFailure: (error) =>
      Effect.andThen(
        Console.log(
          JSON.stringify({ check, pass: false, notes: [error.message] })
        ),
        Effect.sync(() => process.exit(1))
      ),
  })
);

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
