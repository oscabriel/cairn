// The launches `project-thread-kill.ts` and `ProjectThreadKill.test.ts` share: one folder project,
// its first project thread, and the refresh that replaces it, all with fixed ids so a resend in the
// next process is the same command.

import { CommandId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import type { ThreadLaunchInput } from "@cairn/protocol/Launch";
import { RootWorkspace } from "@cairn/protocol/Launch";
import { ProjectCreate } from "@cairn/protocol/ShellCommands";
import { Option } from "effect";

import { projectIdFor } from "../../shell/ShellCommands.ts";

const uuid7 = (variant: string, n: number) =>
  `019a2b3c-4d5e-7f60-${variant}-${n.toString(16).padStart(12, "0")}`;

/** Registers the project at `root`. */
export const projectCommand = (root: string) =>
  ProjectCreate.make({
    commandId: CommandId.make(uuid7("8000", 1)),
    workspaceRoot: root,
    title: Option.some("kill"),
  });

/** The project's id. */
export const PROJECT_ID = projectIdFor(CommandId.make(uuid7("8000", 1)));

/** The first project thread. */
export const FIRST = ThreadId.make(uuid7("9000", 1));

/** The project thread the refresh makes. */
export const SECOND = ThreadId.make(uuid7("9000", 2));

const launchOf = (n: number, threadId: ThreadId): ThreadLaunchInput => ({
  commandId: CommandId.make(uuid7("a000", n)),
  threadId,
  projectId: PROJECT_ID,
  title: Option.some(`Project thread ${n}`),
  model: { provider: "scripted", modelId: "scripted" },
  thinkingLevel: "off",
  runtimeMode: "full-access",
  workspace: RootWorkspace.make({ branch: Option.none() }),
  initialMessage: {
    requestId: RequestId.make(`launch-${n}`),
    text: `project thread ${n}`,
    attachments: [],
    skillRefs: [],
  },
});

/** The first launch in the project: it marks `FIRST`. */
export const FIRST_LAUNCH = launchOf(1, FIRST);

/** The refresh: `SECOND` replaces `FIRST`. */
export const REFRESH: ThreadLaunchInput = {
  ...launchOf(2, SECOND),
  replaces: FIRST,
};
