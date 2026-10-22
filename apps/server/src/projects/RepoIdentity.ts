// Ported from cairn-v1, apps/server/src/RepoIdentity.ts at 1a5cd4a, itself ported from
// github.com/pingdotgg/t3code at 5307c233b1f0ae72b8894dd39d94019aaf9e7cb8 (packages/shared/src/git.ts
// `parseGitConfigValue` and the section parsing of `parseOriginUrlFromGitConfig`;
// packages/source-control-github/src/server/gitHubRepositoryResolution.ts, the remote order of
// `selectGitHubBaseRepository`). Kept: a checkout's GitHub repo is read from its git config as a
// file, so git never runs in the checkout and none of its hooks or `core.*` settings run; the
// remote order (a `gh-resolved` mark, then `origin`, then `upstream`); only github.com HTTPS and
// SSH URLs and `github-*` SSH aliases count. Changed: Effect's file system instead of Node's
// promises, `Option` instead of null, and the identity is the `owner/name` string the shell's
// `ProjectShell.repository` carries.
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
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Option } from "effect";

/** The most of any one git file read: a config larger than this is not a checkout's. */
const MAX_FILE_BYTES = 256 * 1024;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;

const REPO = /^[A-Za-z0-9._-]{1,100}$/u;

/** One `[remote "<name>"]` section: its first `url` and its `gh-resolved` mark. */
export interface Remote {
  readonly url: Option.Option<string>;
  readonly ghResolved: Option.Option<string>;
}

/** Whether a folder is a git checkout, and the GitHub repo (`owner/name`) its remotes name. */
export interface RepoInfo {
  readonly isRepo: boolean;
  readonly identity: Option.Option<string>;
}

const parseGitConfigValue = (raw: string) => {
  let out = "";
  let quoted = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw.charAt(index);

    if (char === "\\" && index + 1 < raw.length) {
      out += raw.charAt(index + 1);
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === "#" || char === ";")) {
      break;
    } else {
      out += char;
    }
  }

  return out.trim();
};

const remoteHeader =
  /^\[\s*remote(?:\s+"(?<quoted>[^"]+)"|\.(?<dotted>[^\]\s]+))\s*\](?:\s*[#;].*)?$/iu;

const remoteKey = /^(?<key>url|gh-resolved)\s*=\s*(?<value>.*)$/iu;

/** `remote` with one `url` or `gh-resolved` line applied; other lines leave it as it is. */
const withKey = (remote: Remote, line: string): Remote => {
  const match = remoteKey.exec(line)?.groups;
  const value = parseGitConfigValue(match?.value ?? "");

  if (match === undefined || value.length === 0) {
    return remote;
  }

  return match.key?.toLowerCase() === "url"
    ? { ...remote, url: Option.orElse(remote.url, () => Option.some(value)) }
    : { ...remote, ghResolved: Option.some(value) };
};

/** Each remote section's first `url` and its `gh-resolved`, in file order. Anything else is ignored. */
export const parseRemotes = (
  configText: string
): ReadonlyMap<string, Remote> => {
  const remotes = new Map<string, Remote>();
  let section = Option.none<string>();
  // A trailing backslash continues the value on the next line.
  const joined = configText.replaceAll(/\\\r?\n[ \t]*/gu, "");

  for (const rawLine of joined.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const header = remoteHeader.exec(line)?.groups;

    if (header !== undefined) {
      // Git keeps quoted subsections case-sensitive but folds the dotted form to lowercase.
      section = Option.fromNullishOr(
        header.quoted ?? header.dotted?.toLowerCase()
      );

      if (Option.isSome(section) && !remotes.has(section.value)) {
        remotes.set(section.value, {
          url: Option.none(),
          ghResolved: Option.none(),
        });
      }
    } else if (line.startsWith("[")) {
      section = Option.none();
    } else if (Option.isSome(section)) {
      const remote = remotes.get(section.value);

      if (remote !== undefined) {
        remotes.set(section.value, withKey(remote, line));
      }
    }
  }

  return remotes;
};

/** `owner/name` with GitHub's rules, lowercased (GitHub's names are case-insensitive). */
const ownerRepo = (repoPath: string): Option.Option<string> => {
  const parts = repoPath
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "")
    .split("/");

  const [owner, repo] = parts;

  if (
    parts.length !== 2 ||
    owner === undefined ||
    repo === undefined ||
    !OWNER.test(owner) ||
    !REPO.test(repo) ||
    repo === "." ||
    repo === ".."
  ) {
    return Option.none();
  }

  return Option.some(`${owner.toLowerCase()}/${repo.toLowerCase()}`);
};

/**
 * An SSH host that stands for github.com: `github.com` itself, or an `~/.ssh/config` alias of the
 * form `github-*` or `github.com-*`. Any other alias may point anywhere, so it names no repo.
 */
const isGitHubSshHost = (host: string) => {
  const lower = host.toLowerCase();

  return (
    lower === "github.com" || /^github(?:\.com)?-[a-z0-9._-]+$/u.test(lower)
  );
};

const scpRemote =
  /^(?:[A-Za-z0-9._-]+@)?(?<host>[A-Za-z0-9._-]+):(?!\/)(?<repo>\S+)$/u;

/** The GitHub repo a remote URL names (github.com over HTTPS or SSH, URL or scp form), or none. */
export const gitHubRepoOfUrl = (url: string): Option.Option<string> => {
  const trimmed = url.trim();

  if (/^(?:https|ssh):\/\//iu.test(trimmed)) {
    const parsed = URL.parse(trimmed);

    if (
      parsed === null ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      (parsed.protocol === "https:"
        ? parsed.hostname.toLowerCase() !== "github.com" || parsed.port !== ""
        : !isGitHubSshHost(parsed.hostname))
    ) {
      return Option.none();
    }

    return ownerRepo(parsed.pathname.replace(/^\/+/u, ""));
  }

  // scp form: `[user@]host:owner/repo(.git)`. A `:` after a `/` would make it a local path to git.
  const scp = scpRemote.exec(trimmed)?.groups;
  const host = scp?.host;
  const repo = scp?.repo;

  return host !== undefined && repo !== undefined && isGitHubSshHost(host)
    ? ownerRepo(repo)
    : Option.none();
};

/**
 * The checkout's repo, in t3code's order: the one remote marked `gh-resolved` (`base` takes that
 * remote's own repo, an `owner/repo` value names one), then `origin`, then `upstream`. None when no
 * remote names a GitHub repo, or more than one remote is marked (gh would ask).
 */
export const selectIdentity = (
  remotes: ReadonlyMap<string, Remote>
): Option.Option<string> => {
  const marked = [...remotes.values()].filter((remote) =>
    Option.isSome(remote.ghResolved)
  );

  if (marked.length > 1) {
    return Option.none();
  }

  const fromMark = Option.flatMap(Option.fromNullishOr(marked[0]), (remote) =>
    Option.flatMap(remote.ghResolved, (mark) =>
      mark === "base"
        ? Option.flatMap(remote.url, gitHubRepoOfUrl)
        : ownerRepo(mark)
    )
  );

  return fromMark.pipe(
    Option.orElse(() =>
      Option.flatMap(
        Option.flatMap(
          Option.fromNullishOr(remotes.get("origin")),
          (remote) => remote.url
        ),
        gitHubRepoOfUrl
      )
    ),
    Option.orElse(() =>
      Option.flatMap(
        Option.flatMap(
          Option.fromNullishOr(remotes.get("upstream")),
          (remote) => remote.url
        ),
        gitHubRepoOfUrl
      )
    )
  );
};

/** Reads checkouts' GitHub identities from their git config files. */
export class RepoIdentity extends Context.Service<
  RepoIdentity,
  {
    /**
     * Whether `checkout` is a git checkout (it has a `.git` folder or file), and the GitHub repo
     * its remotes name. A worktree's or submodule's `.git` file is followed to the shared config.
     * Never fails: an unreadable file reads as no identity.
     */
    read(checkout: string): Effect.Effect<RepoInfo>;
  }
>()("cairn/server/projects/RepoIdentity") {
  /** Reads through the ambient `FileSystem`. */
  static readonly layerNoDeps = Layer.effect(
    RepoIdentity,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      // At most MAX_FILE_BYTES of a regular file. A symlink, a FIFO or a device reads as none, so a
      // FIFO named `config` never blocks the read.
      const readSmall = Effect.fnUntraced(function* (file: string) {
        const isLink = yield* fs.readLink(file).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        );

        if (isLink) {
          return Option.none<string>();
        }

        const info = yield* fs.stat(file).pipe(Effect.option);

        if (
          Option.isNone(info) ||
          info.value.type !== "File" ||
          Number(info.value.size) > MAX_FILE_BYTES
        ) {
          return Option.none<string>();
        }

        return yield* fs.readFileString(file).pipe(Effect.option);
      });

      // The git directory whose `config` holds the checkout's remotes: `.git` itself, or for a
      // `.git` file (a worktree or a submodule) the `gitdir:` it names, then its `commondir`.
      const configPathOf = Effect.fnUntraced(function* (checkout: string) {
        const dotGit = path.join(checkout, ".git");
        const info = yield* fs.stat(dotGit).pipe(Effect.option);

        if (Option.isNone(info)) {
          return Option.none<string>();
        }

        if (info.value.type === "Directory") {
          return Option.some(path.join(dotGit, "config"));
        }

        if (info.value.type !== "File") {
          return Option.none<string>();
        }

        const named = Option.flatMap(yield* readSmall(dotGit), (text) =>
          Option.fromNullishOr(
            /^gitdir:\s*(?<dir>.+?)\s*$/mu.exec(text)?.groups?.dir
          )
        );

        if (Option.isNone(named)) {
          return Option.none<string>();
        }

        const gitDir = path.resolve(checkout, named.value);

        const common = Option.filter(
          Option.map(yield* readSmall(path.join(gitDir, "commondir")), (text) =>
            text.trim()
          ),
          (text) => text !== ""
        );

        const commonDir = Option.match(common, {
          onNone: () => gitDir,
          onSome: (dir) => path.resolve(gitDir, dir),
        });

        return Option.some(path.join(commonDir, "config"));
      });

      const read = Effect.fn("RepoIdentity.read")(function* (checkout: string) {
        const configPath = yield* configPathOf(checkout);

        if (Option.isNone(configPath)) {
          const exists = yield* fs
            .exists(path.join(checkout, ".git"))
            .pipe(Effect.orElseSucceed(() => false));

          return { isRepo: exists, identity: Option.none<string>() };
        }

        const text = yield* readSmall(configPath.value);

        return {
          isRepo: true,
          identity: Option.flatMap(text, (config) =>
            selectIdentity(parseRemotes(config))
          ),
        };
      });

      return RepoIdentity.of({ read });
    })
  );

  /** Reads through Node's file system. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(NodeServices.layer)
  );
}
