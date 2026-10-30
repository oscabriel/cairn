// Role checks the card's scene tests give it (`RequestCard.test.ts`, `BriefCard.test.ts`, 6B), as
// `roles.check` answers them.

import { Resolution } from "@cairn/client-logic/BriefGo";
import type { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import { RoleName, RoleSpec } from "@cairn/protocol/Roles";
import type { RoleCheck } from "@cairn/protocol/Roles";

/** `role` resolved on its primary binding, `model` at `level`. */
export const resolvedCheck = (
  role: string,
  model: ModelRef,
  level: ThinkingLevel
): ReadonlyArray<RoleCheck> => [
  {
    spec: role,
    resolution: Resolution.cases.Resolved.make({
      resolved: {
        spec: RoleSpec.make(role),
        role: RoleName.make(role),
        model,
        thinkingLevel: level,
        via: "primary",
        skipped: [],
        family: "other",
        priced: false,
      },
    }),
    sameFamilyAsWorker: false,
  },
];

/** `role` not bound in the table. */
export const unboundCheck = (role: string): ReadonlyArray<RoleCheck> => [
  {
    spec: role,
    resolution: Resolution.cases.Unresolved.make({
      reason: "unbound_role",
      skipped: [],
    }),
    sameFamilyAsWorker: false,
  },
];
