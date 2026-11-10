// What every test that runs git shares: an environment git cannot be steered through from outside
// the test. Never imported by production code: Cairn's own `Git` keeps the user's global config on
// purpose, and runs under systemd with none of these variables set.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Removes every inherited `GIT_*` variable from this test process and replaces git's global and
 * system config with the kit's own, at once and for the rest of the process, so every git the file
 * starts (through `Git` or directly) sees only what the test sets up. Call it at the top of the test
 * file, before anything runs git.
 *
 * The gate can run inside a Cairn thread, whose `bash` exports `GIT_CONFIG_*` to add its trailer
 * hook (git 2.54's config-defined hooks, which `core.hooksPath=/dev/null` does not switch off), or
 * inside a git hook, which exports `GIT_DIR` and `GIT_INDEX_FILE`; a user's `~/.gitconfig` can
 * sign commits or add hooks of its own, and their global ignore and attributes files
 * (`$XDG_CONFIG_HOME/git/ignore`, else `~/.config/git/ignore`), which git reads even with no global
 * config, can hide a test's files. Each changes what a test repository does, so none may reach
 * one. A test's own repositories pass their identity on the command line (`COMMIT_OPTIONS`).
 */
export const isolateGitEnvironment = () => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GIT_")) {
      Reflect.deleteProperty(process.env, name);
    }
  }

  const globalConfig = path.join(
    mkdtempSync(path.join(tmpdir(), "cairn-git-kit-")),
    "gitconfig"
  );

  writeFileSync(
    globalConfig,
    "[core]\n\texcludesFile = /dev/null\n\tattributesFile = /dev/null\n"
  );

  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
};
