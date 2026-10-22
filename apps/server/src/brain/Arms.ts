// The arms of a host thread: where its tools run. A thread's arms are a NodeExecutionEnv rooted at
// the conversation's `pi.agent.cwd` (the project root, or a worktree Cairn made first), built fresh
// on every call, with the brain's environment minus Cairn's own `CAIRN_*` settings. Stones (Phase 3)
// will read a `cairn.arms` document here and return a remote env instead.
//
// Ported from cairn-v1, apps/server/src/Harnesses.ts at 1a5cd4a (the env factory and `shellEnv`),
// rewritten as a service.
import type { EnvTarget, HarnessOptions } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Context, Layer } from "effect";

/** The prefix of the brain's own settings, which never reach a thread's processes. */
const PRIVATE_PREFIX = "CAIRN_";

/** The brain's environment without Cairn's private variables, for every process a thread starts. */
export const threadProcessEnv = (
  source: Readonly<Record<string, string | undefined>>
) => {
  const env: { [name: string]: string } = {};

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !key.startsWith(PRIVATE_PREFIX)) {
      env[key] = value;
    }
  }

  return env;
};

const shellEnv = () => threadProcessEnv(process.env);

/** Builds the execution environment pi-durable runs a conversation's tools in. */
export class Arms extends Context.Service<
  Arms,
  {
    /** `HarnessOptions.env`: none for a conversation without a cwd, so its tools fail clearly. */
    readonly env: NonNullable<HarnessOptions["env"]>;
    /** The variables a thread's processes get. */
    shellEnv(): Record<string, string>;
  }
>()("cairn/server/brain/Arms") {
  /** Host arms: the conversation's cwd on this machine. */
  static readonly layer = Layer.sync(Arms, () => {
    const env = (target: EnvTarget) =>
      target.cwd === undefined
        ? undefined
        : new NodeExecutionEnv({ cwd: target.cwd, shellEnv: shellEnv() });

    return Arms.of({ env, shellEnv });
  });
}
