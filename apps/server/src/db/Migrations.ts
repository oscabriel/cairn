// Every `cairn.sqlite` migration in one record (a seam: the integrator adds each package's
// migration here). One id space; keys are `<NNNN>_<Name>` and files `migrations/<NNNN><Name>.ts`.
//
// Reserved for phase 2 (plan step 1.0), so packages that run in parallel never take the same id.
// Each package writes its file under its number and hands the integrator the line to add below:
// - 0007_OAuthCredentials: `oauth_credentials` (1D, ADR 0037)
// - 0008_ModelHealth: a provider's last success, auth failure and transient failures (1C)
// - 0009_Spend: `spend_totals` and `spend_events` (2C)
// - 0010_Artifacts: `artifacts` (2F, the reach index)
// - 0011_Portals: `portals` (2F, ADR 0038)
// - 0012_ChildWorkspaces: `child_workspaces` (3B)
// A phase 2 package that needs a table not listed here asks the integrator for the next number.

import type { MigrationRecord } from "./Database.ts";
import { Shell0001 } from "./migrations/0001Shell.ts";
import { Launches0002 } from "./migrations/0002Launches.ts";
import { Attachments0003 } from "./migrations/0003Attachments.ts";
import { Executor0004 } from "./migrations/0004Executor.ts";
import { Push0005 } from "./migrations/0005Push.ts";
import { ExecutorSignal0006 } from "./migrations/0006ExecutorSignal.ts";
import { OAuthCredentials0007 } from "./migrations/0007OAuthCredentials.ts";
import { ModelHealth0008 } from "./migrations/0008ModelHealth.ts";

/** Every cairn.sqlite migration, keyed <NNNN>_<Name>; one id space. */
export const migrations: MigrationRecord = {
  "0001_Shell": Shell0001,
  "0002_Launches": Launches0002,
  "0003_Attachments": Attachments0003,
  "0004_Executor": Executor0004,
  "0005_Push": Push0005,
  "0006_ExecutorSignal": ExecutorSignal0006,
  "0007_OAuthCredentials": OAuthCredentials0007,
  "0008_ModelHealth": ModelHealth0008,
};
