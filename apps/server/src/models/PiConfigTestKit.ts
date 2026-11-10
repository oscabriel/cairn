// What a test that builds the brain's own pi setup (`PiConfig.layer`, through `Skills.live` or
// `PiDurableBrain`) shares: an empty pi setup in a temporary folder, so the test never reads the
// user's `~/.pi/agent` (settings, skills, context files, auth) or `~/.agents/skills`, and checks the
// same thing on every machine. Never imported by production code.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The empty pi setup `isolatePiSetup` points the process at. */
export interface EmptyPiSetup {
  /** `$HOME`: an empty folder, so no `.agents/skills`. */
  readonly home: string;
  /** `PI_CODING_AGENT_DIR`: an empty agent dir, so no settings, packages, skills or context files. */
  readonly agentDir: string;
}

/**
 * Points pi's agent dir (`PI_CODING_AGENT_DIR`) and `$HOME` at new empty folders, at once and for
 * the rest of the process. Call it at the top of the test file, before any layer resolves pi's
 * setup. A test that commits must then pass its git identity itself, since `$HOME` holds no
 * `.gitconfig` (`isolateGitEnvironment` asks the same).
 */
export const isolatePiSetup = (): EmptyPiSetup => {
  const root = mkdtempSync(path.join(tmpdir(), "cairn-pi-empty-"));
  const home = path.join(root, "home");
  const agentDir = path.join(home, ".pi", "agent");

  mkdirSync(agentDir, { recursive: true });

  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  return { home, agentDir };
};
