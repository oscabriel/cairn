// Proves the library boundaries in oxlint.config.ts fire (coding standard S42 as amended by plan
// D54, and ADR 0002's refusal of pi-ai's Anthropic OAuth login): each case writes a probe file with
// a unique name into a zone, lints it with the repo's config and checks, line by line, which
// imports were refused. Zones keyed on one exact file name (AnthropicGuard.ts, PiConfig.ts,
// ClaudeSdk.ts, ...) are not probed, because a probe there would overwrite real code. A probe is
// removed in a `finally`, and probes a killed run left behind are swept before the cases run.

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

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

/** The 1-based lines of `file` that oxlint refused with `no-restricted-imports`. */
const refusedLines = (file: string): ReadonlySet<number> =>
  new Set(
    lint([file])
      .filter((finding) => finding.code === "eslint(no-restricted-imports)")
      .flatMap((finding) => finding.lines)
  );

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

describe("library import boundaries", () => {
  sweepProbes();

  it.each(cases)(
    "refuses exactly the listed imports in $zone/$name",
    (probeCase) => {
      const id = `${process.pid}${randomBytes(4).toString("hex")}`;

      const file = path.join(
        probeCase.zone,
        probeCase.name.replace("<id>", id)
      );

      const directory = path.join(root, probeCase.zone);
      const directoryExisted = existsSync(directory);
      const source = `${probeCase.probes.map((probe) => probe.source).join("\n")}\n\nexport {};\n`;

      mkdirSync(directory, { recursive: true });

      let refusedByLint: ReadonlySet<number>;

      try {
        writeFileSync(path.join(root, file), source);
        refusedByLint = refusedLines(file);
      } finally {
        rmSync(path.join(root, file), { force: true });

        if (!directoryExisted) {
          rmSync(directory, { recursive: true, force: true });
        }
      }

      for (const [index, probe] of probeCase.probes.entries()) {
        assert.strictEqual(
          refusedByLint.has(index + 1),
          probe.refused,
          `${file}: ${probe.source}`
        );
      }
    }
  );
});
