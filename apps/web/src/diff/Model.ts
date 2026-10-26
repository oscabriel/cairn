// The diff panel's state: which thread and turn it shows (none while closed), whether it shows that
// turn alone or everything up to it, the whitespace switch, the file the user picked, the patch as
// the brain sent it, and the code grammars loaded so far. Parsed files are derived in the view,
// once per patch.

import { ThreadId } from "@cairn/protocol/Ids";
import { Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

/** One turn alone (`diff.turn` from the turn before), or the thread's baseline to it (`diff.full`). */
export const DiffScope = Schema.Literals(["turn", "full"]);

export type DiffScope = typeof DiffScope.Type;

/** The thread and the turn the panel shows. */
export const DiffTarget = Schema.Struct({
  threadId: ThreadId,
  turn: Schema.Int,
});

export type DiffTarget = typeof DiffTarget.Type;

/** Where the patch is. */
export const DiffLoad = defineTaggedUnion({
  Idle: {},
  Loading: {},
  Loaded: { patch: Schema.String },
  Failed: { message: Schema.String },
});

export type DiffLoad = typeof DiffLoad.Type;

/** The diff panel's Model. */
export const Model = Schema.Struct({
  /** None while the panel is closed. */
  target: Schema.Option(DiffTarget),
  scope: DiffScope,
  ignoreWhitespace: Schema.Boolean,
  /** The file to scroll to and mark in the file list. */
  selectedPath: Schema.Option(Schema.String),
  load: DiffLoad,
  /** Bumped by every request; an answer for an older one is dropped. */
  version: Schema.Int,
  highlightedLanguages: Schema.Array(Schema.String),
  /** Counts slices of long files tokenized off the render; file views compare it, so they redraw. */
  highlightedCode: Schema.Int,
});

export type Model = typeof Model.Type;

/** A closed panel. */
export const initial: Model = {
  target: Option.none(),
  scope: "turn",
  ignoreWhitespace: false,
  selectedPath: Option.none(),
  load: DiffLoad.Idle(),
  version: 0,
  highlightedLanguages: [],
  highlightedCode: 0,
};

/** True while the panel is open. */
export const isOpen = (model: Model): boolean => Option.isSome(model.target);
