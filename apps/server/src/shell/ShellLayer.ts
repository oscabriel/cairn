// The shell store as one layer: the rows and the event log, the event sink, the snapshot, the
// stream, settlement (whose fibers start with the layer) and the default projector signals. Needs
// the migrated `SqlClient` from `Database`.
import { Layer } from "effect";

import { EventSink } from "./EventSink.ts";
import { ProjectorSignals } from "./ProjectorSignals.ts";
import { Settlement } from "./Settlement.ts";
import { ShellSnapshot } from "./ShellSnapshot.ts";
import { ShellStream } from "./ShellStream.ts";

/** Everything the shell store serves, without settlement's background fibers. */
export const ShellStoreLayer = ShellStream.layerNoDeps.pipe(
  Layer.provideMerge(ShellSnapshot.layerNoDeps),
  Layer.provideMerge(EventSink.layer)
);

/** The shell store with settlement running and the default projector signals. */
export const ShellLayer = Layer.mergeAll(
  Settlement.layerNoDeps,
  ProjectorSignals.layer
).pipe(Layer.provideMerge(ShellStoreLayer));
