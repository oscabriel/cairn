// The composer's `@` search: files and folders under a project root whose path matches what the
// user typed. A git checkout lists its tracked and untracked, not ignored, files with
// `git ls-files`; any other folder falls back to `fd`, which honours `.gitignore` files and skips
// hidden ones. Folders are the parents of the listed files.
//
// Drawn from github.com/pingdotgg/t3code, apps/server/src/workspace/WorkspaceEntries.ts (the
// `git ls-files --cached --others --exclude-standard` listing and the folder entries derived from
// file paths) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Changed: no persistent search index;
// each search lists afresh and ranks with a small fixed order (exact name, name prefix, name
// substring, path substring, then in-order letters), capped at 80 results.
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

import type {
  SearchEntriesResult,
  SearchEntry,
} from "@cairn/protocol/Projects";
import { NodeServices } from "@effect/platform-node";
import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Git, GIT_DEFAULTS } from "../git/Git.ts";
import { Worktrees } from "./Worktrees.ts";

/** The most results one search returns, whatever the request asks for. */
export const MAX_SEARCH_RESULTS = 80;

/** The most files one listing reads; a larger tree is searched in its first files only. */
const MAX_LISTED_FILES = 50_000;

const LIST_TIMEOUT = Duration.seconds(10);

/** Listing a project's files failed. */
export class FileSearchError extends Schema.TaggedError<FileSearchError>()(
  "FileSearchError",
  {
    message: Schema.String,
    root: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** One candidate with its rank; a lower rank sorts first. */
interface Ranked {
  readonly entry: SearchEntry;
  readonly rank: number;
}

const baseName = (entryPath: string) =>
  entryPath.slice(entryPath.lastIndexOf("/") + 1);

const isSubsequence = (needle: string, haystack: string) => {
  let index = 0;

  for (const char of haystack) {
    if (char === needle.charAt(index)) {
      index += 1;

      if (index === needle.length) {
        return true;
      }
    }
  }

  return needle.length === 0;
};

/** How well `entryPath` matches `query` (lowercase): 0 is best; none when it does not match. */
export const matchRank = (
  entryPath: string,
  query: string
): Option.Option<number> => {
  const lowerPath = entryPath.toLowerCase();
  const name = baseName(lowerPath);

  if (query === "") {
    return Option.some(0);
  }

  if (name === query) {
    return Option.some(0);
  }

  if (name.startsWith(query)) {
    return Option.some(1);
  }

  if (name.includes(query)) {
    return Option.some(2);
  }

  if (lowerPath.includes(query)) {
    return Option.some(3);
  }

  return isSubsequence(query, lowerPath) ? Option.some(4) : Option.none();
};

/** Every file in `files` and every folder above one, as search entries. */
export const entriesOf = (
  files: ReadonlyArray<string>
): ReadonlyArray<SearchEntry> => {
  const directories = new Set<string>();

  for (const file of files) {
    let end = file.lastIndexOf("/");

    while (end > 0) {
      const directory = file.slice(0, end);

      if (directories.has(directory)) {
        break;
      }

      directories.add(directory);
      end = directory.lastIndexOf("/");
    }
  }

  return [
    ...[...directories].map((entryPath): SearchEntry => ({
      path: entryPath,
      kind: "directory",
    })),
    ...files.map((entryPath): SearchEntry => ({
      path: entryPath,
      kind: "file",
    })),
  ];
};

/** Ranks `entries` against `query` and keeps the best `limit`, shortest paths first within a rank. */
export const rankEntries = (
  entries: ReadonlyArray<SearchEntry>,
  query: string,
  limit: number
): SearchEntriesResult => {
  const needle = query.trim().toLowerCase();
  const ranked: Array<Ranked> = [];

  for (const entry of entries) {
    const rank = matchRank(entry.path, needle);

    if (Option.isSome(rank)) {
      ranked.push({ entry, rank: rank.value });
    }
  }

  ranked.sort(
    (left, right) =>
      left.rank - right.rank ||
      left.entry.path.length - right.entry.path.length ||
      left.entry.path.localeCompare(right.entry.path)
  );

  return {
    entries: ranked.slice(0, limit).map((item) => item.entry),
    truncated: ranked.length > limit,
  };
};

const failure = (root: string) => (cause: { readonly message: string }) =>
  new FileSearchError({
    message: `FileSearch could not list the files under ${root}: ${cause.message}. Check that the folder exists.`,
    root,
    cause,
  });

const split = (out: string) =>
  out
    .split("\0")
    .filter((entry) => entry !== "")
    .slice(0, MAX_LISTED_FILES);

/** Searches a project's files for the composer's `@` completion. */
export class FileSearch extends Context.Service<
  FileSearch,
  {
    /**
     * Files and folders under `root` matching `query`, at most `min(limit, 80)`, paths relative to
     * the root. Fails with `FileSearchError` when neither git nor fd can list the folder.
     */
    search(
      root: string,
      query: string,
      limit: number
    ): Effect.Effect<SearchEntriesResult, FileSearchError>;
  }
>()("cairn/server/projects/FileSearch") {
  /** Over the ambient `Git`, `Worktrees` and `ChildProcessSpawner`. */
  static readonly layerNoDeps = Layer.effect(
    FileSearch,
    Effect.gen(function* () {
      const git = yield* Git;
      const worktrees = yield* Worktrees;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const gitFiles = (root: string) =>
        git
          .stdoutWith(
            "FileSearch.search",
            root,
            [
              "ls-files",
              "--cached",
              "--others",
              "--exclude-standard",
              "--deduplicate",
              "-z",
            ],
            { ...GIT_DEFAULTS, timeout: LIST_TIMEOUT }
          )
          .pipe(Effect.map(split), Effect.mapError(failure(root)));

      const fdFiles = (root: string) =>
        spawner
          .spawn(
            ChildProcess.make(
              "fd",
              [
                "--type",
                "f",
                "--print0",
                "--max-results",
                String(MAX_LISTED_FILES),
                "--base-directory",
                root,
              ],
              { stdin: "ignore" }
            )
          )
          .pipe(
            Effect.flatMap((handle) =>
              Stream.mkString(Stream.decodeText(handle.stdout))
            ),
            Effect.scoped,
            Effect.timeout(LIST_TIMEOUT),
            Effect.map((out) =>
              split(out).map((file) => file.replace(/^\.\//u, ""))
            ),
            Effect.mapError(failure(root))
          );

      const search = Effect.fn("FileSearch.search")(function* (
        root: string,
        query: string,
        limit: number
      ) {
        const files = (yield* worktrees.isRepository(root))
          ? yield* gitFiles(root)
          : yield* fdFiles(root);

        return rankEntries(
          entriesOf(files),
          query,
          Math.min(limit, MAX_SEARCH_RESULTS)
        );
      });

      return FileSearch.of({ search });
    })
  );

  /** With Node's process spawner; needs `Git` and `Worktrees`. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(NodeServices.layer)
  );
}
