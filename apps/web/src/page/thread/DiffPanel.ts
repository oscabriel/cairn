// The diff panel's view, loaded on demand (plan D46: `diff` is its own chunk). The panel's Model,
// Message and update stay in the entry; only `diff/View.ts` and what it alone imports are fetched,
// the first time the panel opens. The update asks for the load, the module is held outside the
// Model (as the shiki grammars are), and `LoadedDiffPanel` makes the page render it.

import { Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import type * as DiffView from "../../diff/View.ts";
import { Message } from "./Message.ts";

/** The diff panel's view module could not be fetched. */
export class DiffPanelLoadError extends Schema.TaggedError<DiffPanelLoadError>()(
  "DiffPanelLoadError",
  { cause: Schema.Defect() }
) {}

// Held outside the Model on purpose: a module is code, not state. One key, set once.
const loaded = new Map<"view", typeof DiffView.view>();

/** The panel's view once its chunk has loaded. */
export const loadedDiffView = (): Option.Option<typeof DiffView.view> =>
  Option.fromNullishOr(loaded.get("view"));

/** Fetches the panel's chunk. */
export const LoadDiffPanel = Command.define("LoadDiffPanel", {
  messages: [Message.LoadedDiffPanel, Message.FailedDiffPanel],
  execute: Effect.tryPromise({
    try: async () => await import("../../diff/View.ts"),
    catch: (cause) => new DiffPanelLoadError({ cause }),
  }).pipe(
    Effect.match({
      onSuccess: (module) => {
        loaded.set("view", module.view);

        return Message.LoadedDiffPanel();
      },
      onFailure: () => Message.FailedDiffPanel(),
    })
  ),
});

/** The placeholder shown while the chunk loads, or the notice when it failed. */
export const diffPanelPlaceholder = (
  h: HtmlBuilder<Message>,
  failed: boolean
): Html =>
  h.div(
    [
      h.DataAttribute("testid", "diff-panel-loading"),
      h.Class(
        "fixed inset-y-0 right-0 z-40 flex w-full items-center justify-center border-l bg-background text-muted-foreground text-sm shadow-lg md:w-[min(64rem,62vw)]"
      ),
    ],
    [
      failed
        ? "The diff panel could not load. Reload the page to try again."
        : "Loading the diff...",
    ]
  );
