// Brand judge (plan D24): Cairn copies t3code's layout and class strings but none of its brand.
// Fails on t3code names, storage keys and git refs anywhere in the apps and packages, except in a
// file's leading comment block, where port headers name their source.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

const root = path.join(import.meta.dirname, "..");

/** Brand leftovers: product names, the wordmark component, storage key and context prefixes, refs. */
const LEFTOVERS: ReadonlyArray<string> = [
  "T3 Code",
  "t3code:",
  "T3Wordmark",
  "t3-context",
  "refs/t3",
  '"t3/',
];

const SCANNED = /\.(?:ts|tsx|js|mjs|css|html|json|webmanifest)$/u;

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "schema",
  ".vite",
]);

const files = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : files(entryPath);
    }

    return SCANNED.test(entry.name) ? [entryPath] : [];
  });

/** The file's text after its leading comment block (line comments, block comments, blank lines). */
const bodyAfterHeader = (text: string): string => {
  const lines = text.split("\n");
  let inBlock = false;
  let index = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (inBlock) {
      inBlock = !trimmed.includes("*/");
    } else if (trimmed.startsWith("/*") || trimmed.startsWith("<!--")) {
      inBlock = !trimmed.includes("*/") && !trimmed.includes("-->");
    } else if (
      !(trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("#!"))
    ) {
      break;
    }

    index += 1;
  }

  return lines.slice(index).join("\n");
};

/** The leftovers found in a file's body. */
const leftoversIn = (text: string): ReadonlyArray<string> => {
  const body = bodyAfterHeader(text);

  return LEFTOVERS.filter((leftover) => body.includes(leftover));
};

describe("brand leftovers", () => {
  it("finds a leftover in code and ignores the same words in a port header", () => {
    const header =
      "// Ported from github.com/pingdotgg/t3code (T3 Code), keys were t3code:drafts\n";

    assert.deepStrictEqual(
      leftoversIn(`${header}export const key = "cairn:drafts";\n`),
      []
    );
    assert.deepStrictEqual(
      leftoversIn(`${header}export const key = "t3code:drafts";\n`),
      ["t3code:"]
    );
    assert.deepStrictEqual(
      leftoversIn('/*\n * T3 Code\n */\nconst ref = "refs/t3/x";\n'),
      ["refs/t3"]
    );
  });

  it("finds none in apps and packages", () => {
    const found = ["apps", "packages"].flatMap((top) =>
      files(path.join(root, top)).flatMap((file) =>
        leftoversIn(readFileSync(file, "utf-8")).map(
          (leftover) => `${path.relative(root, file)}: ${leftover}`
        )
      )
    );

    assert.deepStrictEqual(found, []);
  });
});
