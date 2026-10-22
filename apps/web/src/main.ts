// The PWA's entry: one Foldkit routing application over the protocol at /ws. Flags are read before
// the first update: the shell the server inlined as boot data, and the outbox saved on this device.
import { BrowserKeyValueStore } from "@effect/platform-browser";
import { Effect } from "effect";
import { Runtime } from "foldkit";

import { loadOutbox } from "./connection/Outbox.ts";
import { Message } from "./Message.ts";
import { Flags, Model } from "./Model.ts";
import { readBootData } from "./shell/ShellStore.ts";
import { managedResources, subscriptions } from "./Subscription.ts";
import { init, update } from "./Update.ts";
import { view } from "./View.ts";

const flags = Effect.gen(function* () {
  const boot = yield* readBootData;
  const outbox = yield* loadOutbox;

  return { boot, outbox };
});

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions,
  managedResources,
  resources: BrowserKeyValueStore.layerLocalStorage,
  container: document.querySelector("#root"),
  routing: {
    onUrlRequest: (request) => Message.ClickedLink({ request }),
    onUrlChange: (url) => Message.ChangedUrl({ url }),
  },
  devTools: {
    Message,
    excludeFromHistory: ["ReceivedShellItem", "GotThreadMessage"],
  },
});

Runtime.run(application, { flags });
