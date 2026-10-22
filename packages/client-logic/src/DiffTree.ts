// Ported from github.com/pingdotgg/t3code, apps/web/src/lib/turnDiffTree.ts (`buildTurnDiffTree`,
// `summarizeTurnDiffStats`) and apps/web/src/components/diffs/diffFileTree.logic.ts (the file
// status of `toGitStatus`) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92, and from cairn-v1,
// apps/web/src/patch.ts (`parsePatch`) at 1a5cd4a. Kept: the tree of changed files with each
// directory's summed stats, single-directory chains compacted, directories before files and both
// in natural order; the small unified-diff parser whose unknown lines fall back to context. Changed:
// every file carries numbers (the server counts a binary file as 0 and 0), optional values are
// `Option`, a parsed file carries its status, and the checkpoint entry's data is decoded here for
// the changed-files card. Removed: the `@pierre/trees` model glue (Cairn draws its own tree).
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
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
import type { Entry } from "@cairn/protocol/Thread";
import { Option, Schema } from "effect";

/** The data an entry carries, as the wire decoded it. */

/** Lines a file or a directory gained and lost. */
export interface DiffStat {
  readonly additions: number;
  readonly deletions: number;
}

/** One changed file of a turn. */
export interface TurnDiffFile extends DiffStat {
  readonly path: string;
}

/** A folder of the changed-files tree, with the sum of its files' stats. */
export interface DiffTreeDirectory {
  readonly kind: "directory";
  readonly name: string;
  readonly path: string;
  readonly stat: DiffStat;
  readonly children: ReadonlyArray<DiffTreeNode>;
}

/** A file of the changed-files tree. */
export interface DiffTreeFile {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly stat: DiffStat;
}

export type DiffTreeNode = DiffTreeDirectory | DiffTreeFile;

/**
 * The data of a `cairn.checkpoint` transcript entry, as the brain writes it (`git/CheckpointCapture.ts`
 * on the server): the turn, its ref, HEAD at capture, when, and the files the turn authored.
 */
const CheckpointEntryData = Schema.Struct({
  turn: Schema.Int,
  ref: Schema.String,
  headOid: Schema.NullOr(Schema.String),
  capturedAt: Schema.Int,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      additions: Schema.Int,
      deletions: Schema.Int,
    })
  ),
  moreFiles: Schema.Int,
});

/** A checkpoint as the changed-files card shows it. */
export interface CheckpointSummary {
  readonly turn: number;
  readonly ref: string;
  readonly files: ReadonlyArray<TurnDiffFile>;
  /** Files changed beyond the ones listed. */
  readonly moreFiles: number;
}

const decodeEntryData = Schema.decodeUnknownOption(CheckpointEntryData);

/** Reads a `cairn.checkpoint` entry's data; none for data of another shape. */
export const checkpointSummaryOf = (
  data: Entry["data"]
): Option.Option<CheckpointSummary> =>
  Option.map(decodeEntryData(data), (decoded) => ({
    turn: decoded.turn,
    ref: decoded.ref,
    files: decoded.files,
    moreFiles: decoded.moreFiles,
  }));

const COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

const byName = (left: { name: string }, right: { name: string }) =>
  COLLATOR.compare(left.name, right.name);

const segmentsOf = (path: string) =>
  path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);

/** The sum of the files' stats. */
export const summarizeTurnDiffStats = (
  files: ReadonlyArray<TurnDiffFile>
): DiffStat => {
  let additions = 0;
  let deletions = 0;

  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }

  return { additions, deletions };
};

interface Building {
  readonly name: string;
  readonly path: string;
  additions: number;
  deletions: number;
  readonly directories: Map<string, Building>;
  readonly files: Array<DiffTreeFile>;
}

const building = (name: string, path: string): Building => ({
  name,
  path,
  additions: 0,
  deletions: 0,
  directories: new Map(),
  files: [],
});

// A folder whose only child is a folder folds into it: `apps/server` instead of two levels.
const compact = (node: DiffTreeDirectory): DiffTreeDirectory => {
  let folded: DiffTreeDirectory = node;

  for (;;) {
    const [only] = folded.children;

    if (folded.children.length !== 1 || only?.kind !== "directory") {
      return folded;
    }

    folded = {
      kind: "directory",
      name: `${folded.name}/${only.name}`,
      path: only.path,
      stat: only.stat,
      children: only.children,
    };
  }
};

const toNodes = (directory: Building): ReadonlyArray<DiffTreeNode> => [
  ...[...directory.directories.values()].toSorted(byName).map((child) =>
    compact({
      kind: "directory",
      name: child.name,
      path: child.path,
      stat: { additions: child.additions, deletions: child.deletions },
      children: toNodes(child),
    })
  ),
  ...directory.files.toSorted(byName),
];

/** The changed files as a tree: folders first, single-folder chains folded, stats summed. */
export const buildTurnDiffTree = (
  files: ReadonlyArray<TurnDiffFile>
): ReadonlyArray<DiffTreeNode> => {
  const root = building("", "");

  for (const file of files) {
    const segments = segmentsOf(file.path);
    const name = segments.at(-1);

    if (name === undefined) {
      continue;
    }

    const stat = { additions: file.additions, deletions: file.deletions };
    const ancestors = [root];
    let current = root;

    for (const segment of segments.slice(0, -1)) {
      const existing = current.directories.get(segment);

      const next =
        existing ??
        building(
          segment,
          current.path === "" ? segment : `${current.path}/${segment}`
        );

      if (existing === undefined) {
        current.directories.set(segment, next);
      }

      current = next;
      ancestors.push(current);
    }

    current.files.push({ kind: "file", name, path: segments.join("/"), stat });

    for (const ancestor of ancestors) {
      ancestor.additions += stat.additions;
      ancestor.deletions += stat.deletions;
    }
  }

  return toNodes(root);
};

/** One line of a hunk. */
export interface PatchLine {
  readonly kind: "added" | "removed" | "context" | "note";
  /** The line's number in the old file; none for an added line. */
  readonly oldNumber: Option.Option<number>;
  /** The line's number in the new file; none for a removed line. */
  readonly newNumber: Option.Option<number>;
  readonly text: string;
}

export interface PatchHunk {
  readonly header: string;
  readonly lines: ReadonlyArray<PatchLine>;
}

/** How a file changed. */
export type PatchFileStatus = "added" | "deleted" | "renamed" | "modified";

/** One file of a unified diff. */
export interface PatchFile {
  /** The new path, or the old one for a deletion. */
  readonly path: string;
  /** The old path when it differs (a rename). */
  readonly oldPath: Option.Option<string>;
  readonly status: PatchFileStatus;
  readonly binary: boolean;
  readonly hunks: ReadonlyArray<PatchHunk>;
  readonly stat: DiffStat;
}

const HUNK = /^@@ -(?<old>\d+)(?:,\d+)? \+(?<new>\d+)(?:,\d+)? @@/u;

/** `a/x` or `"a/x y"`: git quotes a path with odd characters. */
const unquote = (path: string) =>
  path.startsWith('"') && path.endsWith('"')
    ? path
        .slice(1, -1)
        .replaceAll(/\\(?<escaped>[\\"tn])/gu, (_match, escaped: string) => {
          if (escaped === "t") {
            return "\t";
          }

          return escaped === "n" ? "\n" : escaped;
        })
    : path;

const stripPrefix = (path: string): Option.Option<string> => {
  const plain = unquote(path.trim());

  return plain === "/dev/null"
    ? Option.none()
    : Option.some(plain.replace(/^[ab]\//u, ""));
};

interface BuildingFile {
  path: string;
  oldPath: Option.Option<string>;
  added: boolean;
  deleted: boolean;
  renamed: boolean;
  binary: boolean;
  readonly hunks: Array<{ header: string; lines: Array<PatchLine> }>;
}

const headerLine = (file: BuildingFile, line: string): boolean => {
  if (line.startsWith("--- ")) {
    const old = stripPrefix(line.slice(4));

    if (Option.isSome(old)) {
      file.oldPath = old;
    } else {
      file.added = true;
    }

    return true;
  }

  if (line.startsWith("+++ ")) {
    const next = stripPrefix(line.slice(4));

    if (Option.isSome(next)) {
      file.path = next.value;
    } else {
      file.deleted = true;
      file.path = Option.getOrElse(file.oldPath, () => file.path);
    }

    return true;
  }

  if (line.startsWith("new file mode ")) {
    file.added = true;

    return true;
  }

  if (line.startsWith("deleted file mode ")) {
    file.deleted = true;

    return true;
  }

  if (line.startsWith("rename from ")) {
    file.oldPath = Option.some(unquote(line.slice("rename from ".length)));
    file.renamed = true;

    return true;
  }

  if (line.startsWith("rename to ")) {
    file.path = unquote(line.slice("rename to ".length));
    file.renamed = true;

    return true;
  }

  if (line.startsWith("Binary files ") || line === "GIT binary patch") {
    file.binary = true;

    return true;
  }

  return false;
};

const statusOf = (file: BuildingFile): PatchFileStatus => {
  if (file.added) {
    return "added";
  }

  if (file.deleted) {
    return "deleted";
  }

  return file.renamed ? "renamed" : "modified";
};

/** Reads `git diff --patch` into files of hunks of numbered lines. Unknown lines become context. */
export const parsePatch = (patch: string): ReadonlyArray<PatchFile> => {
  const files: Array<BuildingFile> = [];
  let file: BuildingFile | undefined;
  let hunk: { header: string; lines: Array<PatchLine> } | undefined;
  let oldNumber = 0;
  let newNumber = 0;
  const lines = patch.split("\n");

  if (lines.at(-1) === "") {
    lines.pop();
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      // `diff --git a/x b/x`: a fallback name until ---, +++ or rename lines give the real one.
      const rest = line.slice("diff --git ".length);
      const middle = rest.indexOf(" b/");

      file = {
        path: unquote(middle === -1 ? rest : rest.slice(middle + 3)),
        oldPath: Option.none(),
        added: false,
        deleted: false,
        renamed: false,
        binary: false,
        hunks: [],
      };
      files.push(file);
      hunk = undefined;
      continue;
    }

    if (file === undefined || (hunk === undefined && headerLine(file, line))) {
      continue;
    }

    const match = HUNK.exec(line);

    if (match !== null) {
      oldNumber = Number(match.groups?.old);
      newNumber = Number(match.groups?.new);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }

    if (hunk === undefined) {
      continue;
    }

    const sign = line.slice(0, 1);
    const text = line.slice(1);

    if (sign === "+") {
      hunk.lines.push({
        kind: "added",
        oldNumber: Option.none(),
        newNumber: Option.some(newNumber),
        text,
      });
      newNumber += 1;
    } else if (sign === "-") {
      hunk.lines.push({
        kind: "removed",
        oldNumber: Option.some(oldNumber),
        newNumber: Option.none(),
        text,
      });
      oldNumber += 1;
    } else if (sign === "\\") {
      hunk.lines.push({
        kind: "note",
        oldNumber: Option.none(),
        newNumber: Option.none(),
        text: line.slice(2),
      });
    } else {
      hunk.lines.push({
        kind: "context",
        oldNumber: Option.some(oldNumber),
        newNumber: Option.some(newNumber),
        text,
      });
      oldNumber += 1;
      newNumber += 1;
    }
  }

  return files.map((found) => {
    const all = found.hunks.flatMap((part) => part.lines);

    return {
      path: found.path,
      // A file whose old path equals its new one is not a rename.
      oldPath: Option.filter(found.oldPath, (old) => old !== found.path),
      status: statusOf(found),
      binary: found.binary,
      hunks: found.hunks,
      stat: {
        additions: all.filter((line) => line.kind === "added").length,
        deletions: all.filter((line) => line.kind === "removed").length,
      },
    };
  });
};
