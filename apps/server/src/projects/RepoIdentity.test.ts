// Cases ported from cairn-v1, apps/server/test/projects.test.ts ("remote URLs", "choosing the
// remote", "reading a checkout") at 1a5cd4a.
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";

import {
  gitHubRepoOfUrl,
  parseRemotes,
  RepoIdentity,
  selectIdentity,
} from "./RepoIdentity.ts";

const identityOf = (config: string) => selectIdentity(parseRemotes(config));

describe("reading a checkout's GitHub repo", () => {
  it("reads github.com over HTTPS and SSH, in every form git takes", () => {
    for (const url of [
      "https://github.com/Oscabriel/Cairn.git",
      "https://github.com/oscabriel/cairn",
      "https://github.com/oscabriel/cairn/",
      "https://user@github.com/oscabriel/cairn.git",
      "git@github.com:oscabriel/cairn.git",
      "github.com:oscabriel/cairn",
      "ssh://git@github.com/oscabriel/cairn.git",
    ]) {
      assert.deepStrictEqual(
        gitHubRepoOfUrl(url),
        Option.some("oscabriel/cairn"),
        url
      );
    }
  });

  it("takes SSH host aliases only of the form github-* or github.com-*", () => {
    assert.deepStrictEqual(
      gitHubRepoOfUrl("git@github-work:acme/api.git"),
      Option.some("acme/api")
    );
    assert.deepStrictEqual(
      gitHubRepoOfUrl("git@github.com-work:acme/api.git"),
      Option.some("acme/api")
    );
    assert.deepStrictEqual(
      gitHubRepoOfUrl("ssh://git@github-work/acme/api"),
      Option.some("acme/api")
    );
    assert.isTrue(Option.isNone(gitHubRepoOfUrl("git@work:acme/api.git")));
    assert.isTrue(Option.isNone(gitHubRepoOfUrl("git@mygithub:acme/api.git")));
    assert.isTrue(
      Option.isNone(gitHubRepoOfUrl("https://github-work/acme/api"))
    );
  });

  it("names no repo for other hosts, paths, or a malformed URL", () => {
    for (const url of [
      "https://gitlab.com/acme/api.git",
      "https://github.com.evil.example/acme/api",
      "https://github.com:8443/acme/api",
      "http://github.com/acme/api",
      "git://github.com/acme/api",
      "https://github.com/acme/api/tree/main",
      "https://github.com/acme",
      "https://github.com/acme/api?x=1",
      "/home/u/src/api",
      "file:///home/u/src/api",
      "git@github.com:/acme/api",
      "git@github.com:acme/..",
      "git@github.com:-acme/api",
      "",
    ]) {
      assert.isTrue(Option.isNone(gitHubRepoOfUrl(url)), url);
    }
  });

  it("takes a gh-resolved mark, then origin, then upstream", () => {
    const config = `[core]
	bare = false
[remote "upstream"]
	url = https://github.com/up/stream.git
[remote "origin"]
	url = git@github.com:me/fork.git
	fetch = +refs/heads/*:refs/remotes/origin/*
`;

    assert.deepStrictEqual(identityOf(config), Option.some("me/fork"));
    assert.deepStrictEqual(
      identityOf(`${config}[remote "upstream"]\n\tgh-resolved = base\n`),
      Option.some("up/stream")
    );
    assert.deepStrictEqual(
      identityOf(`${config}[remote "origin"]\n\tgh-resolved = other/named\n`),
      Option.some("other/named")
    );
    assert.deepStrictEqual(
      identityOf(
        `[remote "origin"]\n\turl = https://gitlab.com/me/x\n[remote "upstream"]\n\turl = https://github.com/up/stream\n`
      ),
      Option.some("up/stream")
    );
    assert.isTrue(
      Option.isNone(
        identityOf(
          `${config}[remote "origin"]\n\tgh-resolved = base\n[remote "upstream"]\n\tgh-resolved = base\n`
        )
      )
    );
    assert.isTrue(
      Option.isNone(
        identityOf(`[remote "github"]\n\turl = https://github.com/a/b\n`)
      )
    );
  });

  it("reads the legacy [remote.name] form, quotes, comments and continued lines", () => {
    const remotes = parseRemotes(
      `; a comment\n[Remote.ORIGIN] # folded to lowercase\n\tURL = "https://github.com/a/b.git" ; trailing\n[remote "x"]\n\turl = https://github.com/\\\n  c/d\n`
    );

    assert.deepStrictEqual(
      remotes.get("origin")?.url,
      Option.some("https://github.com/a/b.git")
    );
    assert.deepStrictEqual(
      remotes.get("x")?.url,
      Option.some("https://github.com/c/d")
    );
  });

  it.live(
    "reads a checkout's config as a file, following a worktree's .git file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repos = yield* RepoIdentity;
        const dir = yield* fs.makeTempDirectoryScoped();
        const main = path.join(dir, "main");

        yield* fs.makeDirectory(path.join(main, ".git", "worktrees", "wt"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(main, ".git", "config"),
          `[core]\n\tfsmonitor = touch ${dir}/ran\n[remote "origin"\n\turl = https://github.com/broken/header\n[remote "origin"]\n\turl = https://github.com/real/one\n\turl = https://github.com/second/url\n`
        );
        yield* fs.writeFileString(
          path.join(main, ".git", "worktrees", "wt", "commondir"),
          "../..\n"
        );

        const wt = path.join(dir, "wt");

        yield* fs.makeDirectory(wt);
        yield* fs.writeFileString(
          path.join(wt, ".git"),
          `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`
        );

        assert.deepStrictEqual(yield* repos.read(main), {
          isRepo: true,
          identity: Option.some("real/one"),
        });
        assert.deepStrictEqual(yield* repos.read(wt), {
          isRepo: true,
          identity: Option.some("real/one"),
        });
        assert.isFalse(yield* fs.exists(path.join(dir, "ran")));
        assert.deepStrictEqual(yield* repos.read(dir), {
          isRepo: false,
          identity: Option.none(),
        });

        const huge = path.join(dir, "huge");

        yield* fs.makeDirectory(path.join(huge, ".git"), { recursive: true });
        yield* fs.writeFileString(
          path.join(huge, ".git", "config"),
          `[remote "origin"]\n\turl = https://github.com/a/b\n${"#".repeat(300_000)}\n`
        );

        assert.deepStrictEqual(yield* repos.read(huge), {
          isRepo: true,
          identity: Option.none(),
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(RepoIdentity.layer, NodeServices.layer))
      )
  );
});
