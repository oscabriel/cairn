// Brand judge (plan D24): Cairn copies t3code's layout and class strings but none of its brand.
// Fails on t3code names, storage keys, CSS names and git refs anywhere in the code of the apps and
// packages. Comments may name t3code (port headers and notes say where code came from), so they
// are stripped before the scan, and tests are skipped: they do not ship.
//
// Known leftovers that another package owns are listed with their owner instead of failing the
// gate; the list must match what the scan finds exactly, so a fixed leftover has to leave the list
// and a new one fails.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

const root = path.join(import.meta.dirname, "..");

/** Brand leftovers: product names, the wordmark component, storage keys, CSS names, refs. */
const LEFTOVERS: ReadonlyArray<string> = [
  "T3 Code",
  "t3code",
  "T3Wordmark",
  "t3-context",
  "t3-mobile",
  "refs/t3",
  '"t3/',
];

/** Leftovers waiting on their owner, by file. None remain. */
const KNOWN: Readonly<Record<string, ReadonlyArray<string>>> = {};

const SCANNED = /\.(?:ts|tsx|js|mjs|css|html|json|webmanifest)$/u;

/** Tests do not ship; their names cite t3code's behaviour on purpose. */
const TESTS = /\.test\.tsx?$/u;

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

    return SCANNED.test(entry.name) && !TESTS.test(entry.name)
      ? [entryPath]
      : [];
  });

/** The file's text without comments: block comments, HTML comments and line comments. */
const withoutComments = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/<!--[\s\S]*?-->/gu, "")
    .replaceAll(/(?<before>^|[^:"'`\\])\/\/.*$/gmu, "$<before>");

/** The leftovers found in a file's code. */
const leftoversIn = (text: string): ReadonlyArray<string> => {
  const code = withoutComments(text);

  return LEFTOVERS.filter((leftover) => code.includes(leftover));
};

describe("brand leftovers", () => {
  it("finds a leftover in code and ignores the same words in comments", () => {
    const header =
      "// Ported from github.com/pingdotgg/t3code (T3 Code), keys were t3code:drafts\n";

    assert.deepStrictEqual(
      leftoversIn(`${header}export const key = "cairn:drafts";\n`),
      []
    );
    assert.deepStrictEqual(
      leftoversIn(`${header}export const key = "t3code:drafts";\n`),
      ["t3code"]
    );
    assert.deepStrictEqual(
      leftoversIn('/*\n * T3 Code\n */\nconst ref = "refs/t3/x";\n'),
      ["refs/t3"]
    );
    assert.deepStrictEqual(
      leftoversIn(
        "const a = 1; // as t3code does\n.x { view-transition-name: t3-mobile-a; }\n"
      ),
      ["t3-mobile"]
    );
    assert.deepStrictEqual(
      leftoversIn('const url = "https://example.com/t3code";\n'),
      ["t3code"]
    );
  });

  it("finds none in apps and packages beyond the known ones", () => {
    const found = Object.fromEntries(
      ["apps", "packages"].flatMap((top) =>
        files(path.join(root, top)).flatMap((file) => {
          const leftovers = leftoversIn(readFileSync(file, "utf-8"));

          return leftovers.length === 0
            ? []
            : [[path.relative(root, file), leftovers]];
        })
      )
    );

    assert.deepStrictEqual(found, KNOWN);
  });
});
