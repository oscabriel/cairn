// The upstream triage script against a fixture: a small git repository standing in for the t3code
// clone, and a Cairn tree whose port headers cite it. The parse is checked on the header forms the
// repository really uses; the survey on which commits it lists, in what order, and what it says
// about a stale clone, a moved path and a header it cannot resolve. The fixture clone must come out
// unchanged.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import {
  citationsIn,
  findPorts,
  headerOf,
  isUnparsed,
  openClone,
  render,
  survey,
  tierOf,
} from "./t3code-upstream.ts";
import type { Report } from "./t3code-upstream.ts";

const SHA = "fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92";

describe("a header's t3code citations", () => {
  it("reads a path followed by its commit", () => {
    const header = headerOf(
      [
        "// Ported from github.com/pingdotgg/t3code, apps/server/src/http.ts (`route`,",
        `// lines 459 to 496) at ${SHA}. Kept: apps/server/src/Cairn.ts is ours.`,
        "",
        'import { Effect } from "effect";',
      ].join("\n")
    );

    expect(citationsIn(header)).toStrictEqual([
      { path: "apps/server/src/http.ts", commit: SHA },
    ]);
  });

  it("reads a commit before its paths, a bare name beside the path before it, and a wrapped path", () => {
    const header = headerOf(
      [
        `// Ported from github.com/pingdotgg/t3code at ${SHA}:`,
        "// packages/provider-core/src/server/textGenerationPrompts.ts (`build`) and",
        "// textGenerationUtils.ts (`limit`), and apps/web/src/components/",
        "// Sidebar.logic.ts (`rows`).",
      ].join("\n")
    );

    expect(citationsIn(header)).toStrictEqual([
      {
        path: "packages/provider-core/src/server/textGenerationPrompts.ts",
        commit: SHA,
      },
      { path: "apps/web/src/components/Sidebar.logic.ts", commit: SHA },
      {
        path: "packages/provider-core/src/server/textGenerationUtils.ts",
        commit: SHA,
      },
    ]);
  });

  it("expands a brace group, with spaces and prose inside it", () => {
    const header = headerOf(
      `// Ported from github.com/pingdotgg/t3code, packages/contracts/src/{orchestrationV2.ts (A, B),\n// orchestrationProject.ts (C)} and apps/web/src/chat/{Picker,Menu}.tsx at ${SHA}.`
    );

    expect(citationsIn(header)).toStrictEqual([
      { path: "packages/contracts/src/orchestrationV2.ts", commit: SHA },
      { path: "packages/contracts/src/orchestrationProject.ts", commit: SHA },
      { path: "apps/web/src/chat/Picker.tsx", commit: SHA },
      { path: "apps/web/src/chat/Menu.tsx", commit: SHA },
    ]);
  });

  it("keeps another source's paths out, and reads a bare t3code citation", () => {
    const header = headerOf(
      [
        "// Ported from cairn-v1, apps/server/src/RepoIdentity.ts at 1a5cd4a, itself ported from",
        "// github.com/pingdotgg/t3code at 5307c233b1f0ae72b8894dd39d94019aaf9e7cb8 (packages/shared/src/git.ts).",
        "// Layout after github.com/anomalyco/opencode, packages/ui/src/Layout.tsx at 743f6410f2e5;",
        "// helpers from pingdotgg/t3code apps/web/src/lib/utils.ts at c079503d.",
      ].join("\n")
    );

    expect(citationsIn(header)).toStrictEqual([
      {
        path: "packages/shared/src/git.ts",
        commit: "5307c233b1f0ae72b8894dd39d94019aaf9e7cb8",
      },
      { path: "apps/web/src/lib/utils.ts", commit: "c079503d" },
    ]);
  });

  // The prose forms below are copied from real headers (ThreadWindow.ts, Http.ts, TimelineEntries.ts,
  // composer/PopoverClasses.ts, ThreadWire.ts): a citation need not start with a URL or "t3code at".
  it("reads a possessive citation that ends at Changed:", () => {
    const header = headerOf(
      [
        "// Policy numbers from t3code's apps/server/src/orchestration-v2/threadHistoryPaging.ts",
        `// (\`THREAD_HISTORY_PAGE_POLICY\`) at ${SHA}. Changed: apps/server/src/Window.ts is ours.`,
      ].join("\n")
    );

    expect(citationsIn(header)).toStrictEqual([
      {
        path: "apps/server/src/orchestration-v2/threadHistoryPaging.ts",
        commit: SHA,
      },
    ]);
  });

  it("reads a backticked path with a line range", () => {
    const header = headerOf(
      [
        "// The server layer follows t3code",
        `// \`apps/server/src/server.ts\` lines 295 to 314 at ${SHA}, without its serving gate.`,
      ].join("\n")
    );

    expect(citationsIn(header)).toStrictEqual([
      { path: "apps/server/src/server.ts", commit: SHA },
    ]);
  });

  it("reads a citation where t3code is the sentence's subject", () => {
    const header = headerOf(
      [
        "// The transcript's entries. t3code derives its timeline from orchestration turn items",
        `// (apps/web/src/session-logic.ts at ${SHA}); Cairn's source is pi's own transcript.`,
      ].join("\n")
    );

    expect(citationsIn(header)).toStrictEqual([
      { path: "apps/web/src/session-logic.ts", commit: SHA },
    ]);
  });

  it("reads a commit named before a parenthesised brace group and a bare name", () => {
    const header = headerOf(
      [
        `// Class strings copied from t3code's rendered composer at ${SHA}`,
        "// (apps/web/src/components/chat/{ChatComposer,ComposerSurface}.tsx and",
        "// BranchToolbar.tsx, read from the live nightly's DOM).",
      ].join("\n")
    );

    expect(citationsIn(header)).toStrictEqual([
      { path: "apps/web/src/components/chat/ChatComposer.tsx", commit: SHA },
      { path: "apps/web/src/components/chat/ComposerSurface.tsx", commit: SHA },
      { path: "apps/web/src/components/chat/BranchToolbar.tsx", commit: SHA },
    ]);
  });

  it("reads a t3code citation after a cairn-v1 one, past an earlier bare mention", () => {
    const header = headerOf(
      [
        "// Strings over 32 KiB are cut (t3code's limits).",
        "// Ported in part from cairn-v1, apps/server/src/visible.ts at 1a5cd4a; the truncation marker",
        `// follows t3code's apps/server/src/orchestration-v2/WireProjection.ts at ${SHA}.`,
      ].join("\n")
    );

    expect(citationsIn(header)).toStrictEqual([
      {
        path: "apps/server/src/orchestration-v2/WireProjection.ts",
        commit: SHA,
      },
    ]);
  });

  it("calls a header unparsed when it names t3code with a commit but no path is read", () => {
    expect(
      isUnparsed(
        headerOf(
          `// The shape of t3code's sidebar at ${SHA}, read from the DOM.`
        )
      )
    ).toBeTruthy();
    expect(
      isUnparsed(
        headerOf(
          `// From t3code's apps/web/src/a.ts at ${SHA}, and cairn-v1 at 1a5cd4a.`
        )
      )
    ).toBeFalsy();
    expect(
      isUnparsed(headerOf("// Unlike t3code, this keeps no cache."))
    ).toBeFalsy();
  });

  it("reads only the leading comment block", () => {
    const text = [
      "// A plain module.",
      "",
      'import { Effect } from "effect";',
      `// From github.com/pingdotgg/t3code, apps/web/src/late.ts at ${SHA}.`,
    ].join("\n");

    expect(citationsIn(headerOf(text))).toStrictEqual([]);
  });
});

describe("a commit's triage tier", () => {
  it.each([
    ["fix(web): x", "apps/web/src/a/Sidebar.logic.ts", "fix, logic"],
    ["fix: x", "packages/shared/src/git.ts", "fix, logic"],
    [
      "fix!: x",
      "packages/client-runtime/src/state/threadShell.ts",
      "fix, logic",
    ],
    ["fix(web): x", "apps/web/src/ChatView.tsx", "fix"],
    ["feat: x", "apps/web/src/a/Sidebar.logic.ts", "logic"],
    ["refactor: fixes nothing", "apps/web/src/a.ts", "other"],
  ])("reads %s on %s as %s", (subject, cited, tier) => {
    expect(tierOf(subject, [cited])).toBe(tier);
  });
});

/** Git with a fixed identity and clock, and none of the caller's git environment or config. */
const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  date = "2026-10-01T00:00:00Z"
) => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) {
      env[key] = value;
    }
  }

  const done = spawnSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
    {
      cwd,
      encoding: "utf-8",
      env: {
        ...env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    }
  );

  if (done.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
  }

  return done.stdout.trim();
};

const write = (root: string, file: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};

const commit = (repo: string, subject: string, date: string) => {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", subject], date);

  return git(repo, ["rev-parse", "HEAD"]);
};

describe("survey and render on a fixture clone", () => {
  let scratch = "";
  let upstream = "";
  let cairn = "";
  let base = "";
  let side = "";
  let report: Report | null = null;

  const NOW = Date.parse("2026-11-01T00:00:00Z");

  beforeAll(() => {
    scratch = mkdtempSync(path.join(tmpdir(), "t3code-upstream-"));
    upstream = path.join(scratch, "t3code");
    cairn = path.join(scratch, "cairn");
    mkdirSync(upstream);
    git(upstream, ["init", "-q"]);

    write(upstream, "packages/shared/src/git.ts", "export const a = 1;\n");
    write(
      upstream,
      "apps/web/src/components/Sidebar.logic.ts",
      "export const b = 1;\n"
    );
    write(
      upstream,
      "apps/web/src/components/ChatView.tsx",
      "export const c = 1;\n"
    );
    write(upstream, "apps/web/src/old.ts", "export const d = 1;\n");
    write(upstream, "README.md", "t3code\n");
    base = commit(upstream, "feat: the base", "2026-09-01T00:00:00Z");

    write(upstream, "packages/shared/src/git.ts", "export const a = 2;\n");
    commit(
      upstream,
      "fix(shared): branch names keep accents (#1)",
      "2026-09-10T00:00:00Z"
    );
    write(
      upstream,
      "apps/web/src/components/Sidebar.logic.ts",
      "export const b = 2;\n"
    );
    commit(
      upstream,
      "feat(web): a new sidebar group (#2)",
      "2026-09-11T00:00:00Z"
    );
    write(
      upstream,
      "apps/web/src/components/ChatView.tsx",
      "export const c = 2;\n"
    );
    commit(
      upstream,
      "fix(web): the composer keeps focus (#3)",
      "2026-09-12T00:00:00Z"
    );
    write(upstream, "README.md", "t3code, again\n");
    commit(upstream, "chore: readme (#4)", "2026-09-13T00:00:00Z");
    rmSync(path.join(upstream, "apps/web/src/old.ts"));
    commit(upstream, "refactor(web): drop old (#5)", "2026-10-01T00:00:00Z");

    git(upstream, ["checkout", "-q", "-b", "later"]);
    write(
      upstream,
      "apps/web/src/components/ChatView.tsx",
      "export const c = 3;\n"
    );
    side = commit(
      upstream,
      "fix(web): not on main yet (#6)",
      "2026-10-02T00:00:00Z"
    );
    git(upstream, ["checkout", "-q", "main"]);

    write(
      cairn,
      "apps/server/src/projects/Branches.ts",
      [
        `// Ported from github.com/pingdotgg/t3code at ${base}:`,
        "// packages/shared/src/git.ts (`sanitize`) and apps/web/src/old.ts. Kept: the prefix.",
        "",
        "export const branches = 1;",
        "",
      ].join("\n")
    );
    write(
      cairn,
      "packages/client-logic/src/Sidebar.ts",
      [
        "// Ported from github.com/pingdotgg/t3code, apps/web/src/components/Sidebar.logic.ts and",
        `// ChatView.tsx at ${base}. Also apps/web/src/components/Missing.ts at ${base}.`,
        "",
        "export const sidebar = 1;",
        "",
      ].join("\n")
    );
    write(
      cairn,
      "apps/web/src/Later.ts",
      `// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ChatView.tsx at ${side}.\n\nexport const later = 1;\n`
    );
    write(
      cairn,
      "apps/web/src/Prose.ts",
      `// The shape of t3code's sidebar at ${base}, read from the DOM.\n\nexport const prose = 1;\n`
    );
    write(
      cairn,
      "apps/web/src/Plain.ts",
      "// No port here.\n\nexport const plain = 1;\n"
    );

    report = survey(findPorts(cairn), openClone(upstream), "main");
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("finds the ports, and names a header it could not read", () => {
    const scan = findPorts(cairn);

    expect(scan.ports.map((port) => port.file).toSorted()).toStrictEqual([
      "apps/server/src/projects/Branches.ts",
      "apps/web/src/Later.ts",
      "packages/client-logic/src/Sidebar.ts",
    ]);
    expect(scan.unparsed).toStrictEqual(["apps/web/src/Prose.ts"]);
  });

  it("lists fixes on logic paths first, then other fixes, then the rest", () => {
    expect(
      report?.commits.map((row) => [row.tier, row.subject, row.files])
    ).toStrictEqual([
      [
        "fix, logic",
        "fix(shared): branch names keep accents (#1)",
        ["apps/server/src/projects/Branches.ts"],
      ],
      [
        "fix",
        "fix(web): the composer keeps focus (#3)",
        ["packages/client-logic/src/Sidebar.ts"],
      ],
      [
        "logic",
        "feat(web): a new sidebar group (#2)",
        ["packages/client-logic/src/Sidebar.ts"],
      ],
      [
        "other",
        "refactor(web): drop old (#5)",
        ["apps/server/src/projects/Branches.ts"],
      ],
    ]);
  });

  it("names a path deleted upstream, a path the header got wrong, and a commit newer than the ref", () => {
    expect(report?.gone).toStrictEqual([
      { path: "apps/web/src/old.ts", commit: base },
    ]);
    expect(report?.unresolved).toStrictEqual([
      {
        file: "packages/client-logic/src/Sidebar.ts",
        path: "apps/web/src/components/Missing.ts",
        commit: base,
      },
    ]);
    expect(report?.cited.find((entry) => entry.commit === side)?.state).toBe(
      "ahead"
    );
  });

  const rendered = (all: boolean) => {
    if (report === null) {
      throw new Error("no report");
    }

    return render(report, NOW, all);
  };

  it("renders the header it could not read", () => {
    expect(rendered(false)).toContain(
      "Headers that name t3code and a commit but cite no path this script can read (check by hand):\n\n- apps/web/src/Prose.ts"
    );
  });

  it("renders how old the clone is, and a cited commit it cannot compare", () => {
    const text = rendered(false);

    expect(text).toContain("(2026-10-01, 31 days before today)");
    expect(text).toContain(
      "newer than main, so the clone holds nothing since it"
    );
  });

  it("renders only the fixes unless asked for all", () => {
    const text = rendered(false);

    expect(text).toContain("| fix, logic |");
    expect(text).toContain("| fix |");
    expect(text).not.toContain("a new sidebar group");
    expect(text).toContain(
      "2 commits that are not fixes are left out; --all lists them."
    );
  });

  it("renders every commit, fixes first, when asked for all", () => {
    const text = rendered(true);

    expect(text.indexOf("| fix, logic |")).toBeLessThan(
      text.indexOf("| fix |")
    );
    expect(text.indexOf("| fix |")).toBeLessThan(text.indexOf("| logic |"));
    expect(text.indexOf("| logic |")).toBeLessThan(text.indexOf("| other |"));
    expect(text).not.toContain("chore: readme");
  });

  it("leaves the clone as it was", () => {
    expect(git(upstream, ["status", "--porcelain"])).toBe("");
    expect(existsSync(path.join(upstream, ".git", "FETCH_HEAD"))).toBeFalsy();
    expect(git(upstream, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });
});
