// The bridge's settings, with defaults (coding standard S41): where children start from and how
// many may live. The server overrides them from its config.

import { tmpdir } from "node:os";

import { Context, Duration, Option } from "effect";

import type { SourceEnv } from "./ClaudeGuards.ts";
import type { LongContextSettings } from "./ClaudeModels.ts";
import { DEFAULT_LONG_CONTEXT } from "./ClaudeModels.ts";

/** Settings of the Claude bridge. */
export interface ClaudeSettingsValue {
  /** The environment children start from; credentials and `CAIRN_*` are stripped from it. */
  readonly env: SourceEnv;
  /** The `claude` binary; none runs the one bundled with the pinned Agent SDK. */
  readonly executable: Option.Option<string>;
  /** The plan as far as `[1m]` model ids depend on it. */
  readonly longContext: LongContextSettings;
  /** Where a child runs when its conversation's cwd was never noted. */
  readonly fallbackCwd: string;
  /** How long a conversation with no call in flight keeps its child. */
  readonly idleTimeToLive: Duration.Duration;
  /** The most conversations (and so children) alive at once. */
  readonly liveChildren: number;
  /** A generating child silent this long is stalled, unless it waits on a tool or announced a retry. */
  readonly stallAfter: Duration.Duration;
}

/** Settings of the Claude bridge; defaults suit the brain on the Beelink. */
export const ClaudeSettings = Context.Reference<ClaudeSettingsValue>(
  "cairn/bridge/ClaudeSettings",
  {
    defaultValue: () => ({
      env: process.env,
      executable: Option.none(),
      longContext: DEFAULT_LONG_CONTEXT,
      fallbackCwd: tmpdir(),
      idleTimeToLive: Duration.minutes(10),
      liveChildren: 12,
      stallAfter: Duration.seconds(90),
    }),
  }
);
