// What the tools-only pi host may load and how each tool replays (ADR 0039). Loading a pi package
// runs its code inside the brain, so the host loads only the packages named here, in the version
// range named here, from the packages pi itself resolved and enabled in settings.json. Everything
// else the user's pi setup holds is left alone, each for a reason:
//
// - `pi-claude-bridge`: Cairn's bridge is native (ADR 0017).
// - `pi-herdr-btw`, `pi-unslop`: terminal UI, nothing a tool host can use.
// - `pi-skill-stacks`: skills, which `SkillCatalog` already resolves.
// - the user's loose extensions (`auto-worktree`, `herdr-agent-state`, ...): not in a package, so
//   never named here.
//
// Replay comes from this table, never from the extension: a tool reruns after a crash only when it
// is named safe here.

import path from "node:path";

import { Data, Option } from "effect";

/**
 * Where an extension instance lives: one per brain, or one per folder for an extension that binds
 * to the folder of its last `session_start` (pi-fff searches that folder, not the call's).
 */
export type InstanceScope = "brain" | "folder";

/** The directories the host owns, all under the brain's data dir. */
export interface PiHostDirs {
  /** The host's root, `<dataDir>/pi-host`. */
  readonly root: string;
  /**
   * An empty directory given to pi's loader as both the cwd and the agent dir, so neither a
   * project's `.pi/extensions` nor `~/.pi/agent/extensions` is ever discovered.
   */
  readonly empty: string;
}

/** The host's directories under `root`. */
export const piHostDirs = (root: string): PiHostDirs => ({
  root,
  empty: path.join(root, "empty"),
});

/** One package the host may load. */
export interface PiPackagePolicy {
  /** The npm name in the package's `package.json`. */
  readonly name: string;
  /** The versions it may load, as `<major>.<minor>.x`. */
  readonly versions: string;
  readonly scope: InstanceScope;
  /** Flag values set on every instance before `session_start`. */
  readonly flags: (dirs: PiHostDirs) => ReadonlyMap<string, boolean | string>;
  /** Environment set before the package loads (process-wide: pi packages read `process.env`). */
  readonly env: (dirs: PiHostDirs) => ReadonlyMap<string, string>;
  /** Tools the package registers that the host never offers. */
  readonly dropped: ReadonlyArray<string>;
}

/** The allowlist, the replay table and the size of the per-folder pool. */
export interface PiHostPolicy {
  readonly packages: ReadonlyArray<PiPackagePolicy>;
  /** Tools that are read-only or idempotent, so a rerun after a crash is harmless. */
  readonly safeTools: ReadonlySet<string>;
  /** How many per-folder instances of one package stay loaded; the least recently used goes first. */
  readonly folderInstances: number;
}

const noFlags = () => new Map<string, boolean | string>();

const noEnv = () => new Map<string, string>();

/** `pi-web-access`: web search and fetch. Its results map is keyed by response id, so one instance. */
const webAccess: PiPackagePolicy = {
  name: "pi-web-access",
  versions: "0.45.x",
  scope: "brain",
  flags: noFlags,
  // Its fetch cache lives under ~/.pi otherwise; `PI_CODING_AGENT_DIR` stays unset, or the cache
  // would land in the agent dir.
  env: (dirs) =>
    new Map([["PI_WEB_ACCESS_CACHE_ROOT", path.join(dirs.root, "web-cache")]]),
  // `web_enable` only calls `setActiveTools`, and the brain's tool set is fixed.
  dropped: ["web_enable"],
};

/** `pi-fff`: indexed `ffgrep` and `fffind`, bound to the folder of its `session_start`. */
const fff: PiPackagePolicy = {
  name: "@ff-labs/pi-fff",
  versions: "0.11.x",
  scope: "folder",
  // Its frecency and history databases default to ~/.pi/agent/fff, which the host never writes.
  flags: (dirs) =>
    new Map<string, boolean | string>([
      ["fff-mode", "tools-only"],
      ["fff-frecency-db", path.join(dirs.root, "fff", "frecency")],
      ["fff-history-db", path.join(dirs.root, "fff", "history")],
      ["fff-enable-home-scan", false],
      ["fff-enable-root-scan", false],
    ]),
  env: noEnv,
  dropped: [],
};

/** The brain's policy (ADR 0039). */
export const PI_HOST_POLICY: PiHostPolicy = {
  packages: [webAccess, fff],
  safeTools: new Set([
    "web_search",
    "source_check",
    // May clone a GitHub repo into its cache: idempotent.
    "fetch_content",
    "get_search_content",
    "ffgrep",
    "fffind",
  ]),
  folderInstances: 4,
};

const RANGE = /^(?<major>\d+)\.(?<minor>\d+)\.x$/u;

const VERSION = /^(?<major>\d+)\.(?<minor>\d+)\.\d+(?:[-+].*)?$/u;

/** Whether `version` is inside `range` (`<major>.<minor>.x`); a range of any other form admits nothing. */
export const versionInRange = (version: string, range: string): boolean => {
  const wanted = RANGE.exec(range)?.groups;
  const found = VERSION.exec(version)?.groups;

  return (
    wanted !== undefined &&
    found !== undefined &&
    wanted.major === found.major &&
    wanted.minor === found.minor
  );
};

/** What the policy says about one package pi resolved. */
export type PackageDecision = Data.TaggedEnum<{
  /** Load it under `policy`. */
  Allowed: { readonly policy: PiPackagePolicy };
  /** Not on the allowlist: never loaded, never logged. */
  NotAllowed: { readonly name: string };
  /** On the allowlist at another version: loads nothing, and the brain logs it. */
  OutOfRange: { readonly policy: PiPackagePolicy; readonly version: string };
}>;

/** Constructors and matchers for `PackageDecision`. */
export const PackageDecision = Data.taggedEnum<PackageDecision>();

/** What `policy` says about the package `name` at `version` (none when its manifest was unreadable). */
export const decidePackage = (
  policy: PiHostPolicy,
  name: string,
  version: Option.Option<string>
): PackageDecision => {
  const named = policy.packages.find((entry) => entry.name === name);

  if (named === undefined) {
    return PackageDecision.NotAllowed({ name });
  }

  const found = Option.getOrElse(version, () => "unknown");

  return versionInRange(found, named.versions)
    ? PackageDecision.Allowed({ policy: named })
    : PackageDecision.OutOfRange({ policy: named, version: found });
};

/** How a tool replays after a crash: `safe` only when the policy names it. */
export const replayOf = (
  policy: PiHostPolicy,
  toolName: string
): "safe" | "unsafe" => (policy.safeTools.has(toolName) ? "safe" : "unsafe");
