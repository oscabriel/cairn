// Ported from cairn-v1, apps/server/src/PiContext.ts at 1a5cd4a (the checks before a context file
// is read: a regular file, one name, a size cap before reading, a real path inside the directory it
// was found in, `O_NOFOLLOW` and the opened file checked again; text the Claude bridge refuses left
// out), and from pi, earendil-works pi@4a080252, packages/coding-agent/src/core/resource-loader.ts
// (`loadProjectContextFiles`: the agent dir's file first, then one file per directory from the
// outermost ancestor in, each directory's first of pi's names) and system-prompt.ts
// (`renderProjectContext` and the `addendum` for `APPEND_SYSTEM.md`). Changed: the ancestor walk
// stops at the workspace's git root (or the cwd itself outside a repo), so nothing above a project
// or a worktree under Cairn's data dir is read; a link is followed only to a markdown file inside
// the directory it was found in; Cairn's credential paths can never be read because no `.md` file
// is one.
//
// MIT License. Copyright (c) 2025 Mario Zechner (pi).
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
//
// The instructions a thread gets from files, as pi would give them to a session in the same cwd:
// `<agentDir>/AGENTS.md` (or pi's other names for it), the workspace's context files, and
// `<agentDir>/APPEND_SYSTEM.md`. Reads are synchronous and done once per run (`RunPins`), so a
// prompt section can render them without a runtime and the text stays fixed within a turn.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { Context, Effect, Layer, Option } from "effect";

import { errorText } from "../brain/Durable.ts";
import { contextFileIn, PiConfig } from "../models/PiConfig.ts";
import { gitRootOf } from "./GitRoot.ts";
import { refusedPhrases } from "./PromptSafety.ts";

/** A context file longer than this is left out: it would crowd the prompt. */
export const MAX_CONTEXT_CHARS = 64_000;

/** The most bytes `MAX_CONTEXT_CHARS` characters take in UTF-8: a bigger file is not read. */
const MAX_CONTEXT_BYTES = MAX_CONTEXT_CHARS * 4;

/** Where a context file was found. */
export type ContextSource = "agent" | "workspace" | "append";

/** One context file a thread would get, and whether it got it. */
export interface ContextFileRow {
  readonly source: ContextSource;
  readonly path: string;
  /** The file's text when it was added; none when it was left out. */
  readonly text: Option.Option<string>;
  /** Why it was left out. */
  readonly reason: Option.Option<string>;
}

/** What a thread in one cwd gets. */
export interface ContextRead {
  readonly files: ReadonlyArray<ContextFileRow>;
  /** pi's `project_context` text over the added agent and workspace files; empty when none. */
  readonly projectContext: string;
  /** `APPEND_SYSTEM.md`'s text, pi's `addendum`; empty when absent or left out. */
  readonly addendum: string;
}

const inside = (file: string, dir: string) => {
  const rel = path.relative(dir, file);

  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

type ReadResult =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "left_out"; readonly reason: string };

const leftOut = (reason: string): ReadResult => ({ kind: "left_out", reason });

/**
 * The file's text, or why it is left out. `root` is the directory its real path must stay in. A
 * link is followed only when it ends at a markdown file inside `root`; a file with two names (a
 * hard link) is never read, since no path check can see what else it is.
 */
export const readContextFile = (file: string, root: string): ReadResult => {
  try {
    const link = lstatSync(file);
    const real = realpathSync(file);
    const realRoot = realpathSync(root);

    if (!inside(real, realRoot)) {
      return leftOut(`its real path ${real} is outside ${realRoot}`);
    }

    if (link.isSymbolicLink() && path.extname(real).toLowerCase() !== ".md") {
      return leftOut("it links to a file that is not markdown");
    }

    const stat = statSync(real);

    if (!stat.isFile()) {
      return leftOut("it is not a regular file");
    }

    if (stat.nlink > 1) {
      return leftOut("it has more than one name (a hard link)");
    }

    if (stat.size > MAX_CONTEXT_BYTES) {
      return leftOut(`it is over ${String(MAX_CONTEXT_CHARS)} characters`);
    }

    // O_NOFOLLOW on the real path, and the opened file checked again: a swap after the checks
    // above is not followed.
    // oxlint-disable-next-line eslint/no-bitwise -- open(2) flags are a bit set
    const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      const opened = fstatSync(fd);

      if (
        !opened.isFile() ||
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev ||
        opened.nlink > 1
      ) {
        return leftOut("it changed while it was read");
      }

      return {
        kind: "text",
        text: readFileSync(fd, "utf-8").replace(/^﻿/u, ""),
      };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return leftOut(`it could not be read: ${errorText(error)}`);
  }
};

/** Decides one file: read it, then refuse what the bridge refuses, what is too long and what is empty. */
const decide = (
  source: ContextSource,
  file: string,
  root: string
): ContextFileRow => {
  const read = readContextFile(file, root);

  const out = (reason: string): ContextFileRow => ({
    source,
    path: file,
    text: Option.none(),
    reason: Option.some(reason),
  });

  if (read.kind === "left_out") {
    return out(read.reason);
  }

  const refused = refusedPhrases(read.text);

  if (refused.length > 0) {
    return out(
      `it carries text the Claude bridge refuses (${refused.join(", ")})`
    );
  }

  if (read.text.length > MAX_CONTEXT_CHARS) {
    return out(`it is over ${String(MAX_CONTEXT_CHARS)} characters`);
  }

  if (read.text.trim() === "") {
    return out("it is empty");
  }

  return {
    source,
    path: file,
    text: Option.some(read.text),
    reason: Option.none(),
  };
};

/**
 * The directories whose context file a thread in `cwd` reads, outermost first: from the git root
 * down to `cwd`, or `cwd` alone outside a repo.
 */
export const workspaceDirs = (cwd: string): ReadonlyArray<string> => {
  const start = path.resolve(cwd);
  const root = Option.getOrElse(gitRootOf(start), () => start);
  const dirs = [start];
  let dir = start;

  while (dir !== root) {
    dir = path.dirname(dir);
    dirs.unshift(dir);
  }

  return dirs;
};

/** pi's `project_context` text over the added files. */
export const projectContextText = (
  files: ReadonlyArray<ContextFileRow>
): string => {
  const added = files.flatMap((file) =>
    Option.match(file.text, {
      onNone: () => [],
      onSome: (text) => [{ path: file.path, text }],
    })
  );

  if (added.length === 0) {
    return "";
  }

  return [
    "Project-specific instructions and guidelines:",
    ...added.map(
      ({ path: file, text }) =>
        `<project_instructions path="${file}">\n${text}\n</project_instructions>`
    ),
  ].join("\n\n");
};

/** Reads every context file of `cwd`, with `agentDir`'s own files when one is given. */
export const readProjectContext = (
  agentDir: Option.Option<string>,
  cwd: Option.Option<string>
): ContextRead => {
  const agentFile = Option.flatMap(agentDir, (dir) =>
    Option.map(contextFileIn(dir), (file) => ({ dir, file }))
  );

  const agent = Option.match(agentFile, {
    onNone: () => [],
    onSome: ({ dir, file }) => [decide("agent", file, dir)],
  });

  const workspace = Option.match(cwd, {
    onNone: () => [],
    onSome: (dir) =>
      workspaceDirs(dir).flatMap((each) =>
        Option.match(contextFileIn(each), {
          onNone: () => [],
          onSome: (file) =>
            Option.contains(
              Option.map(agentFile, ({ file: own }) => own),
              file
            )
              ? []
              : [decide("workspace", file, each)],
        })
      ),
  });

  const append = Option.match(agentDir, {
    onNone: () => [],
    onSome: (dir) => {
      const file = path.join(dir, "APPEND_SYSTEM.md");

      return lstatSync(file, { throwIfNoEntry: false }) === undefined
        ? []
        : [decide("append", file, dir)];
    },
  });

  return {
    files: [...agent, ...workspace, ...append],
    projectContext: projectContextText([...agent, ...workspace]),
    addendum: append.flatMap((row) => Option.toArray(row.text)).join(""),
  };
};

/** What a context reader offers. */
export interface ContextReader {
  /** Reads `cwd`'s context files (synchronous; call once per run). */
  read(cwd: Option.Option<string>): ContextRead;
  /** Reads them and logs each file left out, once per file and reason. */
  report(cwd: Option.Option<string>): Effect.Effect<ContextRead>;
}

const nothingRead: ContextRead = {
  files: [],
  projectContext: "",
  addendum: "",
};

/**
 * The context files of each thread's cwd, read now. A reference whose default reads nothing, so a
 * brain or a test that composes none has no context sections; the deployed brain provides `layer`
 * (through `Skills.live`).
 */
export class ProjectContext extends Context.Reference<ContextReader>(
  "cairn/server/skills/ProjectContext",
  {
    defaultValue: () => ({
      read: () => nothingRead,
      report: () => Effect.succeed(nothingRead),
    }),
  }
) {
  private static readonly make = (agentDir: Option.Option<string>) => {
    const read = (cwd: Option.Option<string>) =>
      readProjectContext(agentDir, cwd);

    return Effect.sync(() => {
      const logged = new Set<string>();

      const report = Effect.fn("ProjectContext.report")(function* (
        cwd: Option.Option<string>
      ) {
        const context = read(cwd);

        for (const file of context.files) {
          if (Option.isNone(file.reason)) {
            continue;
          }

          const key = `${file.path}\0${file.reason.value}`;

          if (logged.has(key)) {
            continue;
          }

          logged.add(key);

          yield* Effect.logWarning("context file left out").pipe(
            Effect.annotateLogs({
              event: "context_file_left_out",
              path: file.path,
              reason: file.reason.value,
            })
          );
        }

        return context;
      });

      return ProjectContext.of({ read, report });
    });
  };

  /** The agent dir of the ambient `PiConfig` plus each thread's workspace. */
  static readonly layerNoDeps = Layer.effect(
    ProjectContext,
    Effect.gen(function* () {
      const pi = yield* PiConfig;

      return yield* ProjectContext.make(Option.some(pi.agentDir));
    })
  );

  /** Over the brain's `PiConfig`. */
  static readonly layer = ProjectContext.layerNoDeps.pipe(
    Layer.provide(PiConfig.layer)
  );

  /** Workspace files only, no agent dir: the scripted dev brain and tests. */
  static readonly layerWorkspaceOnly = Layer.effect(
    ProjectContext,
    ProjectContext.make(Option.none())
  );
}
