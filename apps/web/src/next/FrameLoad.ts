// Loads the `next` views on demand (ADR 0040; the pattern is `SettingsPage.ts`). The settings
// update asks for the chunk (its `LoadNextFrame` Command runs `fetchNextFrame`) the first time the
// `ui` client setting is `next`; the module is held outside the Model, and the settings page's
// `LoadedNextFrame` makes the root draw with it. Until then, and when the chunk could not be
// fetched, the classic views draw the app. Only this module sits in the entry; `Frame.ts` and what
// it alone imports are fetched with the chunk.

import { Effect, Option, Schema } from "effect";

import type { Model } from "../Model.ts";
import type * as Frame from "./Frame.ts";
import type { MetersModule } from "./meters/Update.ts";

/** The `next` views' module could not be fetched. */
export class NextFrameLoadError extends Schema.TaggedError<NextFrameLoadError>()(
  "NextFrameLoadError",
  { cause: Schema.Defect() }
) {}

/** The `next` frame's view. */
export type FrameView = typeof Frame.view;

// Held outside the Model on purpose: a module is code, not state. One key, set once.
const loaded = new Map<"view", FrameView>();

// The meters' update (plan 6G) comes with the same chunk, so the entry carries only their Model.
const loadedMeters = new Map<"meters", MetersModule>();

/** Fetches the `next` views' chunk and holds its view; the settings `LoadNextFrame` runs it. */
export const fetchNextFrame: Effect.Effect<void, NextFrameLoadError> =
  Effect.tryPromise({
    try: async () => await import("./Frame.ts"),
    catch: (cause) => new NextFrameLoadError({ cause }),
  }).pipe(
    Effect.flatMap((module) =>
      Effect.sync(() => {
        loaded.set("view", module.view);
        loadedMeters.set("meters", module.meters);
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
 * The meters' update and root hooks: some when the `next` frame draws (`nextFrameOf`), so the usage
 * page and the role table are updated exactly when they can be drawn.
 */
export const nextMetersOf = (model: Model): Option.Option<MetersModule> =>
  Option.flatMap(nextFrameOf(model), () =>
    Option.fromNullishOr(loadedMeters.get("meters"))
  );
