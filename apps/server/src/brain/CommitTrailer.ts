// Ported from github.com/HazAT/ultimate, extensions/coding-tools/server.ts (`hooks`, `prepareBash`)
// at 8b26338680fc5bc970b68c281c4e9b03a09887c1. Kept: one process-local `prepare-commit-msg` hook
// per `bash` call, set through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`
// after any pairs the environment already has, running `git interpret-trailers --in-place
// --if-exists replace` with a trailing `#` that drops the arguments git appends. Changed: the
// trailer is `Cairn-Thread: <thread id>` (the thread, read from `cairn.thread-meta`, not the
// conversation number); no commit log hooks; a conversation that is not a thread gets no hook; and
// the hook is offered only on git 2.54 or later, the first with hooks defined in config.
//
// MIT License. Copyright (c) 2026 Daniel Griesser.
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

import { ThreadId } from "@cairn/protocol/Ids";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Option, Schema } from "effect";

import { ThreadMeta } from "./CairnDocs.ts";

/** The trailer every commit made through a thread's `bash` carries. */
export const COMMIT_TRAILER = "Cairn-Thread";

/** The name of the config-defined hook that adds it. */
export const TRAILER_HOOK = "cairn-prepare-commit-msg";

/** The first git with hooks defined in config (`hook.<name>.event` and `.command`). */
export const MIN_TRAILER_GIT = { major: 2, minor: 54 } as const;

/** A git version's major and minor numbers. */
export interface GitVersion {
  readonly major: number;
  readonly minor: number;
}

/** The version in `git version` output (`git version 2.56.0`); none when it names none. */
export const parseGitVersion = (output: string): Option.Option<GitVersion> => {
  const match = /git version (?<major>\d+)\.(?<minor>\d+)/u.exec(output);

  return Option.map(Option.fromNullishOr(match?.groups), (groups) => ({
    major: Number(groups.major),
    minor: Number(groups.minor),
  }));
};

/** Whether `version` runs hooks defined in config, which the trailer needs. */
export const supportsTrailer = (version: GitVersion) =>
  version.major > MIN_TRAILER_GIT.major ||
  (version.major === MIN_TRAILER_GIT.major &&
    version.minor >= MIN_TRAILER_GIT.minor);

/**
 * The hook's shell command. git runs it as `sh -c '<command> "$@"' <command> <file> [<source>]`,
 * so `"$1"` is the message file and the trailing `#` turns the appended arguments into a comment.
 * A thread id is a UUID, so it needs no quoting beyond the single quotes.
 */
export const trailerCommand = (threadId: ThreadId) =>
  `git interpret-trailers --in-place --if-exists replace --trailer '${COMMIT_TRAILER}: ${threadId}' "$1" #`;

const configCount = (env: Readonly<Record<string, string>>) => {
  const count = Number(env.GIT_CONFIG_COUNT ?? "0");

  return Number.isSafeInteger(count) && count > 0 ? count : 0;
};

/**
 * `env` plus the trailer hook's two config pairs, numbered after any `GIT_CONFIG_*` pairs `env`
 * already carries, so the user's own process-level config keeps working.
 */
export const withTrailerHook = (
  env: Readonly<Record<string, string>>,
  threadId: ThreadId
) => {
  const first = configCount(env);

  return {
    ...env,
    [`GIT_CONFIG_KEY_${first}`]: `hook.${TRAILER_HOOK}.event`,
    [`GIT_CONFIG_VALUE_${first}`]: "prepare-commit-msg",
    [`GIT_CONFIG_KEY_${first + 1}`]: `hook.${TRAILER_HOOK}.command`,
    [`GIT_CONFIG_VALUE_${first + 1}`]: trailerCommand(threadId),
    GIT_CONFIG_COUNT: String(first + 2),
  };
};

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** The thread a tool call's conversation is; none for a conversation that is not a thread. */
export const threadOfCall = async (
  api: Pick<ToolExecutionApi, "snapshot" | "conversationId">,
  context: ChordContext
): Promise<Option.Option<ThreadId>> => {
  const meta = await api.snapshot(ThreadMeta, api.conversationId, context);

  return decodeThreadId(meta?.threadId);
};
