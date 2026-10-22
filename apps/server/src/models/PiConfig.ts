// Ported from cairn-v1, apps/server/src/PiConfig.ts at 1a5cd4a (the fenced package manager, the
// skill roots, the context file names and the mtime cache). Changed: settings are read through a
// read-only storage (`SettingsManager.fromStorage`), never `SettingsManager.create`, which locks
// `settings.json` even to read; extension hosting, mcp.json and the Executor declaration are gone;
// the run settings pi's TUI uses (compaction, retry, steering, follow-up, transport) are read here
// for `HarnessSettings`; time comes from `Clock`.
//
// What the user's pi setup (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`) gives Cairn, read through
// pi-coding-agent's own classes so Cairn and pi agree on it: the skills pi resolves (with
// settings.json's `+`, `-` and `!` filters), the default model and thinking level, the run settings
// and the agent-level context files. Strictly read-only:
//
// - settings.json is read through a storage whose lock never locks and which refuses any write;
//   project settings are never read (`projectTrusted: false`, from an empty host-owned cwd), so no
//   repo's `.pi/` is ever loaded,
// - the package manager only resolves: a missing package is recorded, never installed (`onMissing`
//   answers "skip"), and every method it has to start a process is replaced by a refusal, so no npm
//   or git child ever runs,
// - auth.json and mcp-auth.json are never read here (`CairnCredentialStore` reads auth.json).
//
// A resolve costs about 400 ms (it walks every skill tree), so it is cached against the mtimes of
// the files and directories it reads: `refresh` resolves again only when one changed, `reload`
// always does. pi-coding-agent is imported lazily, when the layer is built.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ThinkingLevel } from "@cairn/protocol/Models";
import { ThinkingLevel as ThinkingLevelSchema } from "@cairn/protocol/Models";
import type * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  Semaphore,
} from "effect";

import { errorText } from "../brain/Durable.ts";
import { ServerConfig } from "../Config.ts";

/** pi-coding-agent could not be loaded. Boot stops; reinstall the brain's dependencies. */
export class PiConfigError extends Schema.TaggedError<PiConfigError>()(
  "PiConfigError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  }
) {}

/** A skill file pi resolved, and the outermost root it lives under. */
export interface PiSkill {
  readonly path: string;
  readonly root: string;
}

/** An agent-level context file: `AGENTS.md` (or pi's other names for it) or `APPEND_SYSTEM.md`. */
export interface PiContextFile {
  readonly source: "agent" | "append";
  readonly path: string;
}

/** The queue modes pi and pi-durable share. */
export type PiQueueMode = "all" | "one-at-a-time";

/** pi's transport setting. */
export type PiTransport = "auto" | "sse" | "websocket" | "websocket-cached";

/** A per-model compaction override from pi's settings, keyed `provider/modelId`. */
export interface PiCompactionOverride {
  readonly reserveTokens: Option.Option<number>;
  readonly keepRecentTokens: Option.Option<number>;
}

/** The run settings pi's TUI uses, resolved over pi's own defaults. */
export interface PiRunSettings {
  readonly compaction: {
    readonly enabled: boolean;
    readonly reserveTokens: number;
    readonly keepRecentTokens: number;
    readonly modelOverrides: ReadonlyMap<string, PiCompactionOverride>;
  };
  readonly retry: {
    readonly enabled: boolean;
    readonly maxRetries: number;
    readonly baseDelayMs: number;
    readonly maxAgentDelayMs: number;
  };
  /** Retries inside one provider request (pi's `retry.provider`). */
  readonly providerRetry: {
    readonly timeoutMs: Option.Option<number>;
    readonly maxRetries: Option.Option<number>;
    readonly maxRetryDelayMs: number;
  };
  readonly steeringMode: PiQueueMode;
  readonly followUpMode: PiQueueMode;
  readonly transport: PiTransport;
}

/** pi's defaults for a new thread, each absent when settings.json sets none. */
export interface PiDefaults {
  readonly provider: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly thinkingLevel: Option.Option<ThinkingLevel>;
}

/** One resolve of the agent dir. */
export interface PiSnapshot {
  readonly agentDir: string;
  /** False when settings.json could not be read; everything else then comes from pi's defaults. */
  readonly loaded: boolean;
  readonly loadedAt: DateTime.Utc;
  readonly skills: ReadonlyArray<PiSkill>;
  /** The distinct roots of `skills`, outermost only. */
  readonly skillRoots: ReadonlyArray<string>;
  /** Package sources settings.json names that are not installed. */
  readonly missing: ReadonlyArray<string>;
  readonly defaults: PiDefaults;
  readonly run: PiRunSettings;
  readonly contextFiles: ReadonlyArray<PiContextFile>;
  /** Problems found while resolving, as sentences; never a credential. */
  readonly errors: ReadonlyArray<string>;
  /** What the cache compares: every path the resolve reads, with its mtime and size. */
  readonly fingerprint: string;
}

/** Where to read pi's setup from. */
export interface PiConfigOptions {
  readonly agentDir: string;
  /** An empty directory Cairn owns, pi's cwd: with project trust off nothing in it is read. */
  readonly cwd: string;
  /** Where `~/.agents/skills` is (pi's own rule reads `$HOME`). */
  readonly home: string;
}

/** pi's names for a directory's context file, in its order (`loadContextFileFromDir`). */
export const CONTEXT_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

/** The first of pi's context file names present in `dir` (a file or a symlink, never followed). */
export const contextFileIn = (dir: string): Option.Option<string> =>
  Option.fromNullishOr(
    CONTEXT_FILE_NAMES.map((name) => path.join(dir, name)).find((file) => {
      const stat = lstatSync(file, { throwIfNoEntry: false });

      return stat !== undefined && (stat.isFile() || stat.isSymbolicLink());
    })
  );

const isUnder = (file: string, dir: string): boolean => {
  const rel = path.relative(dir, file);

  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const mtimeOf = (file: string): string => {
  const stat = statSync(file, { throwIfNoEntry: false });

  return stat === undefined
    ? "-"
    : `${String(stat.mtimeMs)}:${String(stat.size)}`;
};

/** The directories one level under `dir`: a skill added inside a group changes the group's mtime. */
const childDirs = (dir: string): ReadonlyArray<string> => {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules"
    )
    .map((entry) => path.join(dir, entry.name));
};

/** The mtimes a resolve depends on, as one string. */
export const fingerprintOf = (options: PiConfigOptions): string => {
  const { agentDir, home } = options;

  const skillDirs = [
    path.join(agentDir, "skills"),
    path.join(home, ".agents", "skills"),
  ];

  const files = [
    path.join(agentDir, "settings.json"),
    path.join(agentDir, "APPEND_SYSTEM.md"),
    ...CONTEXT_FILE_NAMES.map((name) => path.join(agentDir, name)),
    path.join(agentDir, "npm", "node_modules"),
    path.join(agentDir, "git"),
    ...skillDirs,
    ...skillDirs.flatMap(childDirs),
  ];

  return files.map((file) => `${file}=${mtimeOf(file)}`).join("\n");
};

/** The settings storage type pi's `SettingsManager.fromStorage` takes (not exported by name). */
type SettingsStorage = Parameters<
  typeof PiCodingAgent.SettingsManager.fromStorage
>[0];

type SettingsScope = Parameters<SettingsStorage["withLock"]>[0];

/**
 * pi's settings storage, read-only: the global scope reads `settings.json` without a lock, the
 * project scope reads nothing, and any write throws (pi records it as a settings error).
 */
class ReadOnlySettingsStorage implements SettingsStorage {
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
      throw new Error(
        "PiConfig refused a write to pi's settings.json: Cairn reads pi's settings read-only."
      );
    }
  }
}

/** The package manager methods every child process it starts goes through (pi 1.4.0). */
const PACKAGE_MANAGER_SPAWNS = [
  "spawnCommand",
  "spawnCaptureCommand",
  "runCommand",
  "runCommandCapture",
  "runCommandSync",
] as const;

/**
 * Replaces every way the package manager has to start a process with a refusal. A resolve may
 * otherwise run one: a user package missing from `<agentDir>/npm` is looked up under the global npm
 * root (`npm root -g`). The lookup catches the refusal and the package reads as not installed.
 * Returns the names it could not find, which means pi changed and the fence must be checked.
 */
const fencePackageManager = (
  packages: PiCodingAgent.DefaultPackageManager
): ReadonlyArray<string> => {
  const absent = PACKAGE_MANAGER_SPAWNS.filter(
    (name) =>
      !(
        Predicate.hasProperty(packages, name) &&
        Predicate.isFunction(packages[name])
      )
  );

  for (const name of PACKAGE_MANAGER_SPAWNS) {
    Reflect.set(packages, name, (command: string) => {
      throw new Error(
        `PiConfig runs no command for pi's package manager (it asked for ${command}).`
      );
    });
  }

  return absent;
};

const isThinkingLevel = Schema.is(ThinkingLevelSchema);

const optionalNumber = (value: number | undefined): Option.Option<number> =>
  Option.fromNullishOr(value);

/** Reads pi's run settings, with pi's own defaults filling what settings.json leaves out. */
const runSettingsOf = (
  settings: PiCodingAgent.SettingsManager
): PiRunSettings => {
  const compaction = settings.getCompactionSettings();

  const overrides =
    settings.getGlobalSettings().compaction?.modelOverrides ?? {};

  const retry = settings.getRetrySettings();
  const providerRetry = settings.getProviderRetrySettings();

  return {
    compaction: {
      enabled: compaction.enabled,
      reserveTokens: compaction.reserveTokens,
      keepRecentTokens: compaction.keepRecentTokens,
      modelOverrides: new Map(
        Object.entries(overrides).map(([key, override]) => [
          key,
          {
            reserveTokens: optionalNumber(override.reserveTokens),
            keepRecentTokens: optionalNumber(override.keepRecentTokens),
          },
        ])
      ),
    },
    retry,
    providerRetry: {
      timeoutMs: optionalNumber(providerRetry.timeoutMs),
      maxRetries: optionalNumber(providerRetry.maxRetries),
      maxRetryDelayMs: providerRetry.maxRetryDelayMs,
    },
    steeringMode: settings.getSteeringMode(),
    followUpMode: settings.getFollowUpMode(),
    transport: settings.getTransport(),
  };
};

/** The skills pi resolved and enabled, each taken as its `SKILL.md` the way pi's loader maps it. */
/** The root a skill file lives under when no user skill dir holds it. */
const ownRootOf = (
  file: string,
  fileIsDir: boolean,
  packageRoot: string | undefined
): string => {
  if (packageRoot !== undefined) {
    return packageRoot;
  }

  if (fileIsDir) {
    return file;
  }

  return path.basename(file) === "SKILL.md"
    ? path.dirname(path.dirname(file))
    : path.dirname(file);
};

/** The skills of one resolve, and their outermost roots. */
interface ResolvedSkills {
  readonly skills: ReadonlyArray<PiSkill>;
  readonly roots: ReadonlyArray<string>;
}

const skillsOf = (
  resolved: ReadonlyArray<PiCodingAgent.ResolvedResource>,
  options: PiConfigOptions
): ResolvedSkills => {
  const agentsSkills = path.join(options.home, ".agents", "skills");
  const agentSkills = path.join(options.agentDir, "skills");
  const candidates: Array<PiSkill> = [];

  for (const resource of resolved) {
    const stat = resource.enabled
      ? statSync(resource.path, { throwIfNoEntry: false })
      : undefined;

    if (stat === undefined) {
      continue;
    }

    const isDir = stat.isDirectory();

    const asSkillFile =
      isDir &&
      existsSync(path.join(resource.path, "SKILL.md")) &&
      (resource.metadata.source === "auto" ||
        resource.metadata.origin === "package");

    const file = asSkillFile
      ? path.join(resource.path, "SKILL.md")
      : resource.path;

    const fileIsDir = isDir && !asSkillFile;

    const userDir = [agentsSkills, agentSkills].find((dir) =>
      isUnder(file, dir)
    );

    const root =
      userDir ?? ownRootOf(file, fileIsDir, resource.metadata.packageRoot);

    candidates.push({ path: file, root: path.resolve(root) });
  }

  const distinct = [...new Set(candidates.map((candidate) => candidate.root))];

  const roots = distinct.filter(
    (root) => !distinct.some((other) => other !== root && isUnder(root, other))
  );

  return {
    skills: candidates.map((candidate) => ({
      path: candidate.path,
      root:
        roots.find((root) => isUnder(candidate.path, root)) ?? candidate.root,
    })),
    roots,
  };
};

const contextFilesOf = (agentDir: string): ReadonlyArray<PiContextFile> => {
  const agent = contextFileIn(agentDir).pipe(
    Option.map((file): PiContextFile => ({ source: "agent", path: file }))
  );

  const appendPath = path.join(agentDir, "APPEND_SYSTEM.md");

  const append =
    lstatSync(appendPath, { throwIfNoEntry: false }) === undefined
      ? Option.none<PiContextFile>()
      : Option.some<PiContextFile>({ source: "append", path: appendPath });

  return [agent, append].flatMap((file) => Option.toArray(file));
};

/** Loads pi-coding-agent. Lazy, so a brain that never reads pi's setup never pays for it. */
const loadPi = Effect.tryPromise({
  try: async () => await import("@earendil-works/pi-coding-agent"),
  catch: (cause) =>
    new PiConfigError({
      message: `PiConfig could not load @earendil-works/pi-coding-agent: ${errorText(cause)}. Reinstall the brain's dependencies (pnpm install --frozen-lockfile).`,
      cause,
    }),
});

/** The longest settings parse error a log line or the UI repeats. */
const SETTINGS_ERROR_LIMIT = 200;

/**
 * A settings parse error without the fragment of `settings.json` a JSON parser quotes (V8 writes
 * `Unexpected token ..., "<the text>" is not valid JSON`): everything from the first double quote
 * to the last goes, and the rest is cut to `SETTINGS_ERROR_LIMIT`.
 */
export const settingsErrorText = (message: string) =>
  message.replaceAll(/".*"/gsu, '"..."').slice(0, SETTINGS_ERROR_LIMIT);

/** One resolve of the agent dir through pi's `SettingsManager` and `DefaultPackageManager`. */
const resolvePiConfig = Effect.fn("PiConfig.resolve")(function* (
  pi: typeof PiCodingAgent,
  options: PiConfigOptions
) {
  const { agentDir, cwd } = options;
  const fingerprint = fingerprintOf(options);
  const errors: Array<string> = [];
  const settingsPath = path.join(agentDir, "settings.json");

  const settings = pi.SettingsManager.fromStorage(
    new ReadOnlySettingsStorage(settingsPath),
    { projectTrusted: false }
  );

  const settingsErrors = settings
    .drainErrors()
    .filter((error) => error.scope === "global");

  for (const error of settingsErrors) {
    errors.push(`${settingsPath}: ${settingsErrorText(error.error.message)}`);
  }

  // Never run settings.json's own npm command, even to look a package up.
  Reflect.set(settings, "getNpmCommand", () => ["npm"]);

  const packages = new pi.DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: settings,
  });

  const unfenced = fencePackageManager(packages);

  if (unfenced.length > 0) {
    errors.push(
      `pi's package manager has no ${unfenced.join(", ")}: check PiConfig's fence against this pi version.`
    );
  }

  const missing = new Set<string>();

  const resolved = yield* Effect.tryPromise({
    // Never "install": a missing package is recorded and skipped.
    try: async () =>
      await packages.resolve(async (source) => {
        missing.add(source);

        return await Promise.resolve("skip" as const);
      }),
    catch: (cause) =>
      new PiConfigError({
        message: `Resolving pi's packages failed: ${errorText(cause)}`,
        cause,
      }),
  }).pipe(
    Effect.asSome,
    Effect.catchTag("PiConfigError", (failure) =>
      Effect.sync(() => {
        errors.push(failure.message);

        return Option.none<PiCodingAgent.ResolvedPaths>();
      })
    )
  );

  for (const configured of packages.listConfiguredPackages()) {
    const local =
      configured.source.startsWith(".") || configured.source.startsWith("/");

    if (
      configured.scope === "user" &&
      !local &&
      (configured.installedPath === undefined ||
        !existsSync(configured.installedPath))
    ) {
      missing.add(configured.source);
    }
  }

  const { skills, roots } = skillsOf(
    Option.match(resolved, {
      onNone: () => [],
      onSome: (paths) => paths.skills,
    }),
    options
  );

  const thinking = settings.getDefaultThinkingLevel();

  const snapshot: PiSnapshot = {
    agentDir,
    loaded: settingsErrors.length === 0,
    loadedAt: yield* DateTime.now,
    skills,
    skillRoots: roots,
    missing: [...missing],
    defaults: {
      provider: Option.fromNullishOr(settings.getDefaultProvider()),
      model: Option.fromNullishOr(settings.getDefaultModel()),
      thinkingLevel: isThinkingLevel(thinking)
        ? Option.some(thinking)
        : Option.none(),
    },
    run: runSettingsOf(settings),
    contextFiles: contextFilesOf(agentDir),
    errors,
    fingerprint,
  };

  return snapshot;
});

/** The user's pi setup, read-only and cached against the mtimes of what it reads. */
export class PiConfig extends Context.Service<
  PiConfig,
  {
    /** The agent dir this service reads. */
    readonly agentDir: string;
    /** The last snapshot, at once. */
    current(): PiSnapshot;
    /** Resolves again if a file it read changed since the last resolve; otherwise the cached snapshot. */
    readonly refresh: Effect.Effect<PiSnapshot>;
    /** Resolves again. */
    readonly reload: Effect.Effect<PiSnapshot>;
  }
>()("cairn/server/models/PiConfig") {
  /**
   * Reads pi's setup from the given directories. Fails with `PiConfigError` only when
   * pi-coding-agent cannot be loaded; a resolve that goes wrong is reported in `errors`.
   */
  static readonly layerWith = (options: PiConfigOptions) =>
    Layer.effect(
      PiConfig,
      Effect.gen(function* () {
        const pi = yield* loadPi;

        const resolveNow = resolvePiConfig(pi, options).pipe(
          Effect.tap((snapshot) =>
            Effect.logInfo("pi config read").pipe(
              Effect.annotateLogs({
                event: "pi_config_read",
                agentDir: snapshot.agentDir,
                skills: snapshot.skills.length,
                missing: snapshot.missing.join(" "),
                errors: snapshot.errors.length,
              })
            )
          ),
          Effect.tap((snapshot) =>
            Effect.forEach(
              snapshot.errors,
              (error) =>
                Effect.logWarning("pi config").pipe(
                  Effect.annotateLogs({ event: "pi_config_problem", error })
                ),
              { discard: true }
            )
          )
        );

        let latest = yield* resolveNow;
        const lock = yield* Semaphore.make(1);

        const publish = (snapshot: PiSnapshot) =>
          Effect.sync(() => {
            latest = snapshot;

            return snapshot;
          });

        const reload = lock
          .withPermits(1)(Effect.flatMap(resolveNow, publish))
          .pipe(Effect.withSpan("PiConfig.reload"));

        const refresh = lock
          .withPermits(1)(
            Effect.suspend(() =>
              fingerprintOf(options) === latest.fingerprint
                ? Effect.succeed(latest)
                : Effect.flatMap(resolveNow, publish)
            )
          )
          .pipe(Effect.withSpan("PiConfig.refresh"));

        return PiConfig.of({
          agentDir: options.agentDir,
          current: () => latest,
          refresh,
          reload,
        });
      })
    );

  /**
   * The brain's pi setup: pi's own agent dir (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`), `$HOME`,
   * and `<dataDir>/pi-cwd` as pi's cwd, emptied at every start.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const pi = yield* loadPi;
      const cwd = path.join(config.dataDir, "pi-cwd");

      yield* Effect.sync(() => {
        rmSync(cwd, { recursive: true, force: true });
        mkdirSync(cwd, { recursive: true, mode: 0o700 });
      });

      return PiConfig.layerWith({
        agentDir: path.resolve(pi.getAgentDir()),
        cwd,
        home: process.env.HOME ?? homedir(),
      });
    })
  );
}
