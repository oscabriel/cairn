// The mutation check (ADR 0028): the scripted harness broken by deliver_twice alone.
// One file per mutation set, so Vitest runs each on a worker of its own (`../MutationCheck.ts`).

import { describe, it } from "@effect/vitest";

import { registerMutationCheck } from "../MutationCheck.ts";

registerMutationCheck({ describe, it }, "scripted", "deliver_twice");
