import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { Git } from "../git/Git.ts";
import {
  entriesOf,
  FileSearch,
  MAX_SEARCH_RESULTS,
  rankEntries,
} from "./FileSearch.ts";
import { Worktrees } from "./Worktrees.ts";

const TestLayer = FileSearch.layerNoDeps.pipe(
  Layer.provideMerge(Worktrees.layerNoDeps),
  Layer.provideMerge(Git.layerNoDeps),
  Layer.provideMerge(NodeServices.layer)
);

const write = Effect.fn("test.write")(function* (
  root: string,
  files: ReadonlyArray<string>
) {
  const fs = yield* FileSystem.FileSystem;

  for (const file of files) {
    yield* fs.makeDirectory(path.dirname(path.join(root, file)), {
      recursive: true,
    });
    yield* fs.writeFileString(path.join(root, file), "x");
  }
});

describe("searching project files", () => {
  it("derives folders from file paths and ranks name matches first", () => {
    const entries = entriesOf([
      "src/app/Main.ts",
      "src/main.css",
      "docs/domain/notes.md",
    ]);

    assert.deepStrictEqual(
      entries
        .filter((entry) => entry.kind === "directory")
        .map((entry) => entry.path),
      ["src/app", "src", "docs/domain", "docs"]
    );

    const ranked = rankEntries(entries, "main", 10);

    assert.deepStrictEqual(
      ranked.entries.map((entry) => entry.path),
      ["src/main.css", "src/app/Main.ts", "docs/domain", "docs/domain/notes.md"]
    );
    assert.isFalse(ranked.truncated);
    assert.isTrue(rankEntries(entries, "", 2).truncated);
  });

  it.live(
    "lists a checkout with git (ignored files left out) and any folder with fd",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const git = yield* Git;
        const search = yield* FileSearch;
        const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        const repo = path.join(dir, "repo");
        const plain = path.join(dir, "plain");

        yield* git.stdout("test", dir, ["init", "--quiet", "-b", "main", repo]);
        yield* write(repo, [".gitignore", "src/Widget.ts", "build/Widget.js"]);
        yield* fs.writeFileString(path.join(repo, ".gitignore"), "build/\n");

        const inRepo = yield* search.search(repo, "widget", 50);

        assert.deepStrictEqual(
          inRepo.entries.map((entry) => entry.path),
          ["src/Widget.ts"]
        );

        yield* write(plain, ["notes/today.md", "readme.md"]);

        const inFolder = yield* search.search(plain, "today", 50);

        assert.deepStrictEqual(
          inFolder.entries.map((entry) => entry.path),
          ["notes/today.md"]
        );

        yield* write(
          plain,
          Array.from(
            { length: 120 },
            (_, index) => `many/file-${String(index)}.txt`
          )
        );

        const capped = yield* search.search(plain, "file", 200);

        assert.strictEqual(capped.entries.length, MAX_SEARCH_RESULTS);
        assert.isTrue(capped.truncated);
      }).pipe(Effect.scoped, Effect.provide(TestLayer))
  );
});
