// Port headers judge (T57): a file drawn from another repo starts with its header, a port of
// t3code (MIT) carries the notice, and no doc comment sits on top of another one's declaration. The import sorter moves a comment that sits between imports
// along with the import below it, so a header written after the first import ends up buried.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

const root = path.join(import.meta.dirname, "..");

const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx"], {
  cwd: root,
  encoding: "utf-8",
})
  .split("\n")
  .filter(
    (file) =>
      file !== "" &&
      !file.startsWith("spikes/") &&
      !file.startsWith("tools/oxlint/anti-slop/")
  );

const read = (file: string) => readFileSync(path.join(root, file), "utf-8");

/** The comment lines a file starts with. */
const headerOf = (text: string) => {
  const lines = text.split("\n");
  const end = lines.findIndex((line) => !line.startsWith("//"));

  return lines.slice(0, end === -1 ? lines.length : end).join("\n");
};

const PORT = /^\/\/ .*\b(?:Ported|ported) (?:in part )?from\b/mu;

// "ported from github.com/pingdotgg/t3code", the URL possibly on the next comment line.
const T3CODE_PORT =
  /\bported (?:in part )?from\s*(?:\n\/\/\s*)?github\.com\/pingdotgg\/t3code/iu;

/** A comment block of two lines or more right above an import that is not the file's first line. */
const buriedHeader = (text: string) => {
  const lines = text.split("\n");
  const firstImport = lines.findIndex((line) => line.startsWith("import"));

  return (
    firstImport === 0 &&
    lines.some(
      (line, index) =>
        index > 1 &&
        line.startsWith("import") &&
        lines[index - 1]?.startsWith("//") === true &&
        lines[index - 2]?.startsWith("//") === true
    )
  );
};

describe("port headers", () => {
  it("starts every ported file with its header", () => {
    const late = files.filter((file) => {
      const text = read(file);

      return PORT.test(text) && !text.startsWith("//");
    });

    assert.deepStrictEqual(late, []);
  });

  it("keeps no header block between imports", () => {
    assert.deepStrictEqual(
      files.filter((file) => buriedHeader(read(file))),
      []
    );
  });

  it("puts each doc comment on its own declaration", () => {
    // A one-line doc comment followed by another doc comment belongs to something else.
    const stacked = files.flatMap((file) => {
      const lines = read(file).split("\n");

      return lines.flatMap((line, index) => {
        const here = line.trim();

        return here.startsWith("/**") &&
          here.endsWith("*/") &&
          (lines[index + 1] ?? "").trim().startsWith("/**")
          ? [`${file}:${index + 1}`]
          : [];
      });
    });

    assert.deepStrictEqual(stacked, []);
  });

  it("gives every port of t3code the MIT notice", () => {
    const bare = files.filter((file) => {
      const header = headerOf(read(file));

      return T3CODE_PORT.test(header) && !header.includes("MIT License");
    });

    assert.deepStrictEqual(bare, []);
  });
});
