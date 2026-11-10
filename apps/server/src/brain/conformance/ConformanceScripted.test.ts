// The conformance suite (ADR 0024) on the scripted harness: every scenario it passes, and every
// scenario still pending on it failing. See `ConformanceSuite.ts` for the judge's other parts.

import { describe, it } from "@effect/vitest";

import { registerSide } from "./ConformanceSuite.ts";

registerSide({ describe, it }, "scripted");
