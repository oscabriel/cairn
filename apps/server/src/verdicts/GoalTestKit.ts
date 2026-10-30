// A bare pi-durable Harness with the goals extension, for the goal tests and the kill judge's brain
// (`judges/fixtures/goal-kill/GoalBrain.ts`): pi-ai's faux provider as the thread's model (under a
// provider name of the test's choosing, so its family is what the family rule reads), the thread's
// tools run in a real folder through `NodeExecutionEnv`, and the model judge answered by the test.
// Nothing here is production; production builds the extension through `Goals.layer`.

import { setTimeout as sleep } from "node:timers/promises";

import type { CriterionProposal } from "@cairn/protocol/Policy";
import type { JsonValue } from "@earendil-works/chord";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type {
  Conversation,
  EntryRecord,
  Storage,
} from "@earendil-works/pi-durable";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Option } from "effect";

import { ThreadMeta } from "../brain/CairnDocs.ts";
import type { CairnExtension } from "../brain/Extensions.ts";
import { GoalDoc, JudgeRunsDoc } from "./GoalDocs.ts";
import type { GoalState, JudgeRunsState } from "./GoalDocs.ts";
import { goalsExtension } from "./GoalTools.ts";
import type { JudgeFaults, JudgeModels } from "./JudgeRun.ts";
import { VERDICT_NOTE } from "./JudgeRun.ts";
import { bindCriteria } from "./Verdicts.ts";

/** A fresh in-memory store, for a judge outside the pi-durable folders. */
export const memoryStore = (): Storage => new MemoryStorage();

/** The thread's model in the kit: a faux model under `provider`. */
export interface KitModel {
  readonly provider: string;
  readonly modelId: string;
}

/** What one kit Harness is opened with. */
export interface KitOptions {
  readonly storage: Storage;
  readonly model: KitModel;
  /** The faux model's answers, in order; a request past the last answers "done". */
  readonly responses: ReadonlyArray<AssistantMessage>;
  readonly judges: JudgeModels;
  readonly faults: JudgeFaults;
}

/** One open kit Harness. */
export interface GoalKit {
  readonly harness: Harness;
  close(): Promise<void>;
}

/** A model turn that calls `tool` with `args`. */
export const callTool = (
  tool: string,
  args: Record<string, JsonValue>,
  id: string
): AssistantMessage =>
  fauxAssistantMessage(fauxToolCall(tool, args, { id }), {
    stopReason: "toolUse",
  });

/** A model turn that answers `text`. */
export const say = (text: string): AssistantMessage =>
  fauxAssistantMessage(text);

/** What `openKitWith` takes: the kit's options without the judges, and the extension to install. */
export type KitBase = Omit<KitOptions, "judges" | "faults">;

/** Opens a Harness over `options.storage` with `goals` installed (a live judge's, from `Goals`). */
export const openKitWith = async (
  options: KitBase,
  goals: CairnExtension,
  context: ChordContext
): Promise<GoalKit> => {
  const faux = fauxProvider({
    provider: options.model.provider,
    models: [{ id: options.model.modelId }],
  });

  faux.setResponses([
    ...options.responses,
    ...Array.from({ length: 20 }, () => say("done")),
  ]);

  const models = createModels();

  models.setProvider(faux.provider);

  const registry = createRegistry();

  registry.install(goals.extension);

  const harness = await Harness.open(
    options.storage,
    {
      models,
      registry,
      settings: { retry: { enabled: false } },
      env: (target) =>
        target.cwd === undefined
          ? undefined
          : new NodeExecutionEnv({ cwd: target.cwd }),
    },
    context
  );

  // As the brain's boot does after its repairs: a reopened store's tasks run again.
  harness.resume();

  return {
    harness,
    close: async () => {
      await harness.close(context);
    },
  };
};

/** Opens a Harness over `options.storage` with the goals extension over `options.judges`. */
export const openGoalKit = async (
  options: KitOptions,
  context: ChordContext
): Promise<GoalKit> =>
  await openKitWith(
    options,
    goalsExtension(options.judges, options.faults),
    context
  );

/** Creates a goal thread working in `cwd`, its criteria bound as the user would. */
export const createGoalThread = async (
  kit: GoalKit,
  input: {
    readonly threadId: string;
    readonly cwd: string;
    readonly model: KitModel;
    readonly objective: string;
    readonly criteria: ReadonlyArray<CriterionProposal>;
    readonly now: number;
  },
  context: ChordContext
): Promise<Conversation> => {
  const conversation = await kit.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: input.model, cwd: input.cwd },
      init: async (tx, id) => {
        const meta = await tx.doc(ThreadMeta, id);

        meta.threadId = input.threadId;
      },
    },
    context
  );

  if (input.criteria.length > 0) {
    await kit.harness.commit(async (tx) => {
      await bindCriteria(
        tx,
        conversation.id,
        {
          objective: Option.some(input.objective),
          criteria: input.criteria,
          mode: "replace",
        },
        input.now
      );
    }, context);
  }

  return conversation;
};

/** Submits `text` as the user's input and waits for the run (not the background judge runs). */
export const send = async (
  conversation: Conversation,
  text: string,
  requestId: string,
  context: ChordContext
): Promise<void> => {
  await conversation.submit(
    { type: "input", content: text, requestId },
    context
  );
  await conversation.waitForIdle(context);
};

/** The goal document as it stands. */
export const readGoal = async (
  kit: GoalKit,
  conversation: Conversation,
  context: ChordContext
): Promise<GoalState | undefined> =>
  await kit.harness.snapshot(GoalDoc, conversation.id, context);

/** The judge-run index as it stands. */
export const readRuns = async (
  kit: GoalKit,
  conversation: Conversation,
  context: ChordContext
): Promise<JudgeRunsState | undefined> =>
  await kit.harness.snapshot(JudgeRunsDoc, conversation.id, context);

/** Waits until every queued judge run has settled, polling every 20 ms up to `limitMs`. */
export const waitForJudges = async (
  kit: GoalKit,
  conversation: Conversation,
  limitMs: number,
  context: ChordContext
): Promise<boolean> => {
  const deadline = performance.now() + limitMs;

  while (performance.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling until the runs settle
    const runs = await readRuns(kit, conversation, context);
    const items = Object.values(runs?.items ?? {});

    if (items.length > 0 && items.every((item) => item.settledAt !== null)) {
      return true;
    }

    // oxlint-disable-next-line no-await-in-loop -- polling until the runs settle
    await sleep(20);
  }

  return false;
};

/** The notes the judge runs left in the transcript. */
export const verdictNotes = async (
  conversation: Conversation,
  context: ChordContext
): Promise<ReadonlyArray<EntryRecord>> => {
  const view = await conversation.context(context);

  return view.entries.filter((entry) => entry.kind === VERDICT_NOTE);
};

/** The text of every tool result in the transcript, by tool call id. */
export const toolResults = async (
  conversation: Conversation,
  context: ChordContext
): Promise<ReadonlyMap<string, string>> => {
  const view = await conversation.context(context);

  return new Map(
    view.messages.flatMap((message: Message) =>
      message.role === "toolResult"
        ? [
            [
              message.toolCallId,
              message.content
                .map((part) => (part.type === "text" ? part.text : ""))
                .join(""),
            ] as const,
          ]
        : []
    )
  );
};
