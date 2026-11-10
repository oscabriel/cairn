// What t3code changed under Cairn's ports since each was ported: a triage list to read at each phase
// boundary (AGENTS.md, "Code").
//
//   node tools/t3code-upstream.ts [--all] [--clone <dir>] [--ref <ref>]
//
// Every Cairn file whose leading comment cites a t3code path and the commit it was ported at is a
// port. For each cited path the script lists the upstream commits to that path since the cited
// commit, and prints one row per upstream commit, fixes on pure-logic paths first (`*.logic.ts`,
// `shared/`, `client-runtime/`), then other fixes. `--all` adds the commits that are not fixes.
//
// It reads the user's clone of t3code (`~/Developer/clones/github.com/pingdotgg/t3code`, read-only)
// with plain `git log`, `git ls-tree` and `git merge-base`, and never fetches or writes there:
// `GIT_NO_LAZY_FETCH` stops the partial clone from fetching a missing object, and nothing here
// asks for a blob. The clone is only as new as its last fetch, so the report opens with how old
// its ref is and says when a cited commit is newer than the clone, in which case nothing since that
// commit can be listed until the user fetches.
//
// A header names its sources in prose, so the parse is a heuristic: a citation runs from a source
// marker (`github.com/<owner>/<repo>`, `cairn-v1`, or `t3code at <commit>`) to the next marker or to
// "Kept:" or "Changed:". Inside a t3code citation, every repository path is a cited path, a bare
// file name is read beside the path before it, and a path's commit is the first commit after it,
// else the last before it. A cited path that the clone does not hold at its commit is listed for a
// person to check, never dropped.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { DateTime } from "effect";

/** One upstream path a Cairn file says it was ported from, at a commit. */
export interface Citation {
  readonly path: string;
  readonly commit: string;
}

/** A Cairn file and what its header cites from t3code. */
export interface Port {
  readonly file: string;
  readonly citations: ReadonlyArray<Citation>;
}

const DEFAULT_CLONE = path.join(
  homedir(),
  "Developer",
  "clones",
  "github.com",
  "pingdotgg",
  "t3code"
);

const DEFAULT_REF = "origin/main";

/** The folders searched for ports, from the repository root. */
const SEARCHED = ["apps", "packages", "judges", "ops", "tools"];

const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  ".git",
  "fixtures",
]);

const SOURCE_FILE = /\.(?:tsx?|css)$/u;

const COMMENT_START = /^(?:\/\/|\/\*|\*)/u;

const COMMENT_MARKER = /^(?:\/\/+|\/\*+|\*\/|\*)\s?/u;

/** The leading comment block of a file, markers stripped, as one line of prose. */
export const headerOf = (text: string): string => {
  const lines: Array<string> = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#!")) {
      continue;
    }

    if (!COMMENT_START.test(trimmed)) {
      break;
    }

    lines.push(trimmed.replace(COMMENT_MARKER, "").replace(/\*\/$/u, ""));
  }

  return lines.join(" ");
};

/** Where one source's citation starts, and the end of the prose that names it. */
const MARKER =
  /github\.com\/[\w.-]+\/[\w.-]+|\bpingdotgg\/t3code\b|\bcairn-v1\b|\bt3code(?= at [0-9a-f]{7})|\b(?:Kept|Changed):/gu;

const EXTENSION = String.raw`\.(?:tsx?|jsx?|mts|css|json|md|ya?ml|html)`;

/** A repository path, or a folder with one brace group of names: `a/{b,c}.ts`, `a/{b.ts,c.ts}`. */
const FULL_PATH = new RegExp(
  String.raw`(?<![\w/.-])(?:apps|packages|scripts|\.github)\/(?:[\w@./-]*\{[^{}\s]*\}(?:[\w@.-]*${EXTENSION})?|[\w@./-]*?\w${EXTENSION})(?![\w])`,
  "gu"
);

const ENDS_IN_EXTENSION = new RegExp(`${EXTENSION}$`, "u");

const BARE_NAME = /(?<![\w/.`-])[A-Za-z][\w.-]*\.(?:tsx?|css)(?![\w`])/gu;

const COMMIT = /\b[0-9a-f]{7,40}\b/gu;

/** Expands one brace group: `a/{b,c}.ts` is `a/b.ts` and `a/c.ts`. */
const expandBraces = (cited: string): ReadonlyArray<string> => {
  const group = /\{(?<options>[^{}]*)\}/u.exec(cited);
  const options = group?.groups?.options;

  if (group === null || options === undefined) {
    return [cited];
  }

  const before = cited.slice(0, group.index);
  const after = cited.slice(group.index + group[0].length);

  return (
    options
      .split(",")
      // An option may carry prose after its name: `{a.ts (X, Y), b.ts}`.
      .map(
        (option) => `${before}${/^[\w@./-]*/u.exec(option)?.[0] ?? ""}${after}`
      )
      .filter((expanded) => ENDS_IN_EXTENSION.test(expanded))
  );
};

/**
 * Undoes what wrapping a header did to its paths: a line break after a slash
 * (`components/ Sidebar.logic.ts`) and spaces inside a brace group (`{a.ts, b.ts}`).
 */
const unwrap = (segment: string) =>
  segment
    .replaceAll(/\/ (?=[\w.-]+\.\w)/gu, "/")
    .replaceAll(
      /\/\{(?<names>[^{}]*)\}/gu,
      (_match, names: string) => `/{${names.replaceAll(/\s+/gu, "")}}`
    );

interface Found {
  readonly at: number;
  readonly text: string;
}

const allOf = (pattern: RegExp, text: string): ReadonlyArray<Found> =>
  Array.from(text.matchAll(pattern), (match) => ({
    at: match.index,
    text: match[0],
  }));

/** A commit names a hex string with at least one digit and one letter, so a word or year is not one. */
const isCommit = (text: string) => /\d/u.test(text) && /[a-f]/u.test(text);

/** The t3code citations in one stretch of header prose that belongs to t3code. */
const citationsInSegment = (wrapped: string): ReadonlyArray<Citation> => {
  const segment = unwrap(wrapped);

  const commits = allOf(COMMIT, segment).filter((found) =>
    isCommit(found.text)
  );

  const full = allOf(FULL_PATH, segment);

  const bare = allOf(BARE_NAME, segment).flatMap((found) => {
    const before = full.findLast((cited) => cited.at < found.at);

    // A name inside a brace group is part of that path, not a name of its own.
    return before === undefined || found.at < before.at + before.text.length
      ? []
      : [
          {
            at: found.at,
            text: path.posix.join(path.posix.dirname(before.text), found.text),
          },
        ];
  });

  return [...full, ...bare].flatMap((cited) => {
    const commit =
      commits.find((found) => found.at > cited.at) ??
      commits.findLast((found) => found.at < cited.at);

    return commit === undefined
      ? []
      : expandBraces(cited.text).map((expanded) => ({
          path: expanded,
          commit: commit.text,
        }));
  });
};

/** Every t3code path a header cites, with the commit it names for each, once each. */
export const citationsIn = (header: string): ReadonlyArray<Citation> => {
  const markers = allOf(MARKER, header);
  const seen = new Set<string>();
  const citations: Array<Citation> = [];

  for (const [index, marker] of markers.entries()) {
    if (!marker.text.includes("t3code")) {
      continue;
    }

    const end = markers[index + 1]?.at ?? header.length;

    for (const citation of citationsInSegment(header.slice(marker.at, end))) {
      const key = `${citation.path}@${citation.commit}`;

      if (!seen.has(key)) {
        seen.add(key);
        citations.push(citation);
      }
    }
  }

  return citations;
};

const walk = (folder: string): ReadonlyArray<string> =>
  readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);

    if (entry.isDirectory()) {
      return SKIPPED_FOLDERS.has(entry.name) ? [] : walk(full);
    }

    return entry.isFile() && SOURCE_FILE.test(entry.name) ? [full] : [];
  });

/** Every file under the searched folders whose header cites t3code, with its citations. */
export const findPorts = (root: string): ReadonlyArray<Port> =>
  SEARCHED.flatMap((folder) => {
    const full = path.join(root, folder);

    return existsSync(full) ? walk(full) : [];
  }).flatMap((file) => {
    const citations = citationsIn(headerOf(readFileSync(file, "utf-8")));

    return citations.length === 0
      ? []
      : [{ file: path.relative(root, file), citations }];
  });

/** A read-only view of the clone. Every call refuses to fetch a missing object. */
export interface Clone {
  readonly dir: string;
  /** Git's stdout, or null when git failed. */
  readonly git: (args: ReadonlyArray<string>) => string | null;
}

export const openClone = (dir: string): Clone => ({
  dir,
  git: (args) => {
    const done = spawnSync(
      "git",
      ["-C", dir, "-c", "log.follow=false", ...args],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_NO_LAZY_FETCH: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        maxBuffer: 64 * 1024 * 1024,
      }
    );

    return done.status === 0 ? done.stdout : null;
  },
});

interface CommitInfo {
  readonly sha: string;
  readonly date: string;
  readonly epochSeconds: number;
}

const FIELD = "\u001F";

const commitInfo = (clone: Clone, rev: string): CommitInfo | null => {
  const out = clone.git([
    "log",
    "-1",
    `--format=%H${FIELD}%cs${FIELD}%ct`,
    `${rev}^{commit}`,
    "--",
  ]);

  const [sha = "", date = "", seconds = ""] = (out ?? "").trim().split(FIELD);

  return sha === "" ? null : { sha, date, epochSeconds: Number(seconds) };
};

/** One upstream commit that touched a cited path, with what it touched and who cites it. */
export interface UpstreamCommit {
  readonly sha: string;
  readonly date: string;
  readonly subject: string;
  readonly paths: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
  readonly tier: Tier;
}

export type Tier = "fix, logic" | "fix" | "logic" | "other";

const TIERS: ReadonlyArray<Tier> = ["fix, logic", "fix", "logic", "other"];

const LOGIC_PATH =
  /(?:\.logic\.tsx?$|(?:^|\/)shared\/|(?:^|\/)client-runtime\/)/u;

const FIX_SUBJECT = /^fix(?:\([^)]*\))?!?:/iu;

export const tierOf = (subject: string, paths: ReadonlyArray<string>): Tier => {
  const fix = FIX_SUBJECT.test(subject);
  const logic = paths.some((cited) => LOGIC_PATH.test(cited));

  if (fix) {
    return logic ? "fix, logic" : "fix";
  }

  return logic ? "logic" : "other";
};

/** What became of one cited commit in this clone. */
export interface CitedCommit {
  readonly commit: string;
  readonly paths: number;
  readonly state: "listed" | "missing" | "ahead";
}

export interface Report {
  readonly clone: string;
  readonly ref: string;
  readonly refInfo: CommitInfo | null;
  readonly lastFetched: number | null;
  readonly ports: number;
  readonly cited: ReadonlyArray<CitedCommit>;
  /** Cited paths the clone does not hold at their cited commit: a header to check by hand. */
  readonly unresolved: ReadonlyArray<{ readonly file: string } & Citation>;
  /** Cited paths that no longer exist at the ref: moved or deleted upstream. */
  readonly gone: ReadonlyArray<Citation>;
  readonly commits: ReadonlyArray<UpstreamCommit>;
}

const lastFetchedOf = (dir: string): number | null => {
  const fetchHead = path.join(dir, ".git", "FETCH_HEAD");

  return existsSync(fetchHead) ? statSync(fetchHead).mtimeMs : null;
};

/** The Cairn files citing each (commit, path), keyed by both. */
const citingFiles = (
  ports: ReadonlyArray<Port>
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const byCitation = new Map<string, Array<string>>();

  for (const port of ports) {
    for (const citation of port.citations) {
      const key = `${citation.commit}${FIELD}${citation.path}`;
      const files = byCitation.get(key) ?? [];

      files.push(port.file);
      byCitation.set(key, files);
    }
  }

  return byCitation;
};

const stateOf = (
  clone: Clone,
  info: CommitInfo | null,
  refInfo: CommitInfo | null
): CitedCommit["state"] => {
  if (info === null) {
    return "missing";
  }

  if (refInfo === null) {
    return "ahead";
  }

  const ancestor = clone.git([
    "merge-base",
    "--is-ancestor",
    info.sha,
    refInfo.sha,
  ]);

  return ancestor === null ? "ahead" : "listed";
};

/** Whether the clone holds `citedPath` at `rev`. Reads trees only, never a blob. */
const holds = (clone: Clone, rev: string, citedPath: string) =>
  (clone.git(["ls-tree", "--name-only", rev, "--", citedPath]) ?? "").trim() !==
  "";

interface Logged {
  readonly sha: string;
  readonly date: string;
  readonly subject: string;
}

/** The commits after `from` up to `to` that touched `citedPath`, newest first. */
const logSince = (
  clone: Clone,
  from: string,
  to: string,
  citedPath: string
): ReadonlyArray<Logged> => {
  const log = clone.git([
    "log",
    `--format=%H${FIELD}%cs${FIELD}%s`,
    `${from}..${to}`,
    "--",
    citedPath,
  ]);

  return (log ?? "").split("\n").flatMap((line) => {
    const [sha = "", date = "", subject = ""] = line.split(FIELD);

    return sha === "" ? [] : [{ sha, date, subject }];
  });
};

interface Row extends Logged {
  readonly paths: Set<string>;
  readonly files: Set<string>;
}

const STATE_TEXT: Record<CitedCommit["state"], (ref: string) => string> = {
  listed: () => "upstream commits since it are listed below",
  missing: () =>
    "not in the clone (newer than its last fetch, or not a t3code commit): fetch it to compare these paths",
  ahead: (ref) =>
    `newer than ${ref}, so the clone holds nothing since it: fetch it to compare these paths`,
};

/** Reads the clone for every port's citations. Nothing is written anywhere. */
export const survey = (
  ports: ReadonlyArray<Port>,
  clone: Clone,
  ref: string
): Report => {
  const refInfo = commitInfo(clone, ref);
  const resolved = new Map<string, CommitInfo | null>();
  const unresolved: Array<{ readonly file: string } & Citation> = [];
  const gone: Array<Citation> = [];
  const found = new Map<string, Row>();
  const cited = new Map<string, CitedCommit>();

  for (const [key, files] of citingFiles(ports)) {
    const [commit = "", citedPath = ""] = key.split(FIELD);

    const info = resolved.has(commit)
      ? (resolved.get(commit) ?? null)
      : commitInfo(clone, commit);

    const state = stateOf(clone, info, refInfo);

    resolved.set(commit, info);
    cited.set(commit, {
      commit,
      paths: (cited.get(commit)?.paths ?? 0) + 1,
      state,
    });

    if (info !== null && !holds(clone, info.sha, citedPath)) {
      unresolved.push(
        ...files.map((file) => ({ file, path: citedPath, commit }))
      );
    } else if (info !== null && refInfo !== null && state === "listed") {
      if (!holds(clone, refInfo.sha, citedPath)) {
        gone.push({ path: citedPath, commit });
      }

      for (const logged of logSince(clone, info.sha, refInfo.sha, citedPath)) {
        const row = found.get(logged.sha) ?? {
          ...logged,
          paths: new Set<string>(),
          files: new Set<string>(),
        };

        row.paths.add(citedPath);

        for (const file of files) {
          row.files.add(file);
        }

        found.set(logged.sha, row);
      }
    }
  }

  const commits = Array.from(found.values(), (row) => {
    const paths = [...row.paths].toSorted();

    return {
      sha: row.sha,
      date: row.date,
      subject: row.subject,
      paths,
      files: [...row.files].toSorted(),
      tier: tierOf(row.subject, paths),
    };
  }).toSorted(
    (a, b) =>
      TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) ||
      b.date.localeCompare(a.date) ||
      a.sha.localeCompare(b.sha)
  );

  return {
    clone: clone.dir,
    ref,
    refInfo,
    lastFetched: lastFetchedOf(clone.dir),
    ports: ports.length,
    cited: [...cited.values()],
    unresolved,
    gone,
    commits,
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

const daysBetween = (from: number, to: number) =>
  Math.max(0, Math.floor((to - from) / DAY_MS));

const cell = (text: string) => text.replaceAll("|", "\\|");

/** The report as text. `nowMs` dates the clone's staleness; `all` adds the commits that are not fixes. */
export const render = (report: Report, nowMs: number, all: boolean): string => {
  const lines: Array<string> = ["# t3code upstream since Cairn's ports", ""];

  if (report.refInfo === null) {
    lines.push(
      `The clone at ${report.clone} has no ${report.ref}: nothing to compare.`
    );

    return `${lines.join("\n")}\n`;
  }

  const age = daysBetween(report.refInfo.epochSeconds * 1000, nowMs);

  lines.push(
    `Clone: ${report.clone}, ${report.ref} at ${report.refInfo.sha.slice(0, 10)} (${report.refInfo.date}, ${String(age)} days before today).`
  );

  if (report.lastFetched !== null) {
    lines.push(
      `Last fetched ${String(daysBetween(report.lastFetched, nowMs))} days ago. This script never fetches; fetch the clone yourself for a newer view.`
    );
  }

  lines.push(
    "",
    `${String(report.ports)} Cairn files cite t3code. Cited commits:`,
    ""
  );

  for (const entry of report.cited.toSorted((a, b) => b.paths - a.paths)) {
    const what = STATE_TEXT[entry.state](report.ref);

    lines.push(
      `- ${entry.commit.slice(0, 10)}: ${String(entry.paths)} cited paths; ${what}.`
    );
  }

  if (report.gone.length > 0) {
    lines.push(
      "",
      "Cited paths moved or deleted upstream since their commit:",
      ""
    );

    for (const citation of report.gone) {
      lines.push(
        `- ${citation.path} (cited at ${citation.commit.slice(0, 10)})`
      );
    }
  }

  if (report.unresolved.length > 0) {
    lines.push(
      "",
      "Cited paths the clone does not hold at their commit (check the header by hand):",
      ""
    );

    for (const entry of report.unresolved) {
      lines.push(
        `- ${entry.file}: ${entry.path} at ${entry.commit.slice(0, 10)}`
      );
    }
  }

  const shown = all
    ? report.commits
    : report.commits.filter(
        (commit) => commit.tier === "fix, logic" || commit.tier === "fix"
      );

  lines.push(
    "",
    `## Triage: ${String(report.commits.length)} upstream commits, ${String(shown.length)} shown`,
    ""
  );

  if (shown.length > 0) {
    lines.push(
      "| Tier | Commit | Date | Subject | Upstream paths | Cairn files |",
      "| --- | --- | --- | --- | --- | --- |"
    );

    for (const commit of shown) {
      lines.push(
        `| ${commit.tier} | ${commit.sha.slice(0, 10)} | ${commit.date} | ${cell(commit.subject)} | ${commit.paths.join(", ")} | ${commit.files.join(", ")} |`
      );
    }
  }

  const hidden = report.commits.length - shown.length;

  if (hidden > 0) {
    lines.push(
      "",
      `${String(hidden)} commits that are not fixes are left out; --all lists them.`
    );
  }

  return `${lines.join("\n")}\n`;
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      all: { type: "boolean", default: false },
      clone: { type: "string", default: DEFAULT_CLONE },
      ref: { type: "string", default: DEFAULT_REF },
    },
  });

  const root = path.join(import.meta.dirname, "..");

  if (existsSync(values.clone)) {
    const report = survey(findPorts(root), openClone(values.clone), values.ref);

    process.stdout.write(
      render(report, DateTime.toEpochMillis(DateTime.nowUnsafe()), values.all)
    );
  } else {
    process.stderr.write(`No t3code clone at ${values.clone}.\n`);
    process.exitCode = 2;
  }
}
