// Values the composer's tests share: a project, a thread row, a model catalog and a Model informed
// with them. Only tests import this module.
import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import type { ModelCatalog } from "@cairn/protocol/Models";
import { ProjectShell, ThreadShell } from "@cairn/protocol/Shell";
import type { SkillSummary } from "@cairn/protocol/Skills";
import { DateTime, Option } from "effect";

import { ComposerTarget, initial } from "./Model.ts";
import type { ComposerContext, Model } from "./Model.ts";
import { inform } from "./Update.ts";

const at = DateTime.makeUnsafe("2026-10-22T08:00:00Z");

/** A folder project. */
export const project: ProjectShell = ProjectShell.make({
  id: ProjectId.make("prj_cairn"),
  title: "cairn",
  kind: "folder",
  workspaceRoot: "/home/user/cairn",
  repository: Option.some("oscabriel/cairn"),
  defaultModel: Option.none(),
  createdAt: at,
  updatedAt: at,
});

/** The thread the Thread target opens. */
export const threadId = ThreadId.make("019a0000-0000-7000-8000-000000000a01");

/** A second thread, for draft separation. */
export const otherThreadId = ThreadId.make(
  "019a0000-0000-7000-8000-000000000a02"
);

/** An idle thread row in `project`. */
export const thread = (id: ThreadId = threadId): ThreadShell =>
  ThreadShell.make({
    id,
    projectId: project.id,
    title: "A thread",
    provider: "opencode-go",
    modelId: "kimi-k3",
    thinkingLevel: "medium",
    runtimeMode: "full-access",
    branch: Option.none(),
    worktreePath: Option.none(),
    activity: "idle",
    activeRunId: Option.none(),
    latestRunRequestedAt: Option.none(),
    latestRunStartedAt: Option.none(),
    latestRunCompletedAt: Option.none(),
    queueLength: 0,
    lastError: Option.none(),
    lastErrorClass: Option.none(),
    usageLimitResetAt: Option.none(),
    waitingFor: "none",
    pendingRuntimeRequest: Option.none(),
    latestVisibleMessage: Option.none(),
    latestUserMessageAt: Option.none(),
    createdAt: at,
    updatedAt: at,
    archivedAt: Option.none(),
    settledOverride: Option.none(),
    settledAt: Option.none(),
    unsettledAt: Option.none(),
    snoozedUntil: Option.none(),
    snoozedAt: Option.none(),
    pinnedAt: Option.none(),
    pinOrderKey: Option.none(),
    activeOrderKey: Option.none(),
    autoSettleDisabledAt: Option.none(),
    lastVisitedAt: Option.none(),
    parkedTaskIds: [],
  });

/** Two providers' models, the first with thinking levels. */
export const catalog: ModelCatalog = {
  models: [
    {
      provider: "opencode-go",
      modelId: "kimi-k3",
      name: "Kimi K3",
      thinkingLevels: ["off", "low", "medium", "high"],
      acceptsImages: true,
      contextWindow: Option.some(256_000),
      available: true,
    },
    {
      provider: "opencode-go",
      modelId: "glm-5",
      name: "GLM 5",
      thinkingLevels: [],
      acceptsImages: false,
      contextWindow: Option.none(),
      available: true,
    },
  ],
  defaults: {
    model: { provider: "opencode-go", modelId: "kimi-k3" },
    thinkingLevel: "medium",
  },
};

/** Skills the `$` and `/` menus list. */
export const skills: ReadonlyArray<SkillSummary> = [
  {
    name: "review",
    description: "Review a change",
    source: "user",
    modelInvocable: true,
  },
  {
    name: "deploy",
    description: "Ship the build",
    source: "project",
    modelInvocable: true,
  },
];

/** A context with the connection live, `project` and the thread row. */
export const contextFor = (target: ComposerTarget): ComposerContext => ({
  target,
  epoch: 1,
  hasClient: true,
  live: true,
  projects: [project],
  thread: ComposerTarget.match(target, {
    None: () => Option.none(),
    Home: () => Option.none(),
    Draft: () => Option.none(),
    Thread: ({ threadId: id }) => Option.some(thread(id)),
  }),
  inbox: Option.none(),
  prompts: [],
  defaults: Option.some(catalog.defaults),
  usage: Option.none(),
});

/** A composer on `target` with the catalog, skills and drafts loaded. */
export const composerOn = (target: ComposerTarget): Model =>
  inform(
    {
      ...initial,
      draftsLoaded: true,
      catalog: Option.some(catalog),
      skills: Option.some({ projectId: project.id, list: skills }),
    },
    contextFor(target)
  ).model;
