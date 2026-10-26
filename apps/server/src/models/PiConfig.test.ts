// Ported in part from cairn-v1, apps/server/test/pi-config.test.ts at 1a5cd4a (the fixture agent
// dir and its skill filters, missing package and refresh cases). Changed: no extensions, mcp.json or
// Executor; the run settings and the read-only checks are new.
//
// Judges PiConfig against a fixture agent dir (never the real ~/.pi/agent): it resolves the skills
// pi would, with settings.json's filters; records a package that is not installed without
// installing it or running anything; reads the defaults, run settings and context files; and leaves
// every file and directory of the agent dir exactly as it was, with no lock entry.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import type { PiSnapshot } from "./PiConfig.ts";
import { PiConfig, settingsErrorText } from "./PiConfig.ts";

/** The fixture's directories, fresh for each case. */
const dirs = { home: "", agent: "", cwd: "", savedHome: Option.none<string>() };

const freshDirs = () => {
  const root = mkdtempSync(path.join(tmpdir(), "cairn-pi-config-"));

  dirs.home = path.join(root, "home");
  dirs.agent = path.join(root, "agent");
  dirs.cwd = path.join(root, "cwd");
  mkdirSync(dirs.cwd, { recursive: true });
  // pi's package manager finds `~/.agents/skills` under $HOME: point it at the fixture.
  dirs.savedHome = Option.fromNullishOr(process.env.HOME);
  process.env.HOME = dirs.home;
};

const restoreHome = () => {
  if (Option.isSome(dirs.savedHome)) {
    process.env.HOME = dirs.savedHome.value;
  }
};

const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const skill = (dir: string, name: string) => {
  write(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: About ${name}.\n---\n\n# ${name}\n`
  );
};

const pkg = (
  name: string,
  manifest: Record<string, ReadonlyArray<string>>,
  files: Record<string, string>
) => {
  const root = path.join(dirs.agent, "npm", "node_modules", name);

  write(
    path.join(root, "package.json"),
    JSON.stringify({ name, version: "1.0.0", pi: manifest })
  );

  for (const [file, text] of Object.entries(files)) {
    write(path.join(root, file), text);
  }

  return root;
};

const SETTINGS = {
  defaultProvider: "opencode-go",
  defaultModel: "kimi-k2",
  defaultThinkingLevel: "high",
  transport: "sse",
  steeringMode: "all",
  compaction: {
    reserveTokens: 20_000,
    modelOverrides: { "opencode-go/kimi-k2": { keepRecentTokens: 9000 } },
  },
  retry: { maxRetries: 7, provider: { timeoutMs: 90_000 } },
  packages: [
    { source: "npm:filtered-pack", skills: ["-skills/two/SKILL.md"] },
    "npm:not-installed-pack",
  ],
  // `!` excludes by glob, `+` forces one back in, `-` forces one out.
  skills: [
    "!skills/group/**",
    "+skills/group/keep/SKILL.md",
    "-skills/solo/SKILL.md",
  ],
};

/** The fixture: user skills under ~/.agents/skills and the agent dir, a package, settings.json. */
const fixture = () => {
  skill(path.join(dirs.home, ".agents/skills/alpha"), "alpha");
  skill(path.join(dirs.home, ".agents/skills/group/drop"), "drop");
  skill(path.join(dirs.home, ".agents/skills/group/keep"), "keep");
  skill(path.join(dirs.agent, "skills/solo"), "solo");
  skill(path.join(dirs.agent, "skills/kept"), "kept");

  const filtered = pkg("filtered-pack", { skills: ["skills"] }, {});

  skill(path.join(filtered, "skills/one"), "one");
  skill(path.join(filtered, "skills/two"), "two");
  write(path.join(dirs.agent, "settings.json"), JSON.stringify(SETTINGS));
  write(path.join(dirs.agent, "AGENTS.md"), "Be brief.\n");
  write(path.join(dirs.agent, "APPEND_SYSTEM.md"), "Also this.\n");
};

/** Every path under `dir` with its kind, size and mtime: what a read-only resolve must not change. */
const listing = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      const stat = statSync(file);

      return `${file} ${entry.isDirectory() ? "d" : "f"} ${String(stat.size)} ${String(stat.mtimeMs)}`;
    })
    .toSorted();

const resolveOnce = Effect.gen(function* () {
  const pi = yield* PiConfig;

  return pi.current();
});

const withPi = <A, E>(effect: Effect.Effect<A, E, PiConfig>) =>
  effect.pipe(
    Effect.provide(
      PiConfig.layerWith({
        agentDir: dirs.agent,
        cwd: dirs.cwd,
        home: dirs.home,
      })
    )
  );

const names = (snapshot: PiSnapshot) =>
  snapshot.skills
    .map((entry) => path.basename(path.dirname(entry.path)))
    .toSorted();

describe("pi's setup, read-only", () => {
  beforeEach(freshDirs);
  afterEach(restoreHome);

  it.live("resolves the user's skills with settings.json's filters", () =>
    Effect.gen(function* () {
      fixture();

      const snapshot = yield* withPi(resolveOnce);

      assert.isTrue(snapshot.loaded);
      assert.deepStrictEqual(names(snapshot), ["alpha", "keep", "kept", "one"]);
      assert.deepStrictEqual(
        [...snapshot.skillRoots].toSorted(),
        [
          path.join(dirs.agent, "npm/node_modules/filtered-pack"),
          path.join(dirs.agent, "skills"),
          path.join(dirs.home, ".agents/skills"),
        ].toSorted()
      );
    })
  );

  it.live(
    "records a package that is not installed, installs nothing and changes nothing",
    () =>
      Effect.gen(function* () {
        fixture();

        const before = listing(dirs.agent);
        const snapshot = yield* withPi(resolveOnce);

        assert.deepStrictEqual(snapshot.missing, ["npm:not-installed-pack"]);
        assert.deepStrictEqual(listing(dirs.agent), before);
        assert.isFalse(
          listing(dirs.agent).some((line) => line.includes(".lock")),
          "no lock entry"
        );
      })
  );

  it.live("reads the defaults, the run settings and the context files", () =>
    Effect.gen(function* () {
      fixture();

      const snapshot = yield* withPi(resolveOnce);

      assert.deepStrictEqual(snapshot.defaults, {
        provider: Option.some("opencode-go"),
        model: Option.some("kimi-k2"),
        thinkingLevel: Option.some("high"),
      });

      const { run } = snapshot;

      assert.strictEqual(run.transport, "sse");
      assert.strictEqual(run.steeringMode, "all");
      assert.strictEqual(run.followUpMode, "one-at-a-time");
      assert.strictEqual(run.compaction.reserveTokens, 20_000);
      assert.deepStrictEqual(
        run.compaction.modelOverrides.get("opencode-go/kimi-k2"),
        { reserveTokens: Option.none(), keepRecentTokens: Option.some(9000) }
      );
      assert.strictEqual(run.retry.maxRetries, 7);
      assert.deepStrictEqual(run.providerRetry.timeoutMs, Option.some(90_000));
      assert.deepStrictEqual(snapshot.contextFiles, [
        { source: "agent", path: path.join(dirs.agent, "AGENTS.md") },
        { source: "append", path: path.join(dirs.agent, "APPEND_SYSTEM.md") },
      ]);
    })
  );

  it.live(
    "reports a settings.json it cannot parse and falls back to pi's defaults",
    () =>
      Effect.gen(function* () {
        write(path.join(dirs.agent, "settings.json"), "{ not json");

        const snapshot = yield* withPi(resolveOnce);

        assert.isFalse(snapshot.loaded);
        assert.include(snapshot.errors.join("\n"), "settings.json");
        assert.isTrue(Option.isNone(snapshot.defaults.model));
        assert.strictEqual(snapshot.run.steeringMode, "one-at-a-time");
      })
  );

  it.live(
    "resolves again on refresh only when a file it read changed; reload always does",
    () =>
      Effect.sync(fixture).pipe(
        Effect.andThen(
          withPi(
            Effect.gen(function* () {
              const pi = yield* PiConfig;
              const first = pi.current();

              assert.strictEqual(yield* pi.refresh, first);

              skill(path.join(dirs.home, ".agents/skills/beta"), "beta");
              // A coarse file system may keep the mtime; move it on so the change is seen.
              utimesSync(path.join(dirs.home, ".agents/skills"), 1, 1);

              const second = yield* pi.refresh;

              assert.notStrictEqual(second, first);
              assert.include(names(second), "beta");
              assert.notStrictEqual(yield* pi.reload, second);
            })
          )
        )
      )
  );
});

describe("a settings parse error", () => {
  it("never repeats the text of settings.json, and stays short", () => {
    let message = "";

    try {
      JSON.parse('{"token": "sk-secret-value" oops}');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    const shown = settingsErrorText(message);

    assert.notInclude(shown, "sk-secret-value");
    assert.isAtMost(settingsErrorText("x".repeat(5000)).length, 200);
  });
});
