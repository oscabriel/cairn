// Values the client's Story tests share: a Model in each connection state, a hello, a snapshot and
// outbox items. Only tests import this module.
import { RootWorkspace, ThreadLaunchInput } from "@cairn/protocol/Launch";
import { Hello } from "@cairn/protocol/Rpc";
import { ShellSnapshot } from "@cairn/protocol/Shell";
import { SendInput } from "@cairn/protocol/Thread";
import { Option, Schema } from "effect";

import * as Composer from "./composer/Model.ts";
import { OutboxItem } from "./connection/Outbox.ts";
import { ConnectionState } from "./connection/Reconnect.ts";
import type { Model } from "./Model.ts";
import * as Thread from "./page/thread/index.ts";
import * as Push from "./push/Model.ts";
import { AppRoute } from "./Route.ts";
import * as Settings from "./settings/Model.ts";
import * as Parked from "./shell/Parked.ts";
import { initial as initialSidebar } from "./sidebar/Model.ts";

/** An empty shell at sequence 0. */
export const emptySnapshot: ShellSnapshot = Schema.decodeSync(ShellSnapshot)({
  snapshotSequence: 0,
  projects: [],
  threads: [],
});

/** A page on the inbox with no shell yet, connecting for the first time. */
export const connectingModel: Model = {
  route: AppRoute.Inbox(),
  connection: { epoch: 0, state: ConnectionState.Connecting({ attempt: 0 }) },
  hello: Option.none(),
  shell: Option.none(),
  outbox: [],
  outboxInFlight: Option.none(),
  outboxAttempt: 0,
  notice: Option.none(),
  thread: Thread.Model.initial,
  sidebar: initialSidebar,
  composer: Composer.initial,
  push: Push.initial,
  settings: Settings.initial,
  parked: Parked.initial,
  settingsPage: "idle",
};

/** The same page once the shell is current on epoch `epoch`. */
export const liveModel = (epoch: number): Model => ({
  ...connectingModel,
  connection: { epoch, state: ConnectionState.Live() },
  shell: Option.some(emptySnapshot),
  thread: { ...Thread.Model.initial, epoch, hasClient: true },
});

/** The same page waiting before attempt `attempt`, after epoch `epoch` failed. */
export const backingOff = (epoch: number, attempt: number): Model => ({
  ...liveModel(epoch),
  connection: { epoch, state: ConnectionState.Backoff({ attempt }) },
  thread: { ...Thread.Model.initial, epoch },
});

/** A hello as the brain answers it. */
export const hello: Hello = Schema.decodeSync(Schema.toCodecJson(Hello))({
  protocol: 1,
  build: "test",
  serverTime: "2026-10-22T00:00:00.000Z",
  viewer: "owner@github",
  defaults: {
    model: { provider: "opencode-go", modelId: "small" },
    thinkingLevel: "medium",
  },
  vapidPublicKey: null,
});

/** A `thread.send` waiting in the outbox, keyed by `requestId`. */
export const sendItem = (requestId: string): OutboxItem =>
  OutboxItem.Send({
    input: Schema.decodeSync(SendInput)({
      threadId: "01890a5d-ac96-774b-bcce-b302099a8057",
      input: {
        requestId,
        text: `message ${requestId}`,
        attachments: [],
        skillRefs: [],
      },
      whenBusy: "followUp",
    }),
  });

/** A `thread.launch` waiting in the outbox, for thread `threadId`. */
export const launchItem = (threadId: string): OutboxItem =>
  OutboxItem.Launch({
    input: Schema.decodeSync(ThreadLaunchInput)({
      commandId: "01890a5d-ac96-774b-bcce-b302099a80c1",
      threadId,
      projectId: "project-1",
      title: null,
      model: { provider: "opencode-go", modelId: "small" },
      thinkingLevel: "medium",
      runtimeMode: "full-access",
      workspace: Schema.encodeSync(RootWorkspace)(
        RootWorkspace.make({ branch: Option.none() })
      ),
      initialMessage: {
        requestId: "launch-request-1",
        text: "start here",
        attachments: [],
        skillRefs: [],
      },
    }),
  });
