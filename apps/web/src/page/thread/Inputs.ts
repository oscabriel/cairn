// What the root passes the thread page, from the shell.

import type { Option } from "effect";

import type { SubagentShells } from "../../timeline/Subagents.ts";

/** A launch that failed: why, from the shell row, and the draft its first message went back to. */
export interface LaunchFailure {
  readonly message: string;
  readonly retryUrl: Option.Option<string>;
}

/**
 * What the root passes the page, from the shell: the thread's working directory, a failed launch,
 * and the rows its subagent rows read.
 */
export interface ViewInputs {
  readonly workspaceRoot: Option.Option<string>;
  readonly launchFailure: Option.Option<LaunchFailure>;
  readonly subagents: Option.Option<SubagentShells>;
}
