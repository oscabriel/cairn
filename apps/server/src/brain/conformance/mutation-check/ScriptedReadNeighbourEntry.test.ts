// The mutation check (ADR 0024): the scripted harness broken by read_neighbour_entry alone.
// One file per mutation set, so Vitest runs each on a worker of its own (`../MutationCheck.ts`).

import { describe, it } from "@effect/vitest";

import { registerMutationCheck } from "../MutationCheck.ts";

registerMutationCheck({ describe, it }, "scripted", "read_neighbour_entry");
