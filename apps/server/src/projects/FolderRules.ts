// Ported from cairn-v1, apps/server/src/Projects.ts (`FolderRules`, `refusal`, `addRefusal`,
// `checkFolder`, `browseFolder`, lines 170 to 290) at 1a5cd4a. Kept: only folders under the real
// home directory; no dot-folder or anything inside one; nothing that is, sits inside or holds one
// of Cairn's own or a login's folders; the lexical path is checked before links resolve; a link is
// listed at its target and only when the target is allowed; at most 500 entries, repo checks 16 at
// a time. Changed: Effect's file system, typed refusals, the wire `BrowseResult`, and the deny list
// gains `~/.codex`, `~/.alchemy` and the rootless Docker data folder that holds Executor's volume.
import os from "node:os";
import path from "node:path";

import type { BrowseEntry, BrowseResult } from "@cairn/protocol/Projects";
import { NodeServices } from "@effect/platform-node";
import {
  Array as Arr,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Schema,
} from "effect";

import { ServerConfig } from "../Config.ts";
import { RepoIdentity } from "./RepoIdentity.ts";

/** The most child folders one listing returns. */
export const MAX_BROWSE_ENTRIES = 500;

/** Which folders may be listed and which may be projects. Every path is a real path. */
export interface FolderRulesConfig {
  /** The user's home directory; nothing outside it is listed. */
  readonly home: string;
  /** Folders no project may be, be inside or hold: Cairn's own and those holding logins. */
  readonly deny: ReadonlyArray<string>;
}

/** What a folder is checked for: listing in the picker, or becoming a project root. */
export type FolderPurpose = "list" | "add";

/** A folder may not be listed or added. The message says why and what to pick instead. */
export class FolderRefused extends Schema.TaggedError<FolderRefused>()(
  "FolderRefused",
  {
    message: Schema.String,
    path: Schema.String,
    reason: Schema.Literals([
      "not_absolute",
      "missing",
      "not_folder",
      "outside_home",
      "dot_folder",
      "denied",
      "home_itself",
      "holds_denied",
    ]),
  }
) {}

const within = (child: string, dir: string) =>
  child === dir || child.startsWith(`${dir}/`);

/** Why a real path may not be listed, or none when it may. */
export const refusal = (
  real: string,
  rules: FolderRulesConfig
): Option.Option<FolderRefused> => {
  if (!within(real, rules.home)) {
    return Option.some(
      new FolderRefused({
        message: `${real} is outside the home directory. Pick a folder under ${rules.home}.`,
        path: real,
        reason: "outside_home",
      })
    );
  }

  if (
    path
      .relative(rules.home, real)
      .split("/")
      .some((part) => part.startsWith("."))
  ) {
    return Option.some(
      new FolderRefused({
        message: `${real} is a dot-folder or inside one. Pick a folder that is not hidden.`,
        path: real,
        reason: "dot_folder",
      })
    );
  }

  return Option.map(
    Option.fromNullishOr(rules.deny.find((dir) => within(real, dir))),
    (denied) =>
      new FolderRefused({
        message: `${real} is inside ${denied}, which holds Cairn's own data or a login. Pick another folder.`,
        path: real,
        reason: "denied",
      })
  );
};

/** Why a real path may not be a project root, or none when it may. */
export const addRefusal = (
  real: string,
  rules: FolderRulesConfig
): Option.Option<FolderRefused> =>
  refusal(real, rules).pipe(
    Option.orElse(() =>
      real === rules.home
        ? Option.some(
            new FolderRefused({
              message:
                "The home directory itself cannot be a project. Pick a folder inside it.",
              path: real,
              reason: "home_itself",
            })
          )
        : Option.map(
            Option.fromNullishOr(rules.deny.find((dir) => within(dir, real))),
            (held) =>
              new FolderRefused({
                message: `${real} holds ${held}, which keeps Cairn's own data or a login; a thread there could reach it. Pick a folder inside it instead.`,
                path: real,
                reason: "holds_denied",
              })
          )
    )
  );

const expandHome = (input: string, home: string) => {
  if (input === "~") {
    return home;
  }

  return input.startsWith("~/") ? path.join(home, input.slice(2)) : input;
};

const byName = Order.mapInput(
  Order.String,
  (entry: { readonly name: string }) => entry.name
);

/** Decides which folders the picker lists and which may become projects. */
export class FolderRules extends Context.Service<
  FolderRules,
  {
    readonly config: FolderRulesConfig;
    /**
     * The real path of `input` (absolute, or `~`-relative) when it is an existing folder allowed
     * for `purpose`; otherwise `FolderRefused` saying why.
     */
    check(
      input: string,
      purpose: FolderPurpose
    ): Effect.Effect<string, FolderRefused>;
    /**
     * The allowed child folders of `input` (the home directory when none), each marked when it is
     * a git checkout. Files are never listed. Fails with `FolderRefused` when the folder may not be
     * listed.
     */
    browse(
      input: Option.Option<string>
    ): Effect.Effect<BrowseResult, FolderRefused>;
  }
>()("cairn/server/projects/FolderRules") {
  /** The rules in `config`, over the ambient `FileSystem` and `RepoIdentity`. */
  static readonly layerWith = (config: FolderRulesConfig) =>
    Layer.effect(
      FolderRules,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repos = yield* RepoIdentity;

        const realPath = (target: string) =>
          fs.realPath(target).pipe(Effect.option);

        const isFolder = (target: string) =>
          fs.stat(target).pipe(
            Effect.map((info) => info.type === "Directory"),
            Effect.orElseSucceed(() => false)
          );

        const check = Effect.fn("FolderRules.check")(function* (
          input: string,
          purpose: FolderPurpose
        ) {
          const expanded = expandHome(input.trim(), config.home);

          if (!path.isAbsolute(expanded)) {
            return yield* new FolderRefused({
              message: `${input} is not an absolute path. Give the full path of a folder under ${config.home}.`,
              path: input,
              reason: "not_absolute",
            });
          }

          const lexical = path.resolve(expanded);

          if (within(lexical, config.home)) {
            const early = refusal(lexical, config);

            if (Option.isSome(early)) {
              return yield* early.value;
            }
          }

          const real = yield* realPath(lexical);

          if (Option.isNone(real)) {
            return yield* new FolderRefused({
              message: `${lexical} does not exist. Pick an existing folder.`,
              path: lexical,
              reason: "missing",
            });
          }

          if (!(yield* isFolder(real.value))) {
            return yield* new FolderRefused({
              message: `${real.value} is not a folder. Pick a folder.`,
              path: real.value,
              reason: "not_folder",
            });
          }

          const why =
            purpose === "add"
              ? addRefusal(real.value, config)
              : refusal(real.value, config);

          return Option.isSome(why) ? yield* why.value : real.value;
        });

        // A child is listed at its own path when it is a folder, and at its target when it is a
        // link to an allowed folder.
        const childEntry = Effect.fnUntraced(function* (
          dir: string,
          name: string
        ) {
          const full = path.join(dir, name);

          const isLink = yield* fs.readLink(full).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false)
          );

          const target = isLink ? yield* realPath(full) : Option.some(full);

          if (
            Option.isNone(target) ||
            Option.isSome(refusal(target.value, config)) ||
            !(yield* isFolder(target.value))
          ) {
            return Option.none<{ name: string; path: string }>();
          }

          return Option.some({ name, path: target.value });
        });

        const browse = Effect.fn("FolderRules.browse")(function* (
          input: Option.Option<string>
        ) {
          const dir = yield* check(
            Option.getOrElse(input, () => config.home),
            "list"
          );

          const names = yield* fs
            .readDirectory(dir)
            .pipe(Effect.orElseSucceed((): Array<string> => []));

          const visible = Arr.sort(
            names.filter((name) => !name.startsWith(".")),
            Order.String
          );

          const candidates = Arr.getSomes(
            yield* Effect.forEach(visible, (name) => childEntry(dir, name), {
              concurrency: 16,
            })
          ).slice(0, MAX_BROWSE_ENTRIES);

          const entries: Array<BrowseEntry> = yield* Effect.forEach(
            candidates,
            (candidate) =>
              Effect.map(repos.read(candidate.path), (info) => ({
                name: candidate.name,
                path: candidate.path,
                isGitRepo: info.isRepo,
              })),
            { concurrency: 16 }
          );

          return {
            path: dir,
            parent:
              dir === config.home
                ? Option.none<string>()
                : Option.some(path.dirname(dir)),
            entries: Arr.sort(entries, byName),
          };
        });

        return FolderRules.of({ config, check, browse });
      })
    );

  /**
   * The deployed rules: the real home directory, and a deny list of Cairn's data and config
   * folders and the folders that hold logins. Needs `ServerConfig`.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const server = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;

      const real = (target: string) =>
        fs.realPath(target).pipe(Effect.orElseSucceed(() => target));

      const home = yield* real(os.homedir());

      const deny = yield* Effect.forEach(
        [
          server.dataDir,
          server.configDir,
          path.join(home, ".pi"),
          path.join(home, ".ssh"),
          path.join(home, ".claude"),
          path.join(home, ".config"),
          path.join(home, ".codex"),
          path.join(home, ".alchemy"),
          path.join(home, ".local", "share", "cairn"),
          // Rootless Docker keeps Executor's data volume here.
          path.join(home, ".local", "share", "docker"),
        ],
        real
      );

      return FolderRules.layerWith({ home, deny });
    })
  ).pipe(
    Layer.provide(RepoIdentity.layerNoDeps),
    Layer.provide(NodeServices.layer)
  );
}
