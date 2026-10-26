// The outside judge of `SkillCatalog`'s user skills: pi's own `DefaultResourceLoader`, run against a
// given agent dir and home, so a test or `judges/skills.ts` can compare Cairn's skills section with
// the skills pi itself would load there. Never pointed at the owner's real `~/.pi/agent`: the
// loader's defaults lock and write `settings.json` and install missing packages, so this oracle
// gives it a read-only settings storage, answers "skip" for every missing package, and refuses
// every process its package manager would start. Extensions, prompt templates, themes and context
// files are not loaded. Judge code: nothing in the brain calls it.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { Effect, Order, Schema } from "effect";

import { errorText } from "../brain/Durable.ts";

/** pi's loader failed; the message says where. */
export class PiSkillsOracleError extends Schema.TaggedError<PiSkillsOracleError>()(
  "PiSkillsOracleError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  }
) {}

/** One skill as pi's loader reports it. */
export interface OracleSkill {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly disableModelInvocation: boolean;
}

/** What pi's loader gives a session in this agent dir. */
export interface OracleResult {
  /** Every skill, sorted by name. */
  readonly skills: ReadonlyArray<OracleSkill>;
  /** `formatSkillsForPrompt` over the skills sorted by name, trimmed; the `keep` filter applied. */
  readonly prompt: string;
  readonly diagnostics: ReadonlyArray<string>;
}

type SettingsStorage = Parameters<
  typeof PiCodingAgent.SettingsManager.fromStorage
>[0];

type SettingsScope = Parameters<SettingsStorage["withLock"]>[0];

/** Reads the global settings without a lock; any write throws. */
class ReadOnlyStorage implements SettingsStorage {
  readonly settingsPath: string;

  constructor(settingsPath: string) {
    this.settingsPath = settingsPath;
  }

  withLock(
    scope: SettingsScope,
    fn: (current: string | undefined) => string | undefined
  ): void {
    const current =
      scope === "global" && existsSync(this.settingsPath)
        ? readFileSync(this.settingsPath, "utf-8")
        : undefined;

    if (fn(current) !== undefined) {
      throw new Error("The skills oracle refused a write to settings.json.");
    }
  }
}

/** Every package manager method that starts a process (pi 1.4.0). */
const SPAWNS = [
  "spawnCommand",
  "spawnCaptureCommand",
  "runCommand",
  "runCommandSync",
  "runCommandCapture",
] as const;

/** Refuses every process `packages` would start, and skips every missing package. */
const fence = (packages: PiCodingAgent.DefaultPackageManager) => {
  for (const name of SPAWNS) {
    Reflect.set(packages, name, (command: string) => {
      throw new Error(
        `The skills oracle runs no command (asked for ${command}).`
      );
    });
  }

  const resolve = packages.resolve.bind(packages);

  // Every missing package is skipped, never installed.
  packages.resolve = async () =>
    await resolve(async () => await Promise.resolve("skip" as const));
};

const byName = Order.mapInput(Order.String, (skill: OracleSkill) => skill.name);

/**
 * The skills pi's `DefaultResourceLoader` loads for a session in `agentDir`, with project settings
 * untrusted. `keep` picks the skills that go into `prompt` besides pi's own
 * `disable-model-invocation` rule (Cairn also leaves out text the Claude bridge refuses).
 */
export const piSkillsOracle = Effect.fn("PiSkillsOracle")(function* (options: {
  readonly agentDir: string;
  readonly cwd: string;
  readonly keep: (skill: OracleSkill) => boolean;
}) {
  return yield* Effect.tryPromise({
    try: async (): Promise<OracleResult> => {
      const pi = await import("@earendil-works/pi-coding-agent");

      const settingsManager = pi.SettingsManager.fromStorage(
        new ReadOnlyStorage(path.join(options.agentDir, "settings.json")),
        { projectTrusted: false }
      );

      const loader = new pi.DefaultResourceLoader({
        cwd: options.cwd,
        agentDir: options.agentDir,
        settingsManager,
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });

      // The loader's package manager is private; it is read once here, by name.
      const packages: unknown = Object.getOwnPropertyDescriptor(
        loader,
        "packageManager"
      )?.value;

      if (!(packages instanceof pi.DefaultPackageManager)) {
        throw new TypeError(
          "pi's resource loader has no package manager; check the oracle against this pi version."
        );
      }

      fence(packages);
      await loader.reload();

      const { skills, diagnostics } = loader.getSkills();
      const sorted = skills.toSorted(byName);

      const kept = sorted.filter((skill) =>
        options.keep({
          name: skill.name,
          description: skill.description,
          filePath: skill.filePath,
          disableModelInvocation: skill.disableModelInvocation,
        })
      );

      return {
        skills: sorted.map((skill) => ({
          name: skill.name,
          description: skill.description,
          filePath: skill.filePath,
          disableModelInvocation: skill.disableModelInvocation,
        })),
        prompt: pi.formatSkillsForPrompt(kept, "read").trim(),
        diagnostics: diagnostics.map(
          (diagnostic) => `${diagnostic.type}: ${diagnostic.message}`
        ),
      };
    },
    catch: (cause) =>
      new PiSkillsOracleError({
        message: `pi's resource loader failed in ${options.agentDir}: ${errorText(cause)}`,
        cause,
      }),
  });
});
