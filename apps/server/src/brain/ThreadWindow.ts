// The thread stream's window (ADR 0020, plan 4C): a subscription starts with the newest part of a
// long thread, and `thread.history` pages in the rest. The wire budget judge measured the projection
// alone at 1,133,675 bytes for a 2,017-entry thread, against a 200,000 byte budget, so it is built.
//
// - Where a window starts: walking back from the newest entry, at most 10 user turns, 75 entries
//   and 1 MiB of projected JSON, and at least one entry. When the cut falls inside a turn and the
//   turn's own user message is in the newer half of the window, the window starts at that message
//   instead, so the top of the timeline is a whole turn.
// - `entriesOffset` is the number of active entries before the window. It is fixed for the life of
//   one window: appends grow the window, they never slide it.
// - Ops: each revision's window (the entries from `entriesOffset` on, with the whole documents) is
//   diffed against the previous one with chord's `diffRevisions`, so op indices count from the
//   window's start by construction; no op is rewritten and none can reach below the window.
// - A fresh in-stream snapshot, with a new window, whenever the entries before the window are not
//   exactly the ones the window was cut after (a compaction or a reset moved the head, the view was
//   replaced by another conversation, the thread got shorter). Entry ids are store-wide and the
//   active entries are one path, so comparing ids proves the prefix unchanged.
//
// Policy numbers from t3code's apps/server/src/orchestration-v2/threadHistoryPaging.ts
// (`THREAD_HISTORY_PAGE_POLICY`) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Changed: the item
// and byte limits apply to every window, not only to histories without user turns, because Cairn's
// snapshot budget is 200 KB; a window is computed from pi-durable's view, not from projection rows.
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
import type { ConversationView, Op } from "@cairn/protocol/Thread";
import type {
  EntryRecord,
  ConversationView as PiConversationView,
} from "@earendil-works/pi-durable";
import { Data, Result } from "effect";

import {
  decodeProjectedView,
  diffProjected,
  entryWireBytes,
  projectViewJson,
} from "./ThreadWire.ts";
import type { JsonRecord, ThreadWireError } from "./ThreadWire.ts";

/** How much of a thread a window holds. */
export interface WindowPolicy {
  readonly maxUserTurns: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
}

/** t3code's numbers: 10 user turns, 75 items, 1 MiB. */
export const WINDOW_POLICY: WindowPolicy = {
  maxUserTurns: 10,
  maxEntries: 75,
  maxBytes: 1_048_576,
};

/** Entry kinds that start a user turn. */
const USER_KINDS: ReadonlySet<string> = new Set(["pi.user", "cairn.user"]);

const isUserEntry = (entry: EntryRecord) => USER_KINDS.has(entry.kind);

/** The index of the first active entry a new window holds. */
export const windowStart = (
  entries: ReadonlyArray<EntryRecord>,
  policy: WindowPolicy = WINDOW_POLICY
): number => {
  let start = entries.length;
  let bytes = 0;
  let userTurns = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (entry === undefined) {
      break;
    }

    const size = entryWireBytes(entry);
    const held = entries.length - start;

    if (
      held > 0 &&
      (userTurns >= policy.maxUserTurns ||
        held >= policy.maxEntries ||
        bytes + size > policy.maxBytes)
    ) {
      break;
    }

    start = index;
    bytes += size;

    if (isUserEntry(entry)) {
      userTurns += 1;
    }
  }

  const first = entries[start];

  if (first === undefined || isUserEntry(first)) {
    return start;
  }

  // The cut fell inside a turn: start at the turn after it when that keeps most of the window.
  const half = start + Math.floor((entries.length - start) / 2);

  for (let index = start + 1; index <= half; index += 1) {
    const entry = entries[index];

    if (entry !== undefined && isUserEntry(entry)) {
      return index;
    }
  }

  return start;
};

/** A window of the projected view and the number of active entries before it. */
export interface WindowedView {
  readonly view: ConversationView;
  readonly entriesOffset: number;
}

/** What one revision becomes on the wire. */
export type WindowFrame = Data.TaggedEnum<{
  /** Ops against the window the client holds, indices counted from its start. */
  Ops: { readonly ops: ReadonlyArray<Op> };
  /** A new window: the entries before the old one changed. */
  Snapshot: WindowedView;
}>;

export const WindowFrame = Data.taggedEnum<WindowFrame>();

/** A windowed projector for one subscription. */
export interface WindowedProjector {
  /** The first frame of a subscription: a new window over this revision. */
  snapshot(
    view: PiConversationView
  ): Result.Result<WindowedView, ThreadWireError>;
  /** The frame from the last revision to this one; `Ops` with no ops when nothing visible changed. */
  advance(
    view: PiConversationView
  ): Result.Result<WindowFrame, ThreadWireError>;
}

/** True when `entries` starts with exactly the entries whose ids are `prefix`. */
const keepsPrefix = (
  entries: ReadonlyArray<EntryRecord>,
  prefix: ReadonlyArray<EntryRecord["id"]>
) =>
  entries.length >= prefix.length &&
  prefix.every((id, index) => entries[index]?.id === id);

export const windowedProjector = (
  policy: WindowPolicy = WINDOW_POLICY
): WindowedProjector => {
  let previous: JsonRecord = {};
  let prefix: ReadonlyArray<EntryRecord["id"]> = [];

  const open = (
    view: PiConversationView
  ): Result.Result<WindowedView, ThreadWireError> => {
    const offset = windowStart(view.entries, policy);

    previous = projectViewJson(view, offset);
    prefix = view.entries.slice(0, offset).map((entry) => entry.id);

    return Result.map(decodeProjectedView(previous), (projected) => ({
      view: projected,
      entriesOffset: offset,
    }));
  };

  return {
    snapshot: open,
    advance: (view) => {
      if (!keepsPrefix(view.entries, prefix)) {
        return Result.map(open(view), WindowFrame.Snapshot);
      }

      const next = projectViewJson(view, prefix.length);
      const ops = diffProjected(previous, next);

      previous = next;

      return Result.map(ops, (found) => WindowFrame.Ops({ ops: found }));
    },
  };
};
