// Runs the repo's oxlint over files and reads its JSON report: which rule fired on which line of
// which file. The lint judges (`lint-boundaries.test.ts`, `lint-rules.test.ts`) write probe files
// into real zones, so the repo's own config and overrides apply.

import { spawnSync } from "node:child_process";
import path from "node:path";

import { Schema } from "effect";

const root = path.join(import.meta.dirname, "..", "..");

const oxlint = path.join(root, "node_modules", ".bin", "oxlint");

const Report = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      filename: Schema.String,
      labels: Schema.Array(
        Schema.Struct({ span: Schema.Struct({ line: Schema.Int }) })
      ),
    })
  ),
});

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(Report));

/** One finding: the rule's code (`anti-slop(no-reflect-get)`), the file and its 1-based lines. */
export interface Finding {
  readonly code: string;
  readonly filename: string;
  readonly lines: ReadonlyArray<number>;
}

/** Lints `files` (paths relative to the repo root) in one run. */
export const lint = (files: ReadonlyArray<string>): ReadonlyArray<Finding> => {
  // spawnSync never throws on a non-zero exit, which oxlint uses whenever it reports anything.
  const result = spawnSync(oxlint, ["-f", "json", ...files], {
    cwd: root,
    encoding: "utf-8",
  });

  return decodeReport(result.stdout).diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    filename: diagnostic.filename,
    lines: diagnostic.labels.map((label) => label.span.line),
  }));
};
