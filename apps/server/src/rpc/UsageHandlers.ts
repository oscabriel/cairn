// `usage.subscribe`: the plan-window stream, a thin pass-through of `UsageFeed`. The feed cannot
// fail (an unreadable window is reported as unknown inside the frame), so no error is translated.

import { CairnRpcs } from "@cairn/protocol/Rpc";

import { UsageFeed } from "../usage/UsageFeed.ts";

/** `usage.subscribe`. Needs `UsageFeed`. */
export const UsageHandlers = CairnRpcs.toLayerHandler(
  "usage.subscribe",
  UsageFeed.useSync((feed) => () => feed.snapshots)
);
