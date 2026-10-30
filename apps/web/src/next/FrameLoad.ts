// Loads the `next` views on demand (ADR 0040; the pattern is `SettingsPage.ts`). The settings
// update asks for the chunk (its `LoadNextFrame` Command runs `fetchNextFrame`) the first time the
// `ui` client setting is `next`; the module is held outside the Model, and the settings page's
// `LoadedNextFrame` makes the root draw with it. Until then, and when the chunk could not be
// fetched, the classic views draw the app. Only this module sits in the entry; `Frame.ts` and what
// it alone imports are fetched with the chunk.

import { Effect, Option, Schema } from "effect";

import type { Model } from "../Model.ts";
import type { RequestCardModule } from "./card/Update.ts";
import type * as Frame from "./Frame.ts";

/** The `next` views' module could not be fetched. */
export class NextFrameLoadError extends Schema.TaggedError<NextFrameLoadError>()(
  "NextFrameLoadError",
  { cause: Schema.Defect() }
) {}

/** The `next` frame's view. */
export type FrameView = typeof Frame.view;

// Held outside the Model on purpose: a module is code, not state. One key, set once.
const loaded = new Map<"view", FrameView>();

// The request card's update (plan 6A) comes with the same chunk, so the entry carries only its Model.
const loadedRequestCard = new Map<"card", RequestCardModule>();

/** Fetches the `next` views' chunk and holds its view; the settings `LoadNextFrame` runs it. */
export const fetchNextFrame: Effect.Effect<void, NextFrameLoadError> =
  Effect.tryPromise({
    try: async () => await import("./Frame.ts"),
    catch: (cause) => new NextFrameLoadError({ cause }),
  }).pipe(
    Effect.flatMap((module) =>
      Effect.sync(() => {
        loaded.set("view", module.view);
        loadedRequestCard.set("card", module.requestCard);
      })
    )
  );

/**
 * The `next` frame to draw `model` with: some when the `ui` setting is `next` and its chunk has
 * loaded, none when the classic views draw the app.
 */
export const nextFrameOf = (model: Model): Option.Option<FrameView> =>
  model.settings.client.ui === "next" && model.settings.nextFrame === "loaded"
    ? Option.fromNullishOr(loaded.get("view"))
    : Option.none();

/**
 * The request card's update and root hooks: some when the `next` frame draws (`nextFrameOf`), so
 * the card is updated exactly when it is drawn.
 */
export const nextRequestCardOf = (
  model: Model
): Option.Option<RequestCardModule> =>
  Option.flatMap(nextFrameOf(model), () =>
    Option.fromNullishOr(loadedRequestCard.get("card"))
  );
