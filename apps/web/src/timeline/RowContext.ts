// What the transcript's rows share, from the classic row view ported from github.com/pingdotgg/t3code,
// apps/web/src/components/chat/MessagesTimeline.tsx at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// the context a row's view reads, and the working timer, a Mount that writes its own text once a
// second so it never re-renders the list. The classic row view was deleted (W-6); the
// transcript draws the rows (`RowView.ts`).
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

import { formatDuration } from "@cairn/client-logic/Time";
import type { TimelineMessage } from "@cairn/client-logic/TimelineEntries";
import type { EntryId } from "@cairn/protocol/Ids";
import { Clock, Duration, Effect, Schedule, Schema } from "effect";
import type { Option } from "effect";
import * as Mount from "foldkit/mount";

import { Message } from "./Message.ts";
import type { HistoryState } from "./Model.ts";
import type { SubagentShells } from "./Subagents.ts";

/** What a row's view reads besides the row. Every field is compared by the row's keyed lazy. */
export interface RowContext {
  readonly threadId: string;
  readonly workspaceRoot: Option.Option<string>;
  readonly highlightedLanguages: ReadonlyArray<string>;
  /** Changes when a long code block's tokens are ready, so the row redraws with them. */
  readonly highlightedCode: number;
  readonly copiedRowId: Option.Option<string>;
  readonly expanded: boolean;
  /** For an error row: the prompt Retry sends again. */
  readonly retryPrompt: Option.Option<TimelineMessage>;
  /** For the history control. */
  readonly history: HistoryState;
  readonly historyCursor: Option.Option<EntryId>;
  /** For a subagent group and the way back: the shell rows they read. */
  readonly subagents: Option.Option<SubagentShells>;
}

/** Writes "<duration>" into its element once a second, from `startedAt`. */
export const WorkingTimer = Mount.define("WorkingTimer", {
  args: { startedAt: Schema.Finite },
  messages: [Message.MountedTimer],
  execute: ({ element, startedAt }) =>
    Effect.gen(function* () {
      const write = Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.sync(() => {
          element.textContent = formatDuration(Math.max(0, now - startedAt));
        })
      );

      yield* Effect.forkScoped(
        Effect.repeat(write, Schedule.spaced(Duration.seconds(1)))
      );

      return Message.MountedTimer();
    }),
});
