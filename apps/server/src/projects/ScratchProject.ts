// Ported from github.com/pingdotgg/t3code, apps/server/src/project/ManagedProjectFolders.ts
// (`folderWords`, `claimFreeFolder`, `ensureScratchProject`, `folderForThread`) at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the hidden "No project" project rooted at
// `<data>/scratch`, created on first need and reused when a racing creator won; one folder per
// thread named `<YYYY-MM-DD>-<first five words>-<id suffix>`, claimed by a non-recursive mkdir so two
// racers never share one (fallbacks: the full id, then a random suffix). Changed: the project is
// registered through the shell store with a fixed command id, so concurrent callers collapse onto
// one receipt, and a fresh id only when the user deleted the first; no icon; no named projects;
// no `git init` (scratch threads get no per-turn diff); no work-tree probe, because the data folder
// lives under `~/.local/share` and never inside a checkout.
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

import { CommandId, ProjectId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { ProjectShell } from "@cairn/protocol/Shell";
import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Random,
  Schema,
} from "effect";

import { ServerConfig } from "../Config.ts";
import { EventSink } from "../shell/EventSink.ts";
import { ProjectRegister } from "../shell/ShellCommands.ts";
import { Projects } from "./Projects.ts";

/** The title the scratch project carries; the sidebar shows its threads as "no project". */
export const SCRATCH_PROJECT_TITLE = "No project";

/** The command that registers the first scratch project. Every caller sends this one id. */
export const SCRATCH_COMMAND_ID = CommandId.make(
  "019a0000-0000-7000-8000-000005c7a7c0"
);

/** The id of the first scratch project. */
export const SCRATCH_PROJECT_ID = ProjectId.make("prj_scratch");

/** The scratch project or a thread's scratch folder could not be made. */
export class ScratchError extends Schema.TaggedError<ScratchError>()(
  "ScratchError",
  {
    message: Schema.String,
    reason: Schema.Literals(["folder", "store"]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** Up to five lowercase words of `text`, joined by `-`, at most 48 characters. */
export const folderWords = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0)
    .slice(0, 5)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/u, "");

const folderFailure = (folder: string) => (cause: unknown) =>
  new ScratchError({
    message: `ScratchProject could not create the folder ${folder}. Check the data folder's permissions and free space, then retry.`,
    reason: "folder",
    path: folder,
    cause,
  });

/** The hidden project behind threads that have no project, and their folders. */
export class ScratchProject extends Context.Service<
  ScratchProject,
  {
    /** `<data>/scratch`, the scratch project's root. */
    readonly root: string;
    /**
     * The live scratch project, registered on first need. Concurrent callers get the same one.
     * Fails with `ScratchError` when its folder or its row cannot be made.
     */
    readonly ensure: Effect.Effect<ProjectShell, ScratchError>;
    /**
     * Claims a new folder under the scratch root for a thread, named from the date, the first words
     * of `text` and the thread id. Racing threads never get the same folder.
     */
    folderForThread(
      threadId: ThreadId,
      text: string
    ): Effect.Effect<string, ScratchError>;
    /**
     * Removes a folder `folderForThread` claimed for a thread that never came to be. Only a folder
     * directly under the scratch root is removed; any other path, or one already gone, is left.
     */
    releaseFolder(folder: string): Effect.Effect<void, ScratchError>;
  }
>()("cairn/server/projects/ScratchProject") {
  /** Needs `ServerConfig`, `FileSystem`, `Projects` and `EventSink`. */
  static readonly layerNoDeps = Layer.effect(
    ScratchProject,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const projects = yield* Projects;
      const sink = yield* EventSink;
      const root = path.join(config.dataDir, "scratch");

      const storeFailure = (cause: unknown) =>
        new ScratchError({
          message:
            "ScratchProject could not read or register the scratch project in cairn.sqlite. Retry; if it keeps failing, check the brain's log.",
          reason: "store",
          path: root,
          cause,
        });

      const makeRoot = fs
        .makeDirectory(root, { recursive: true })
        .pipe(Effect.mapError(folderFailure(root)));

      const active = projects
        .activeByWorkspaceRoot(root)
        .pipe(Effect.mapError(storeFailure));

      const register = Effect.fnUntraced(function* (first: boolean) {
        const commandId = first
          ? SCRATCH_COMMAND_ID
          : yield* sink.mintCommandId;

        const projectId = first
          ? SCRATCH_PROJECT_ID
          : ProjectId.make(`prj_scratch_${commandId.replaceAll("-", "")}`);

        // A refusal means another caller registered a scratch project first (or the fixed command
        // was answered before); the caller looks the live one up again either way.
        yield* sink
          .commitCommand(
            ProjectRegister.make({
              commandId,
              projectId,
              kind: "scratch",
              title: SCRATCH_PROJECT_TITLE,
              workspaceRoot: root,
              repository: Option.none(),
            })
          )
          .pipe(
            Effect.catchTags({
              ProjectWorkspaceConflictError: () => Effect.void,
              ShellCommandConflict: () => Effect.void,
              ShellCommandInvalid: (failure) =>
                Effect.fail(storeFailure(failure)),
              ShellTargetNotFound: (failure) =>
                Effect.fail(storeFailure(failure)),
              ShellStoreError: (failure) => Effect.fail(storeFailure(failure)),
            })
          );
      });

      const ensure = Effect.gen(function* () {
        yield* makeRoot;

        // The first attempt sends the fixed command; a deleted scratch project has spent it, so a
        // second attempt registers a fresh one.
        for (const first of [true, false, false]) {
          const found = yield* active;

          if (Option.isSome(found)) {
            return found.value.shell;
          }

          yield* register(first);
        }

        const found = yield* active;

        if (Option.isSome(found)) {
          return found.value.shell;
        }

        return yield* storeFailure(
          "no live scratch project after three registrations"
        );
      }).pipe(Effect.withSpan("ScratchProject.ensure"));

      const claim = (folder: string) =>
        fs.makeDirectory(folder).pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) => Predicate.isTagged(error.reason, "AlreadyExists"),
            () => Effect.succeed(false)
          ),
          Effect.mapError(folderFailure(folder))
        );

      const folderForThread = Effect.fn("ScratchProject.folderForThread")(
        function* (threadId: ThreadId, text: string) {
          yield* makeRoot;

          const date = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
          const words = folderWords(text);
          const id = threadId.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");

          const folderFor = (idPart: string) =>
            path.join(
              root,
              [date, words, idPart].filter((part) => part !== "").join("-")
            );

          const fullFolder = folderFor(id);

          for (const candidate of [folderFor(id.slice(-8)), fullFolder]) {
            if (yield* claim(candidate)) {
              return candidate;
            }
          }

          for (let attempt = 0; attempt < 100; attempt += 1) {
            const suffix = (yield* Random.nextIntBetween(0, 0xff_ff_ff))
              .toString(16)
              .padStart(6, "0");

            const candidate = `${fullFolder}-${suffix}`;

            if (yield* claim(candidate)) {
              return candidate;
            }
          }

          return yield* folderFailure(fullFolder)(
            "every candidate folder name was taken"
          );
        }
      );

      const releaseFolder = Effect.fn("ScratchProject.releaseFolder")(
        function* (folder: string) {
          const resolved = path.resolve(folder);

          if (path.dirname(resolved) !== path.resolve(root)) {
            return;
          }

          yield* fs
            .remove(resolved, { recursive: true, force: true })
            .pipe(Effect.mapError(folderFailure(resolved)));
        }
      );

      return ScratchProject.of({
        root,
        ensure,
        folderForThread,
        releaseFolder,
      });
    })
  );
}
