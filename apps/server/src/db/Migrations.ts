// Every `cairn.sqlite` migration in one record (a seam: the integrator adds each package's
// migration here). One id space; keys are `<NNNN>_<Name>` and files `migrations/<NNNN><Name>.ts`.
import type { MigrationRecord } from "./Database.ts";
import { Shell0001 } from "./migrations/0001Shell.ts";

/** Every cairn.sqlite migration, keyed <NNNN>_<Name>; one id space. */
export const migrations: MigrationRecord = {
  "0001_Shell": Shell0001,
};
