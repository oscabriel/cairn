// Git's errors carry the end of its stderr into logs and into a thread's `lastError`; a remote URL
// in that text keeps its host and path but never the credential it may embed.
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { Git, redactUrls } from "./Git.ts";

describe("git errors", () => {
  it("hide the user info of every URL", () => {
    assert.strictEqual(
      redactUrls(
        "fatal: unable to access 'https://oscar:ghp_secret@github.com/o/r.git/': 403\n" +
          "fatal: could not read from ssh://git@host:22/r and http://plain.example/x"
      ),
      "fatal: unable to access 'https://***@github.com/o/r.git/': 403\n" +
        "fatal: could not read from ssh://***@host:22/r and http://plain.example/x"
    );
  });

  it.live("do not repeat a credential a failed fetch printed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* Git;
      const dir = yield* fs.makeTempDirectoryScoped();

      yield* git.stdout("test", dir, ["init", "--quiet"]);

      const failure = yield* Effect.flip(
        git.stdout("test", dir, [
          "ls-remote",
          "https://someone:hunter2token@127.0.0.1:9/none.git",
        ])
      );

      assert.notInclude(failure.message, "hunter2token");
      assert.notInclude(failure.stderr, "hunter2token");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Git.layerNoDeps.pipe(Layer.provideMerge(NodeServices.layer))
      )
    )
  );
});
