// Ported from cairn-v1, apps/server/src/Skills.ts at 1a5cd4a (project roots ahead of the user's,
// first name wins, dedupe by real path, sorted by name, hidden skills kept for completion, skills
// whose text the Claude bridge refuses left out of the prompt), and from pi, earendil-works
// pi@4a080252, packages/coding-agent/src/core/package-manager.ts (`findGitRepoRoot` and
// `collectAncestorAgentsSkillDirs`: a project's `.agents/skills` from the cwd up to its git root).
// Changed: the user's skills come from `PiConfig`'s read-only resolve; Cairn's own exclude globs
// and sandbox views are gone; a view is cached per cwd and rebuilt only when a file it read
// changed; project `.pi/` is never read.
//
// MIT License. Copyright (c) 2025 Mario Zechner (pi).
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// The skills a thread can use, as one view per cwd:
//
// - project skills first: `<dir>/.agents/skills` for every directory from the cwd up to its git
//   root (or the filesystem root outside a repo), nearest first, never the user's own
//   `~/.agents/skills`; each skill directory under a root is read, loose files directly in a root
//   are not (pi's "agents" layout);
// - then the user's skills as pi resolves them (`PiConfig`: settings.json filters, packages);
// - the first skill of a name wins, a file reached twice through links counts once, and the list
//   is sorted by name in code unit order, so an unchanged tree always renders the same text;
// - a `disable-model-invocation` skill stays in the list (the composer completes it) but not in
//   the prompt, and so does one whose name, description or path the Claude bridge would refuse.
//
// Views are synchronous (pi's loader reads with `node:fs`), so a prompt section can render one
// without a runtime. A view is cached per cwd; `refresh` stats the files and directories it read
// and rebuilds only when one changed, so the warm path costs a few hundred `stat` calls.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import type * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { errorText } from "../brain/Durable.ts";
import { homeDirectory } from "../Config.ts";
import { PiConfig } from "../models/PiConfig.ts";
import type { PiSnapshot } from "../models/PiConfig.ts";
import { isRefused } from "./PromptSafety.ts";

/** pi-coding-agent could not be loaded. Boot stops; reinstall the brain's dependencies. */
export class SkillCatalogError extends Schema.TaggedError<SkillCatalogError>()(
  "SkillCatalogError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  }
) {}

/** Why a listed skill is not in the model's prompt. */
export type SkillHidden = "user_invoked" | "unsendable";

/** One skill as a thread sees it. */
export interface CatalogSkill {
  readonly name: string;
  readonly description: string;
  /** The skill's file (`SKILL.md`, or a loose markdown file). */
  readonly filePath: string;
  /** The directory the skill's relative paths resolve against. */
  readonly baseDir: string;
  readonly source: "project" | "user";
  /** Set when the skill is listed for completion but kept out of the prompt. */
  readonly hidden: Option.Option<SkillHidden>;
}

/** The skills of one cwd. */
export interface SkillView {
  readonly cwd: Option.Option<string>;
  /** Every skill, hidden ones included, sorted by name. */
  readonly skills: ReadonlyArray<CatalogSkill>;
  /** pi's skills prompt over the visible skills, trimmed; empty when none is visible. */
  readonly prompt: string;
  /** Collisions, unreadable skill files and refused skills, as sentences. */
  readonly problems: ReadonlyArray<string>;
}

/** pi-coding-agent's skill functions, loaded lazily. */
type PiSkills = Pick<
  typeof PiCodingAgent,
  "loadSkills" | "formatSkillsForPrompt"
>;

type PiSkill = PiCodingAgent.Skill;

/** What the catalog reads the user's skills from. */
interface UserSkillSource {
  /** The latest resolve, or none when the user's pi setup is not read. */
  current(): Option.Option<PiSnapshot>;
  readonly refresh: Effect.Effect<void>;
  readonly reload: Effect.Effect<void>;
}

/** Options of a catalog. */
interface CatalogOptions {
  readonly pi: PiSkills;
  readonly user: UserSkillSource;
  /** `$HOME`: its `.agents/skills` is the user's root, never a project's. */
  readonly home: string;
}

/** Cached views kept at once; the oldest goes first. */
const MAX_VIEWS = 256;

const realpathOf = (file: string): string => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

const stamp = (file: string): string => {
  const stat = statSync(file, { throwIfNoEntry: false });

  return stat === undefined
    ? "-"
    : `${String(stat.mtimeMs)}:${String(stat.size)}`;
};

/** The nearest directory at or above `start` that holds `.git`, as pi's package manager finds it. */
const gitRootOf = (start: string): Option.Option<string> => {
  let dir = path.resolve(start);

  for (;;) {
    if (existsSync(path.join(dir, ".git"))) {
      return Option.some(dir);
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      return Option.none();
    }

    dir = parent;
  }
};

/**
 * The `.agents/skills` directories a thread in `cwd` reads, nearest first: from `cwd` up to its git
 * root, or to the filesystem root outside a repo, without the user's own `<home>/.agents/skills`.
 * Directories that do not exist are included; callers check.
 */
export const projectSkillRoots = (
  cwd: string,
  home: string
): ReadonlyArray<string> => {
  const start = path.resolve(cwd);
  const stop = gitRootOf(start);
  const userRoot = path.resolve(home, ".agents", "skills");
  const roots: Array<string> = [];
  let dir = start;

  for (;;) {
    const root = path.join(dir, ".agents", "skills");

    if (root !== userRoot) {
      roots.push(root);
    }

    const parent = path.dirname(dir);

    if (Option.contains(stop, dir) || parent === dir) {
      return roots;
    }

    dir = parent;
  }
};

/** The skill directories directly under a project root (pi reads no loose files there). */
const skillDirsUnder = (root: string): ReadonlyArray<string> => {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules" &&
        (entry.isDirectory() ||
          (entry.isSymbolicLink() &&
            statSync(path.join(root, entry.name), {
              throwIfNoEntry: false,
            })?.isDirectory() === true))
    )
    .map((entry) => path.join(root, entry.name))
    .toSorted();
};

/** What a project view read: its roots and their skill directories. */
const projectInputs = (cwd: Option.Option<string>, home: string) => {
  const roots = Option.match(cwd, {
    onNone: () => [],
    onSome: (dir) => projectSkillRoots(dir, home),
  });

  return { roots, dirs: roots.flatMap(skillDirsUnder) };
};

/** One loaded skill and where it came from. */
interface Loaded {
  readonly skill: PiSkill;
  readonly source: "project" | "user";
}

const byName = (a: Loaded, b: Loaded) => {
  if (a.skill.name < b.skill.name) {
    return -1;
  }

  return a.skill.name > b.skill.name ? 1 : 0;
};

const diagnosticText = (
  diagnostic: PiCodingAgent.LoadSkillsResult["diagnostics"][number]
) =>
  `skill ${diagnostic.type}: ${diagnostic.message}${diagnostic.path === undefined ? "" : ` (${diagnostic.path})`}`;

/** A cached view and the stamp of everything it read. */
interface Cached {
  readonly view: SkillView;
  readonly fingerprint: string;
}

/** The user part of every view, loaded once per resolve and file stamp. */
interface UserPart {
  readonly snapshot: Option.Option<PiSnapshot>;
  readonly fingerprint: string;
  readonly loaded: ReadonlyArray<Loaded>;
  readonly problems: ReadonlyArray<string>;
}

/** The stamp of the user part: pi's resolve and every user skill file. */
const userFingerprint = (snapshot: Option.Option<PiSnapshot>) =>
  Option.match(snapshot, {
    onNone: () => "none",
    onSome: (resolved) =>
      [
        resolved.fingerprint,
        ...resolved.skills.map((skill) => `${skill.path}=${stamp(skill.path)}`),
      ].join("\n"),
  });

/** The cache key of a cwd. */
const keyOf = (cwd: Option.Option<string>) =>
  Option.match(cwd, { onNone: () => "", onSome: (dir) => path.resolve(dir) });

/** Why `skill` stays out of the prompt, if it does. */
const hiddenOf = (
  skill: PiSkill,
  refused: boolean
): Option.Option<SkillHidden> => {
  if (skill.disableModelInvocation) {
    return Option.some("user_invoked");
  }

  return refused ? Option.some("unsendable") : Option.none();
};

/** The catalog's state and its synchronous view building. Module-private. */
const makeCatalog = (options: CatalogOptions) => {
  const { pi, user, home } = options;
  const views = new Map<string, Cached>();
  let userPart: UserPart | undefined;

  const loadUser = (): UserPart => {
    const snapshot = user.current();
    const fingerprint = userFingerprint(snapshot);

    if (userPart?.fingerprint === fingerprint) {
      return userPart;
    }

    const loaded = Option.match(snapshot, {
      onNone: () => ({ skills: [], diagnostics: [] }),
      onSome: (resolved) =>
        pi.loadSkills({
          cwd: resolved.agentDir,
          agentDir: resolved.agentDir,
          skillPaths: resolved.skills.map((skill) => skill.path),
          includeDefaults: false,
        }),
    });

    userPart = {
      snapshot,
      fingerprint,
      loaded: loaded.skills.map((skill) => ({ skill, source: "user" })),
      problems: loaded.diagnostics.map(diagnosticText),
    };

    return userPart;
  };

  const projectFingerprint = (cwd: Option.Option<string>) => {
    const { roots, dirs } = projectInputs(cwd, home);

    return [
      ...roots.map((root) => `${root}=${stamp(root)}`),
      ...dirs.flatMap((dir) => [
        `${dir}=${stamp(dir)}`,
        `${dir}/SKILL.md=${stamp(path.join(dir, "SKILL.md"))}`,
      ]),
    ].join("\n");
  };

  const build = (cwd: Option.Option<string>): SkillView => {
    const users = loadUser();
    const { dirs } = projectInputs(cwd, home);

    const project =
      dirs.length === 0
        ? { skills: [], diagnostics: [] }
        : pi.loadSkills({
            cwd: Option.getOrElse(cwd, () => home),
            agentDir: Option.getOrElse(cwd, () => home),
            skillPaths: [...dirs],
            includeDefaults: false,
          });

    const problems = [
      ...project.diagnostics.map(diagnosticText),
      ...users.problems,
    ];

    const winners = new Map<string, Loaded>();
    const seen = new Set<string>();

    const candidates: ReadonlyArray<Loaded> = [
      ...project.skills.map((skill): Loaded => ({ skill, source: "project" })),
      ...users.loaded,
    ];

    for (const candidate of candidates) {
      const real = realpathOf(candidate.skill.filePath);

      if (seen.has(real)) {
        continue;
      }

      const winner = winners.get(candidate.skill.name);

      if (winner !== undefined) {
        if (winner.source !== candidate.source) {
          problems.push(
            `skill ${candidate.skill.name}: the ${winner.source} skill ${winner.skill.filePath} is used, not ${candidate.skill.filePath}`
          );
        }

        continue;
      }

      seen.add(real);
      winners.set(candidate.skill.name, candidate);
    }

    const sorted = [...winners.values()].toSorted(byName);

    const listed = sorted.map(({ skill, source }) => {
      const refused = isRefused(skill.name, skill.description, skill.filePath);

      if (refused) {
        problems.push(
          `skill ${skill.name} is left out of the prompt: its name, description or path carries text the Claude bridge refuses`
        );
      }

      const hidden = hiddenOf(skill, refused);

      const entry: CatalogSkill = {
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
        source,
        hidden,
      };

      return { skill, entry };
    });

    const visible = listed.flatMap(({ skill, entry }) =>
      Option.isNone(entry.hidden) ? [skill] : []
    );

    return {
      cwd,
      skills: listed.map(({ entry }) => entry),
      prompt: pi.formatSkillsForPrompt(visible, "read").trim(),
      problems,
    };
  };

  const fingerprintOf = (cwd: Option.Option<string>) =>
    `${userFingerprint(user.current())}\n--\n${projectFingerprint(cwd)}`;

  const store = (key: string, cached: Cached) => {
    views.delete(key);
    views.set(key, cached);

    if (views.size > MAX_VIEWS) {
      const [oldest] = views.keys();

      if (oldest !== undefined) {
        views.delete(oldest);
      }
    }

    return cached.view;
  };

  const rebuild = (cwd: Option.Option<string>) => {
    const fingerprint = fingerprintOf(cwd);

    return store(keyOf(cwd), { view: build(cwd), fingerprint });
  };

  const view = (cwd: Option.Option<string>): SkillView =>
    views.get(keyOf(cwd))?.view ?? rebuild(cwd);

  const refresh = (cwd: Option.Option<string>): SkillView => {
    const cached = views.get(keyOf(cwd));

    if (cached !== undefined && cached.fingerprint === fingerprintOf(cwd)) {
      return cached.view;
    }

    return rebuild(cwd);
  };

  const forget = () => {
    views.clear();
    userPart = undefined;
  };

  return { view, refresh, forget };
};

/** Logs each distinct problem once per process. */
const makeProblemLog = () => {
  const logged = new Set<string>();

  return (view: SkillView) =>
    Effect.forEach(
      view.problems.filter((problem) => !logged.has(problem)),
      (problem) =>
        Effect.sync(() => logged.add(problem)).pipe(
          Effect.andThen(
            Effect.logWarning("skill catalog").pipe(
              Effect.annotateLogs({ event: "skill_problem", problem })
            )
          )
        ),
      { discard: true }
    );
};

/** Loads pi-coding-agent's skill functions. Lazy, like `PiConfig`. */
const loadPiSkills = Effect.tryPromise({
  try: async (): Promise<PiSkills> => {
    const pi = await import("@earendil-works/pi-coding-agent");

    return {
      loadSkills: pi.loadSkills,
      formatSkillsForPrompt: pi.formatSkillsForPrompt,
    };
  },
  catch: (cause) =>
    new SkillCatalogError({
      message: `SkillCatalog could not load @earendil-works/pi-coding-agent: ${errorText(cause)}. Reinstall the brain's dependencies (pnpm install --frozen-lockfile).`,
      cause,
    }),
});

/** What a catalog offers. */
export interface SkillViews {
  /** The skills a thread in `cwd` sees, from the cache; built on first use. */
  view(cwd: Option.Option<string>): SkillView;
  /** The view for `cwd`, rebuilt first when a skill file or root it read has changed. */
  refresh(cwd: Option.Option<string>): SkillView;
  /**
   * The turn-start refresh: resolves pi's setup again if a file it read changed, then refreshes
   * `cwd`'s view, and logs problems not logged before.
   */
  refreshForTurn(cwd: Option.Option<string>): Effect.Effect<SkillView>;
  /** Resolves pi's setup again, drops every cached view and returns `cwd`'s view rebuilt. */
  reload(cwd: Option.Option<string>): Effect.Effect<SkillView>;
}

/** The view of a catalog with no skills at all. */
const emptyView = (cwd: Option.Option<string>): SkillView => ({
  cwd,
  skills: [],
  prompt: "",
  problems: [],
});

/**
 * The skills of every thread, per cwd: the project's, then the user's from pi. A reference whose
 * default has no skills, so a brain or a test that composes none runs with an empty `skills`
 * section and expands nothing; the deployed brain provides `layer` (through `Skills.live`).
 */
export class SkillCatalog extends Context.Reference<SkillViews>(
  "cairn/server/skills/SkillCatalog",
  {
    defaultValue: () => ({
      view: emptyView,
      refresh: emptyView,
      refreshForTurn: (cwd) => Effect.succeed(emptyView(cwd)),
      reload: (cwd) => Effect.succeed(emptyView(cwd)),
    }),
  }
) {
  private static readonly make = (user: UserSkillSource, home: string) =>
    Effect.gen(function* () {
      const pi = yield* loadPiSkills;
      const catalog = makeCatalog({ pi, user, home });
      const logProblems = makeProblemLog();

      const refreshForTurn = Effect.fn("SkillCatalog.refreshForTurn")(
        function* (cwd: Option.Option<string>) {
          yield* user.refresh;
          const view = catalog.refresh(cwd);
          yield* logProblems(view);

          return view;
        }
      );

      const reload = Effect.fn("SkillCatalog.reload")(function* (
        cwd: Option.Option<string>
      ) {
        yield* user.reload;
        catalog.forget();
        const view = catalog.view(cwd);
        yield* logProblems(view);

        return view;
      });

      return SkillCatalog.of({
        view: catalog.view,
        refresh: catalog.refresh,
        refreshForTurn,
        reload,
      });
    });

  /** Over the ambient `PiConfig`: the user's skills as pi resolves them. */
  static readonly layerNoDeps = Layer.effect(
    SkillCatalog,
    Effect.gen(function* () {
      const pi = yield* PiConfig;

      return yield* SkillCatalog.make(
        {
          current: () => Option.some(pi.current()),
          refresh: Effect.asVoid(pi.refresh),
          reload: Effect.asVoid(pi.reload),
        },
        yield* homeDirectory
      );
    })
  );

  /** The brain's catalog over the brain's `PiConfig` (shared with the model runtime's). */
  static readonly layer = SkillCatalog.layerNoDeps.pipe(
    Layer.provide(PiConfig.layer)
  );

  /**
   * Project skills only, with no user skills and no pi setup read: the scripted dev brain and
   * tests that must not read the owner's `~/.pi/agent`.
   */
  static readonly layerProjectOnly = (home: string) =>
    Layer.effect(
      SkillCatalog,
      SkillCatalog.make(
        {
          current: () => Option.none(),
          refresh: Effect.void,
          reload: Effect.void,
        },
        home
      )
    );
}
