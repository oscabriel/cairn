// Judges the git test kit: a commit in a fresh repository fails under each way a caller can steer
// git from outside a test (the control, so the judge can fail), and succeeds once
// `isolateGitEnvironment` has run with every one of them exported; and a global ignore and
// attributes file at git's default paths hides and marks a test's file until the kit runs.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { isolateGitEnvironment } from "./GitTestKit.ts";

const root = mkdtempSync(path.join(tmpdir(), "cairn-git-kit-"));

/** A home whose `.gitconfig` signs every commit with a program that always fails. */
const signingHome = path.join(root, "home");

mkdirSync(signingHome);

writeFileSync(
  path.join(signingHome, ".gitconfig"),
  "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n"
);

/** What a caller can export, each enough to fail a commit. */
const POISONS = {
  // A Cairn thread's `bash` adds its trailer hook this way.
  "a config-defined hook": {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "hook.poison.event",
    GIT_CONFIG_VALUE_0: "pre-commit",
    GIT_CONFIG_KEY_1: "hook.poison.command",
    GIT_CONFIG_VALUE_1: "false",
  },
  // `git -c` in a parent git process reaches its children this way.
  "a parent's -c option": {
    GIT_CONFIG_PARAMETERS:
      "'core.hooksPath'='/nonexistent' 'commit.gpgsign'='true' 'gpg.program'='false'",
  },
  // A git hook runs with the outer repository's directory exported.
  "a hook's repository": { GIT_DIR: "/dev/null/no-repository" },
};

/**
 * Where git looks for a global ignore and attributes file when no config names one: paths, not
 * config, so turning the global config off leaves them on. Each ignores `probe.txt` and sets the
 * `poisoned` attribute on it.
 */
const xdgHome = path.join(root, "xdg");

const plainHome = path.join(root, "plain-home");

for (const configHome of [xdgHome, path.join(plainHome, ".config")]) {
  mkdirSync(path.join(configHome, "git"), { recursive: true });
  writeFileSync(path.join(configHome, "git", "ignore"), "*.txt\n");
  writeFileSync(path.join(configHome, "git", "attributes"), "*.txt poisoned\n");
}

/** What a caller's environment can point git at, each enough to change what a repository sees. */
const PATH_POISONS = {
  "an XDG config home": { XDG_CONFIG_HOME: xdgHome },
  // Git reads `~/.config` when `XDG_CONFIG_HOME` is unset or empty.
  "a home's ~/.config": { HOME: plainHome, XDG_CONFIG_HOME: "" },
};

let repositories = 0;

/** Makes a repository and commits once in it under `env`; git's exit code for the commit. */
const commitUnder = (env: NodeJS.ProcessEnv) => {
  repositories += 1;

  const repo = path.join(root, `repo-${String(repositories)}`);

  spawnSync("git", ["init", "--quiet", "-b", "main", repo], { env });

  const done = spawnSync(
    "git",
    [
      // An identity, and no word on signing: a poison that signs must get its way.
      "-c",
      "user.name=Cairn Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "probe",
    ],
    { cwd: repo, env, encoding: "utf-8" }
  );

  return done.status;
};

/** Makes a repository and asks git, under `env`, what it makes of a fresh `probe.txt` in it. */
const probeUnder = (env: NodeJS.ProcessEnv) => {
  repositories += 1;

  const repo = path.join(root, `repo-${String(repositories)}`);

  spawnSync("git", ["init", "--quiet", "-b", "main", repo], { env });
  writeFileSync(path.join(repo, "probe.txt"), "probe\n");

  const ignored = spawnSync("git", ["check-ignore", "--quiet", "probe.txt"], {
    cwd: repo,
    env,
  });

  const attributes = spawnSync(
    "git",
    ["check-attr", "poisoned", "--", "probe.txt"],
    { cwd: repo, env, encoding: "utf-8" }
  );

  return {
    ignored: ignored.status === 0,
    poisoned: attributes.stdout.includes("poisoned: set"),
  };
};

describe(isolateGitEnvironment, () => {
  it("each poison fails a commit when it reaches git (control)", () => {
    for (const [name, poison] of Object.entries(POISONS)) {
      assert.notStrictEqual(
        commitUnder({ ...process.env, ...poison }),
        0,
        `${name} did not fail the commit, so this judge cannot fail`
      );
    }

    assert.notStrictEqual(
      commitUnder({
        ...process.env,
        HOME: signingHome,
        GIT_CONFIG_GLOBAL: path.join(signingHome, ".gitconfig"),
      }),
      0,
      "a signing global config did not fail the commit"
    );

    for (const [name, poison] of Object.entries(PATH_POISONS)) {
      assert.deepStrictEqual(
        probeUnder({
          ...process.env,
          ...poison,
          GIT_CONFIG_GLOBAL: "/dev/null",
        }),
        { ignored: true, poisoned: true },
        `${name} did not reach git with the global config off, so this judge cannot fail`
      );
    }
  });

  it("removes every one of them from the process, and the user's global config", () => {
    for (const poison of Object.values(POISONS)) {
      Object.assign(process.env, poison);
    }

    isolateGitEnvironment();

    for (const poison of Object.values(POISONS)) {
      for (const name of Object.keys(poison)) {
        assert.notProperty(process.env, name);
      }
    }

    assert.strictEqual(commitUnder({ ...process.env, HOME: signingHome }), 0);
  });

  it("leaves the default global ignore and attributes files out", () => {
    isolateGitEnvironment();

    for (const [name, poison] of Object.entries(PATH_POISONS)) {
      assert.deepStrictEqual(
        probeUnder({ ...process.env, ...poison }),
        { ignored: false, poisoned: false },
        `${name} still reached git`
      );
    }
  });
});
