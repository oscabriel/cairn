// What the root tells the push toggle, built from what the root already holds: the epoch and its
// client, the VAPID key from that epoch's `session.hello`, the thread on screen, and the badge
// count (`@cairn/client-logic/Badge`'s one counting rule, which the push's notifier counts with;
// the page also counts the scratch thread it holds, which the brain cannot see).

import { needsYouCount } from "@cairn/client-logic/Badge";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { Hello } from "@cairn/protocol/Rpc";
import type { ShellSnapshot } from "@cairn/protocol/Shell";
import { Equal, Option } from "effect";

import type { PushContext } from "./Model.ts";

/** The root's state the toggle reads. */
export interface PushInputs {
  readonly epoch: number;
  readonly hasClient: boolean;
  readonly hello: Option.Option<Hello>;
  readonly shell: Option.Option<ShellSnapshot>;
  readonly openThreadId: Option.Option<ThreadId>;
  /** The scratch thread this device holds (its localStorage), which the badge counts too. */
  readonly scratchThreadId: Option.Option<ThreadId>;
}

/** The toggle's context from the root's state. */
export const pushContextOf = (inputs: PushInputs): PushContext => ({
  epoch: inputs.epoch,
  hasClient: inputs.hasClient,
  vapidKey: Option.flatMap(inputs.hello, (hello) => hello.vapidPublicKey),
  threadId: inputs.openThreadId,
  badge: Option.match(inputs.shell, {
    onNone: () => 0,
    onSome: (shell) => needsYouCount(shell, inputs.scratchThreadId),
  }),
});

/** True when two contexts say the same thing, so the root can skip informing the toggle. */
export const samePushContext = (
  left: PushContext,
  right: PushContext
): boolean =>
  left.epoch === right.epoch &&
  left.hasClient === right.hasClient &&
  left.badge === right.badge &&
  Equal.equals(left.vapidKey, right.vapidKey) &&
  Equal.equals(left.threadId, right.threadId);
