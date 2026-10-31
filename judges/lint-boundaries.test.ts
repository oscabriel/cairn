// Proves the library boundaries in oxlint.config.ts fire (coding standard S42 as amended by plan
// D54, and ADR 0002's refusal of pi-ai's Anthropic OAuth login): each case writes a probe file with
// a unique name into a zone, lints it with the repo's config and checks, line by line, which
// imports were refused. Zones keyed on one exact file name (AnthropicGuard.ts, PiConfig.ts,
// ClaudeSdk.ts, ...) are not probed, because a probe there would overwrite real code. Every probe
// is written first and linted in one oxlint run, since type-aware linting builds its program once
// a run and fourteen runs were slow enough on a busy machine to time out. The probes are removed
// in a `finally`, and probes a killed run left behind are swept before the cases run.

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { assert, beforeAll, describe, it } from "@effect/vitest";

import { lint } from "./lib/Oxlint.ts";

const root = path.join(import.meta.dirname, "..");

interface Probe {
  /** The import statement. */
  readonly source: string;
  readonly refused: boolean;
}

interface ProbeCase {
  readonly zone: string;
  /** The probe's file name inside the zone; `<id>` is replaced by a unique token. */
  readonly name: string;
  readonly probes: ReadonlyArray<Probe>;
}

const refused = (source: string): Probe => ({ source, refused: true });

const allowed = (source: string): Probe => ({ source, refused: false });

const cases: ReadonlyArray<ProbeCase> = [
  {
    zone: "apps/server/src/threads",
    name: "LintProbe<id>.ts",
    probes: [
      refused(
        'import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";'
      ),
      refused(
        'import { builtinProviders } from "@earendil-works/pi-ai/providers/all";'
      ),
      refused('import { complete } from "@earendil-works/pi-ai";'),
      allowed('import type { Model } from "@earendil-works/pi-ai";'),
    ],
  },
  {
    zone: "apps/server/src/projects",
    name: "LintProbe<id>.ts",
    probes: [
      refused('import { Harness } from "@earendil-works/pi-durable";'),
      refused(
        'import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";'
      ),
      refused('import { loadSkills } from "@earendil-works/pi-coding-agent";'),
      refused('import { query } from "@anthropic-ai/claude-agent-sdk";'),
      refused(
        'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";'
      ),
      refused(
        'import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";'
      ),
    ],
  },
  {
    zone: "apps/server/src/brain",
    name: "LintProbe<id>.ts",
    probes: [
      allowed('import { Harness } from "@earendil-works/pi-durable";'),
      allowed('import { complete } from "@earendil-works/pi-ai";'),
      allowed(
        'import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";'
      ),
      refused(
        'import { builtinModels } from "@earendil-works/pi-ai/providers/all";'
      ),
      refused(
        'import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";'
      ),
      refused('import { loadSkills } from "@earendil-works/pi-coding-agent";'),
    ],
  },
  {
    zone: "apps/server/src/executor",
    name: "LintProbe<id>Extension.ts",
    probes: [
      allowed('import { defineExtension } from "@earendil-works/pi-durable";'),
      allowed('import { complete } from "@earendil-works/pi-ai";'),
      refused('import { loadSkills } from "@earendil-works/pi-coding-agent";'),
    ],
  },
  {
    zone: "apps/server/src/skills",
    name: "LintProbe<id>.ts",
    probes: [
      allowed('import { loadSkills } from "@earendil-works/pi-coding-agent";'),
      refused('import { Harness } from "@earendil-works/pi-durable";'),
    ],
  },
  {
    zone: "apps/server/src/models",
    name: "LintProbe<id>.ts",
    probes: [
      allowed('import { complete } from "@earendil-works/pi-ai";'),
      refused('import { Harness } from "@earendil-works/pi-durable";'),
      refused('import { loadSkills } from "@earendil-works/pi-coding-agent";'),
      refused(
        'import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";'
      ),
    ],
  },
  {
    zone: "apps/server/src/skills",
    name: "LintProbe<id>Extension.ts",
    probes: [
      allowed('import { defineExtension } from "@earendil-works/pi-durable";'),
      allowed('import { complete } from "@earendil-works/pi-ai";'),
      allowed('import { loadSkills } from "@earendil-works/pi-coding-agent";'),
      refused('import { query } from "@anthropic-ai/claude-agent-sdk";'),
    ],
  },
  ...["subagents", "approvals", "workflows", "verdicts", "reach"].map(
    (folder): ProbeCase => ({
      zone: `apps/server/src/${folder}`,
      name: "LintProbe<id>.ts",
      probes: [
        allowed('import { defineTool } from "@earendil-works/pi-durable";'),
        allowed('import { complete } from "@earendil-works/pi-ai";'),
        refused(
          'import { loadSkills } from "@earendil-works/pi-coding-agent";'
        ),
        refused('import { query } from "@anthropic-ai/claude-agent-sdk";'),
      ],
    })
  ),
  {
    zone: "apps/server/src/pi-host",
    name: "LintProbe<id>.ts",
    probes: [
      allowed(
        'import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";'
      ),
      allowed('import { defineTool } from "@earendil-works/pi-durable";'),
      refused('import { query } from "@anthropic-ai/claude-agent-sdk";'),
      refused(
        'import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";'
      ),
    ],
  },
  {
    zone: "packages/bridge/src",
    name: "LintProbe<id>.ts",
    probes: [
      allowed('import { createProvider } from "@earendil-works/pi-ai";'),
      refused('import { query } from "@anthropic-ai/claude-agent-sdk";'),
      refused('import { Harness } from "@earendil-works/pi-durable";'),
    ],
  },
  {
    zone: "apps/web/src",
    name: "LintProbe<id>.ts",
    probes: [
      refused('import { Harness } from "@earendil-works/pi-durable";'),
      refused('import { complete } from "@earendil-works/pi-ai";'),
    ],
  },
  {
    zone: "judges/fixtures",
    name: "LintProbe<id>.ts",
    probes: [
      allowed('import { defineExtension } from "@earendil-works/pi-durable";'),
      refused('import { query } from "@anthropic-ai/claude-agent-sdk";'),
    ],
  },
];

/** How long the one oxlint run may take: seconds when idle, far longer under a full gate's load. */
const LINT_TIMEOUT = 180_000;

/** A probe file name, as `ProbeCase.name` makes them. */
const PROBE_FILE = /^LintProbe\d+[0-9a-f]{8}\w*\.ts$/u;

/** Removes the probes a killed run left in the zones. */
const sweepProbes = () => {
  for (const zone of new Set(cases.map((probeCase) => probeCase.zone))) {
    const directory = path.join(root, zone);

    if (existsSync(directory)) {
      for (const name of readdirSync(directory)) {
        if (PROBE_FILE.test(name)) {
          rmSync(path.join(directory, name));
        }
      }
    }
  }
};

/** Each case's probe file, relative to the root, and the 1-based lines oxlint refused in it. */
interface Linted {
  readonly file: string;
  readonly refused: ReadonlySet<number>;
}

/** Writes every case's probe, lints them all in one run, removes them, and reads the refusals. */
const lintProbes = (): ReadonlyArray<Linted> => {
  const created: Array<string> = [];

  const files = cases.map((probeCase) => {
    const id = `${process.pid}${randomBytes(4).toString("hex")}`;

    return path.join(probeCase.zone, probeCase.name.replace("<id>", id));
  });

  try {
    for (const [index, probeCase] of cases.entries()) {
      const directory = path.join(root, probeCase.zone);

      if (!existsSync(directory)) {
        mkdirSync(directory, { recursive: true });
        created.push(directory);
      }

      writeFileSync(
        path.join(root, files[index] ?? ""),
        `${probeCase.probes.map((probe) => probe.source).join("\n")}\n\nexport {};\n`
      );
    }

    const findings = lint(files).filter(
      (finding) => finding.code === "eslint(no-restricted-imports)"
    );

    return files.map((file) => ({
      file,
      refused: new Set(
        findings
          .filter((finding) => finding.filename === file)
          .flatMap((finding) => finding.lines)
      ),
    }));
  } finally {
    for (const file of files) {
      rmSync(path.join(root, file), { force: true });
    }

    for (const directory of created) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
};

describe("library import boundaries", () => {
  sweepProbes();

  let linted: ReadonlyArray<Linted> = [];

  beforeAll(() => {
    linted = lintProbes();
  }, LINT_TIMEOUT);

  it.each(cases.map((probeCase, index) => ({ ...probeCase, index })))(
    "refuses exactly the listed imports in $zone/$name",
    (probeCase) => {
      const result = linted[probeCase.index];

      assert.isDefined(result, "the probes were not linted");

      for (const [index, probe] of probeCase.probes.entries()) {
        assert.strictEqual(
          result.refused.has(index + 1),
          probe.refused,
          `${result.file}: ${probe.source}`
        );
      }
    }
  );
});
