// Ported from github.com/pingdotgg/t3code, packages/contracts/src/checkpointDiff.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: per-turn and whole-thread diffs addressed by turn
// counts, with the whitespace switch and the range check. Changed: Cairn's ids and errors.
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

import { Schema } from "effect";

import { NonNegativeInt, ThreadId } from "./Ids.ts";

/** `diff.turn` input: the changes between two checkpoints, `fromTurnCount <= toTurnCount`. */
export const TurnDiffInput = Schema.Struct({
  threadId: ThreadId,
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.Boolean,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      "fromTurnCount must be less than or equal to toTurnCount",
    { identifier: "TurnDiffRange" }
  )
);

export type TurnDiffInput = typeof TurnDiffInput.Type;

/** `diff.full` input: everything the thread changed up to `toTurnCount`. */
export const FullDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.Boolean,
});

export type FullDiffInput = typeof FullDiffInput.Type;

/** A unified diff between two turn counts. Empty when nothing changed. */
export const ThreadDiff = Schema.Struct({
  threadId: ThreadId,
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
  diff: Schema.String,
});

export type ThreadDiff = typeof ThreadDiff.Type;
