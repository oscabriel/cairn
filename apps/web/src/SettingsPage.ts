// The settings page's view, loaded on demand (plan D46: `settings` is its own chunk). The page's
// Model, Message, update and subscriptions stay in the entry, because the usage meter reads them
// on every route; only `settings/View.ts` and what it alone imports are fetched, the first time
// the settings route opens. The update asks for the load, the module is held outside the Model,
// and `LoadedSettingsPage` makes the root render it.

import { Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./Message.ts";
import type * as SettingsView from "./settings/View.ts";

/** The settings page's view module could not be fetched. */
export class SettingsPageLoadError extends Schema.TaggedError<SettingsPageLoadError>()(
  "SettingsPageLoadError",
  { cause: Schema.Defect() }
) {}

// Held outside the Model on purpose: a module is code, not state. One key, set once.
const loaded = new Map<"view", typeof SettingsView.view>();

/** The page's view once its chunk has loaded. */
export const loadedSettingsView = (): Option.Option<typeof SettingsView.view> =>
  Option.fromNullishOr(loaded.get("view"));

/** Fetches the page's chunk. */
export const LoadSettingsPage = Command.define("LoadSettingsPage", {
  messages: [Message.LoadedSettingsPage, Message.FailedSettingsPage],
  execute: Effect.tryPromise({
    try: async () => await import("./settings/View.ts"),
    catch: (cause) => new SettingsPageLoadError({ cause }),
  }).pipe(
    Effect.match({
      onSuccess: (module) => {
        loaded.set("view", module.view);

        return Message.LoadedSettingsPage();
      },
      onFailure: () => Message.FailedSettingsPage(),
    })
  ),
});

/** The placeholder shown while the chunk loads, or the notice when it failed. */
export const settingsPlaceholder = (
  h: HtmlBuilder<Message>,
  failed: boolean
): Html =>
  h.section(
    [
      h.DataAttribute("testid", "settings-loading"),
      h.Class("mx-auto w-full max-w-2xl p-6 text-muted-foreground text-sm"),
    ],
    [
      failed
        ? "Settings could not load. Reload the page to try again."
        : "Loading settings...",
    ]
  );
