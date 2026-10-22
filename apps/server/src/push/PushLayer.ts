// Web Push as one layer: the VAPID key, the sender, the subscription table, the in-memory presence
// reports and the notifier, whose event loop starts with the layer. Needs the shell store
// (`EventStore`, `ThreadRows`), the migrated `SqlClient` and `ServerConfig`. The key is made in
// memory unless the entry point provides `VapidKeyFromFile` (only `main.ts` does), so dev brains,
// judges and tests never make or read the deployed brain's `push.json`.
import { Layer } from "effect";

import { Notifier } from "./Notifier.ts";
import { Presence } from "./Presence.ts";
import { PushSubscriptions } from "./PushSubscriptions.ts";
import { Vapid } from "./Vapid.ts";
import { WebPush } from "./WebPush.ts";

/** Everything push serves, over the global `fetch`. */
export const PushLayer = Notifier.layerNoDeps.pipe(
  Layer.provideMerge(
    Layer.mergeAll(WebPush.layer, PushSubscriptions.layerNoDeps, Presence.layer)
  ),
  Layer.provideMerge(Vapid.layerChosen)
);
