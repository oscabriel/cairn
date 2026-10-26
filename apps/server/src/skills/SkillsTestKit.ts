// A copy of `judges/fixtures/pi-home` in a temporary directory, as a pretend `$HOME` with an agent
// dir (`.pi/agent`), user skills (`.agents/skills`), a local package and a project whose git root
// is made here (a `.git` cannot be committed inside the repo). Tests and `judges/skills.ts` edit
// the copy, never the fixture.

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The committed fixture tree. */
export const FIXTURE_HOME = path.resolve(
  import.meta.dirname,
  "../../../../judges/fixtures/pi-home"
);

/** One copy of the fixture. */
export interface FixtureHome {
  /** The pretend `$HOME`. */
  readonly home: string;
  /** `<home>/.pi/agent`. */
  readonly agentDir: string;
  /** An empty directory pi may take as its cwd. */
  readonly piCwd: string;
  /** `<home>/project`, a git repository root. */
  readonly project: string;
  /** Removes the copy. */
  remove(): void;
}

/** Copies the fixture into a new temporary directory. */
export const makeFixtureHome = (): FixtureHome => {
  const base = mkdtempSync(path.join(os.tmpdir(), "cairn-pi-home-"));
  const home = path.join(base, "home");

  cpSync(FIXTURE_HOME, home, { recursive: true });
  mkdirSync(path.join(home, "project", ".git"));

  const piCwd = path.join(base, "pi-cwd");

  mkdirSync(piCwd);

  return {
    home,
    agentDir: path.join(home, ".pi", "agent"),
    piCwd,
    project: path.join(home, "project"),
    remove: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
};
