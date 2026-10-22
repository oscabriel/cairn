// Every `cairn.sqlite` migration in one record (a seam: the integrator adds each package's
// migration here). One id space; keys are `<NNNN>_<Name>` and files `migrations/<NNNN><Name>.ts`.
import type { MigrationRecord } from "./Database.ts";
import { Shell0001 } from "./migrations/0001Shell.ts";
import { Launches0002 } from "./migrations/0002Launches.ts";
import { Attachments0003 } from "./migrations/0003Attachments.ts";
import { Executor0004 } from "./migrations/0004Executor.ts";
import { Push0005 } from "./migrations/0005Push.ts";
import { ExecutorSignal0006 } from "./migrations/0006ExecutorSignal.ts";

/** Every cairn.sqlite migration, keyed <NNNN>_<Name>; one id space. */
export const migrations: MigrationRecord = {
  "0001_Shell": Shell0001,
  "0002_Launches": Launches0002,
  "0003_Attachments": Attachments0003,
  "0004_Executor": Executor0004,
  "0005_Push": Push0005,
  "0006_ExecutorSignal": ExecutorSignal0006,
};
