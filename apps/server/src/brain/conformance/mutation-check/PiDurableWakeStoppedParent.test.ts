// The mutation check (ADR 0028): the pi-durable harness broken by wake_stopped_parent alone.
// One file per mutation set, so Vitest runs each on a worker of its own (`../MutationCheck.ts`).

import { describe, it } from "@effect/vitest";

import { registerMutationCheck } from "../MutationCheck.ts";

registerMutationCheck({ describe, it }, "pi-durable", "wake_stopped_parent");
