// The diff panel's Messages. The changed-files card in the transcript opens the panel by sending
// `RequestedOpen` (through its parent), or the parent calls `open` (Update.ts) directly.
import { ThreadId } from "@cairn/protocol/Ids";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { DiffScope } from "./Model.ts";

/** Everything the diff panel reacts to. */
export const Message = defineMessageUnion({
  /** The changed-files card asked for a turn's diff, at a file when it names one. */
  RequestedOpen: {
    threadId: ThreadId,
    turn: Schema.Int,
    path: Schema.Option(Schema.String),
  },
  ClickedClose: {},
  /**
   * The header's toggle: closes an open panel, or opens the thread's whole diff (baseline to its
   * newest checkpointed turn).
   */
  ClickedToggle: { threadId: ThreadId, latestTurn: Schema.Int },
  ClickedScope: { scope: DiffScope },
  ToggledWhitespace: {},
  ClickedFile: { path: Schema.String },
  ClickedRetry: {},
  LoadedDiff: { version: Schema.Int, patch: Schema.String },
  FailedDiff: { version: Schema.Int, message: Schema.String },
  ScrolledToFile: {},
  LoadedLanguage: { language: Schema.String },
  /** A long file's tokens are in the shared cache, a slice more of them: its grammar is loaded. */
  HighlightedCode: { language: Schema.String },
  FailedLanguage: { language: Schema.String },
});

export type Message = typeof Message.Type;
