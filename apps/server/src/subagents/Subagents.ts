// The subagents extension (`cairn.subagents`, ADR 0028): a subagent is a thread with a hidden row
// and a lineage, owned by a background anchor of its parent; its result reaches the parent as a
// note and the wake is a separate input. One extension carries the seven tools (SubagentTools.ts)
// and the anchor, brief and reporter tasks (SubagentTasks.ts), installed once with every thread,
// so pending reporters resume after a restart.
//
// The pieces outside pi-durable's tools and tasks live with the seam: a user's steer typed into a
// child gets its quiet reporter from `steerReporter` (PiDurableHarness.submit), an answer settles a
// question's mirror in `answerApproval` (CairnDocs.ts), a child's mode is narrowed by its
// ancestors' in `readPermissions` (Permissions.ts), and Stop all stops each working child.

import { copyJson } from "@earendil-works/chord";
import type {
  AgentChange,
  ConversationId,
  InputSubmissionDraft,
  Session,
} from "@earendil-works/pi-durable";
import { defineExtension, LiveDoc } from "@earendil-works/pi-durable";
import { Context, Effect, Layer } from "effect";

import { durable } from "../brain/Durable.ts";
import type { DurableCallError } from "../brain/Durable.ts";
import type { CairnExtension } from "../brain/Extensions.ts";
import { NO_SUBAGENT_FAULTS, SubagentFaults } from "../brain/SubagentFaults.ts";
import type { SubagentFaultSet } from "../brain/SubagentFaults.ts";
import { conversationOf } from "./Delivery.ts";
import { ChildDoc, isLinked, SubagentsDoc } from "./SubagentDocs.ts";
import { inputPartsOf, subagentTaskSet } from "./SubagentTasks.ts";
import type { SubagentTasks } from "./SubagentTasks.ts";
import {
  childAgentOf,
  DEFAULT_TOOL_OPTIONS,
  subagentToolSet,
} from "./SubagentTools.ts";
import type { SubagentToolOptions } from "./SubagentTools.ts";

/** The extension's name in pi-durable's registry. */
export const SUBAGENTS_EXTENSION = "cairn.subagents";

/**
 * Where the extension installs: after Executor (600), before the bridge's cwd (700). Until the
 * integrator adds `subagents: 650` to `ExtensionOrder`, the key lives here.
 */
export const SUBAGENTS_ORDER = 650;

/** The child's agent change, filled once the tools exist. */
interface ChildAgentHolder {
  agent: (typed: boolean) => AgentChange;
}

/** The tools and tasks with `faults` planted, as one extension. */
const build = (faults: SubagentFaultSet, tuning: SubagentToolOptions) => {
  // The child's agent change names the tools, and the tools create the tasks, so the tasks read
  // the change through this holder, filled once the tools exist and before any task can run.
  const child: ChildAgentHolder = { agent: () => ({}) };

  const tasks: SubagentTasks = subagentTaskSet({
    faults,
    childAgent: (typed) => child.agent(typed),
    settleDelayMillis: tuning.settleDelayMillis,
  });

  const tools = subagentToolSet(faults, tasks, tuning);

  child.agent = childAgentOf(tools);

  return {
    tasks,
    extension: defineExtension({
      name: SUBAGENTS_EXTENSION,
      tools: [...tools.parent, ...tools.child],
      tasks: [tasks.Anchor, tasks.Brief, tasks.Reporter],
    }),
  };
};

/**
 * The subagents extension with `faults` planted; the conformance suite's mutation check uses it,
 * and a test that needs a question to expire soon passes `tuning`.
 */
export const subagentsExtension = (
  faults: SubagentFaultSet,
  tuning: SubagentToolOptions = DEFAULT_TOOL_OPTIONS
): CairnExtension => ({
  order: SUBAGENTS_ORDER,
  extension: build(faults, tuning).extension,
});

/**
 * The task definitions host code creates tasks from. pi-durable runs a task by its registered name,
 * so the installed extension's code runs it, faults included.
 */
const hostTasks = build(NO_SUBAGENT_FAULTS, DEFAULT_TOOL_OPTIONS).tasks;

/**
 * Gives a user's input to a subagent its reporter before it is submitted (ADR 0028): the input's
 * result then reaches the parent as a quiet note. Keyed by the input's request id in the child's
 * registry item, so a resend lands once. The reporter carries the whole draft (its text and images,
 * its entry, its `whenBusy`) and submits under the same request id, so whichever submits first
 * admits the same input and the other gets that submission back, a crash between this commit and
 * the seam's submit included. A `reject` input to a busy child gets no reporter: the seam's submit
 * refuses it with `thread_busy`, and a reporter that still finds the child busy drops its input.
 * Nothing for a thread that is not a subagent.
 */
export const steerReporter = (
  session: Pick<Session, "commit" | "snapshot">,
  conversationId: ConversationId,
  input: InputSubmissionDraft
): Effect.Effect<void, DurableCallError> =>
  durable("subagents.steer", async (context) => {
    const link = await session.snapshot(ChildDoc, conversationId, context);
    const { requestId } = input;

    if (!isLinked(link) || requestId === undefined) {
      return;
    }

    const parent = conversationOf(link.parentConversationId);

    await session.commit(async (tx) => {
      const registry = await tx.doc(SubagentsDoc, parent);
      const item = registry.items[link.key];

      if (item === undefined || item.inputs[requestId] !== undefined) {
        return;
      }

      const live = await tx.doc(LiveDoc, conversationId);

      if (input.whenBusy === "reject" && live.run !== undefined) {
        return;
      }

      const taskId = await tx.createTask(
        hostTasks.Reporter,
        {
          key: link.key,
          child: conversationId,
          childThreadId: item.threadId,
          requestId,
          content: inputPartsOf(input.content),
          entry:
            input.entry === undefined
              ? null
              : {
                  kind: input.entry.kind,
                  data:
                    input.entry.data === undefined
                      ? null
                      : copyJson(input.entry.data),
                },
          whenBusy: input.whenBusy ?? "followUp",
          quiet: true,
        },
        {
          ownership: { kind: "conversation" },
          background: true,
          conversationId: parent,
        }
      );

      item.inputs[requestId] = taskId;
      item.status = "working";
    }, context);
  });

/** The subagents extension, as the installed set takes it (ExtensionSet.ts). */
export class Subagents extends Context.Service<
  Subagents,
  {
    /** The extension, for the installed set. */
    readonly extension: CairnExtension;
  }
>()("cairn/server/subagents/Subagents") {
  /** The extension with the faults `SubagentFaults` names: none, unless a test plants some. */
  static readonly layer = Layer.effect(
    Subagents,
    Effect.gen(function* () {
      const faults = yield* SubagentFaults;

      return Subagents.of({ extension: subagentsExtension(faults) });
    })
  );
}
