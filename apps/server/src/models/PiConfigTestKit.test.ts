// Judges the pi setup test kit: the brain's own `PiConfig.layer` follows `PI_CODING_AGENT_DIR` and
// `$HOME`, and reads a populated setup there before `isolatePiSetup` runs (the control, so the judge
// can fail, built in a temporary folder rather than read from the user's machine), and an empty
// agent dir with no skills, packages or context files after it.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../Config.ts";
import { PiConfig } from "./PiConfig.ts";
import { isolatePiSetup } from "./PiConfigTestKit.ts";

/** The brain's pi setup, as `PiConfig.layer` resolves it under the current environment. */
const brainPiSetup = Effect.gen(function* () {
  const pi = yield* PiConfig;

  return pi.current();
}).pipe(
  Effect.provide(
    PiConfig.layer.pipe(
      Layer.provide(
        ServerConfig.layerWith({
          dataDir: mkdtempSync(path.join(tmpdir(), "cairn-pi-kit-")),
        })
      )
    )
  )
);

/** A setup like a user's: a skill under `~/.agents/skills` and a context file in the agent dir. */
const populatedSetup = () => {
  const home = path.join(
    mkdtempSync(path.join(tmpdir(), "cairn-pi-full-")),
    "home"
  );

  const agentDir = path.join(home, ".pi", "agent");
  const skill = path.join(home, ".agents", "skills", "probe");

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(skill, { recursive: true });
  writeFileSync(path.join(agentDir, "AGENTS.md"), "Probe context.\n");
  writeFileSync(
    path.join(skill, "SKILL.md"),
    "---\nname: probe\ndescription: A probe skill.\n---\n\nProbe.\n"
  );

  return { home, agentDir };
};

describe(isolatePiSetup, () => {
  it.effect(
    "the brain's pi setup reads whatever the environment names (control)",
    () =>
      Effect.gen(function* () {
        const full = populatedSetup();

        process.env.HOME = full.home;
        process.env.PI_CODING_AGENT_DIR = full.agentDir;

        const before = yield* brainPiSetup;

        assert.strictEqual(before.agentDir, full.agentDir);
        assert.deepStrictEqual(
          before.skills.map((skill) => path.basename(path.dirname(skill.path))),
          ["probe"]
        );
        assert.lengthOf(before.contextFiles, 1);
      })
  );

  it.effect("points the brain's pi setup at an empty agent dir and home", () =>
    Effect.gen(function* () {
      const empty = isolatePiSetup();
      const after = yield* brainPiSetup;

      assert.strictEqual(after.agentDir, empty.agentDir);
      assert.deepStrictEqual(after.skills, []);
      assert.deepStrictEqual(after.extensions, []);
      assert.deepStrictEqual(after.contextFiles, []);
    })
  );
});
