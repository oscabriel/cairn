// Model checks the card's scene tests give it (`RequestCard.test.ts`, `BriefCard.test.ts`, 6B), as
// `models.check` answers them.

import { Resolution } from "@cairn/client-logic/BriefGo";
import type { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import { ModelSpec } from "@cairn/protocol/ModelSpecs";
import type { ModelCheck, ModelCheckFailure } from "@cairn/protocol/ModelSpecs";

/** `spec` resolved to `model` at `level`. */
export const resolvedCheck = (
  spec: string,
  model: ModelRef,
  level: ThinkingLevel
): ReadonlyArray<ModelCheck> => [
  {
    spec,
    resolution: Resolution.cases.Resolved.make({
      resolved: {
        spec: ModelSpec.make(spec),
        model,
        thinkingLevel: level,
        priced: false,
      },
    }),
  },
];

/** `spec` not ready, for `reason`. */
export const unreadyCheck = (
  spec: string,
  reason: ModelCheckFailure
): ReadonlyArray<ModelCheck> => [
  { spec, resolution: Resolution.cases.Unresolved.make({ reason }) },
];
