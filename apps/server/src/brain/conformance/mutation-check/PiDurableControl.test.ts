// The mutation check's control (ADR 0024): the unmutated pi-durable harness at the check's timeout.
// One file per mutation set, so Vitest runs each on a worker of its own (`../MutationCheck.ts`).

import { describe, it } from "@effect/vitest";

import { registerMutationCheck } from "../MutationCheck.ts";

registerMutationCheck({ describe, it }, "pi-durable", "control");
