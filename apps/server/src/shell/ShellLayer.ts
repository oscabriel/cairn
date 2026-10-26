// The shell store as one layer: the rows and the event log, the event sink, the snapshot, the
// stream and settlement (whose fibers start with the layer, reading the server settings). Needs
// the migrated `SqlClient` from `Database`.

import { Layer } from "effect";

import { SettingsStore } from "../models/SettingsStore.ts";
import { EventSink } from "./EventSink.ts";
import { Settlement } from "./Settlement.ts";
import { ShellSnapshot } from "./ShellSnapshot.ts";
import { ShellStream } from "./ShellStream.ts";

/** Everything the shell store serves, without settlement's background fibers. */
export const ShellStoreLayer = ShellStream.layerNoDeps.pipe(
  Layer.provideMerge(ShellSnapshot.layerNoDeps),
  Layer.provideMerge(EventSink.layer)
);

/**
 * The shell store with settlement running, reading the server settings. Projector signals are not
 * defaulted here: the composition root gives the projector its real ones (T32).
 */
export const ShellLayer = Settlement.layerNoDeps.pipe(
  Layer.provide(SettingsStore.layerNoDeps),
  Layer.provideMerge(ShellStoreLayer)
);
