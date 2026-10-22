import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";

import { addRefusal, FolderRules, refusal } from "./FolderRules.ts";
import { RepoIdentity } from "./RepoIdentity.ts";

const rules = {
  home: "/home/me",
  deny: ["/home/me/data/cairn", "/home/me/keys"],
};

const reasonOf = (found: Option.Option<{ readonly reason: string }>) =>
  Option.map(found, (failure) => failure.reason);

/**
 * Runs `body` over a temporary home holding: `code/app` (a git checkout), `code/notes`, a file,
 * `.hidden/inner`, the denied `secrets`, `data/cairn` (denied, inside `data`), a link to `code`
 * and a link escaping the home.
 */
const withHome = <A, E>(
  body: (
    home: string,
    outside: string
  ) => Effect.Effect<A, E, FolderRules | FileSystem.FileSystem>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const home = path.join(root, "home");
    const outside = path.join(root, "outside");

    for (const dir of [
      "code/app/.git",
      "code/notes",
      ".hidden/inner",
      "secrets",
      "data/cairn/nested",
    ]) {
      yield* fs.makeDirectory(path.join(home, dir), { recursive: true });
    }

    yield* fs.makeDirectory(outside);
    yield* fs.writeFileString(path.join(home, "code", "readme.md"), "hi");
    yield* fs.symlink(path.join(home, "code"), path.join(home, "code-link"));
    yield* fs.symlink(outside, path.join(home, "escape"));

    return yield* body(home, outside).pipe(
      Effect.provide(
        FolderRules.layerWith({
          home,
          deny: [path.join(home, "secrets"), path.join(home, "data", "cairn")],
        })
      )
    );
  }).pipe(
    Effect.provide(RepoIdentity.layerNoDeps),
    Effect.scoped,
    Effect.provide(NodeServices.layer)
  );

describe("folder rules", () => {
  it("lists folders under the home only, never dot-folders or denied ones", () => {
    assert.isTrue(Option.isNone(refusal("/home/me/code", rules)));
    assert.deepStrictEqual(
      reasonOf(refusal("/etc", rules)),
      Option.some("outside_home")
    );
    assert.deepStrictEqual(
      reasonOf(refusal("/home/meow", rules)),
      Option.some("outside_home")
    );
    assert.deepStrictEqual(
      reasonOf(refusal("/home/me/.ssh", rules)),
      Option.some("dot_folder")
    );
    assert.deepStrictEqual(
      reasonOf(refusal("/home/me/a/.git/x", rules)),
      Option.some("dot_folder")
    );
    assert.deepStrictEqual(
      reasonOf(refusal("/home/me/keys/a", rules)),
      Option.some("denied")
    );
  });

  it("refuses as a project the home itself and any folder holding a denied one", () => {
    assert.isTrue(Option.isNone(refusal("/home/me", rules)));
    assert.deepStrictEqual(
      reasonOf(addRefusal("/home/me", rules)),
      Option.some("home_itself")
    );
    assert.deepStrictEqual(
      reasonOf(addRefusal("/home/me/data", rules)),
      Option.some("holds_denied")
    );
    assert.isTrue(Option.isNone(addRefusal("/home/me/code", rules)));
  });

  it.live("checks real paths: a link escaping the home is refused", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const folders = yield* FolderRules;

        assert.strictEqual(
          yield* folders.check(path.join(home, "code-link", "app"), "add"),
          path.join(home, "code", "app")
        );

        const escaped = yield* Effect.flip(
          folders.check(path.join(home, "escape"), "list")
        );

        assert.strictEqual(escaped.reason, "outside_home");

        const hidden = yield* Effect.flip(
          folders.check(path.join(home, ".hidden", "inner"), "add")
        );

        assert.strictEqual(hidden.reason, "dot_folder");

        const denied = yield* Effect.flip(
          folders.check(path.join(home, "data", "cairn", "nested"), "list")
        );

        assert.strictEqual(denied.reason, "denied");

        const holds = yield* Effect.flip(
          folders.check(path.join(home, "data"), "add")
        );

        assert.strictEqual(holds.reason, "holds_denied");

        const relative = yield* Effect.flip(folders.check("code", "add"));

        assert.strictEqual(relative.reason, "not_absolute");

        const missing = yield* Effect.flip(
          folders.check(path.join(home, "nope"), "add")
        );

        assert.strictEqual(missing.reason, "missing");

        const file = yield* Effect.flip(
          folders.check(path.join(home, "code", "readme.md"), "add")
        );

        assert.strictEqual(file.reason, "not_folder");
      })
    )
  );

  it.live(
    "browses folders only, links at their allowed targets, repos marked",
    () =>
      withHome((home) =>
        Effect.gen(function* () {
          const folders = yield* FolderRules;
          const top = yield* folders.browse(Option.none());

          assert.strictEqual(top.path, home);
          assert.isTrue(Option.isNone(top.parent));
          assert.deepStrictEqual(
            top.entries.map((entry) => [entry.name, entry.path]),
            [
              ["code", path.join(home, "code")],
              ["code-link", path.join(home, "code")],
              ["data", path.join(home, "data")],
            ]
          );

          const code = yield* folders.browse(
            Option.some(path.join(home, "code"))
          );

          assert.deepStrictEqual(code.parent, Option.some(home));
          assert.deepStrictEqual(
            code.entries.map((entry) => [entry.name, entry.isGitRepo]),
            [
              ["app", true],
              ["notes", false],
            ]
          );

          const outside = yield* Effect.flip(
            folders.browse(Option.some("/etc"))
          );

          assert.strictEqual(outside.reason, "outside_home");
        })
      )
  );
});
