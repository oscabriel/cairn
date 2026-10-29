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
  Tx,
} from "@earendil-works/pi-durable";
import { defineExtension, LiveDoc } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Option, Predicate, Result } from "effect";

import { BriefTtl } from "../brain/BriefTtl.ts";
import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { durable } from "../brain/Durable.ts";
import type { DurableCallError } from "../brain/Durable.ts";
import { ExtensionOrder } from "../brain/Extensions.ts";
import type { CairnExtension } from "../brain/Extensions.ts";
import { NO_SUBAGENT_FAULTS, SubagentFaults } from "../brain/SubagentFaults.ts";
import type { SubagentFaultSet } from "../brain/SubagentFaults.ts";
import { ModelHealth } from "../models/ModelHealth.ts";
import { RoleAliases } from "../models/RoleAliases.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { ChildWorkspaces } from "../workspaces/ChildWorkspaces.ts";
import { listParent } from "./BrainCap.ts";
import { BriefFaults, NO_BRIEF_FAULTS } from "./BriefFaults.ts";
import type { BriefFaultHooks } from "./BriefFaults.ts";
import { conversationOf } from "./Delivery.ts";
import { ChildDoc, isLinked, SubagentsDoc } from "./SubagentDocs.ts";
import { inputPartsOf, subagentTaskSet } from "./SubagentTasks.ts";
import type {
  ChildWorkspaceAccess,
  RoleAccess,
  SubagentTasks,
} from "./SubagentTasks.ts";
import {
  childAgentOf,
  DEFAULT_TOOL_OPTIONS,
  subagentToolSet,
} from "./SubagentTools.ts";
import type { SubagentToolOptions } from "./SubagentTools.ts";

/** The extension's name in pi-durable's registry. */
export const SUBAGENTS_EXTENSION = "cairn.subagents";

/** The child's agent change, filled once the tools exist. */
interface ChildAgentHolder {
  agent: (typed: boolean) => AgentChange;
}

/**
 * `ChildWorkspaces.prepare` for the start task, which runs outside Effect: the child's cwd and
 * worktree, or the error's words for the parent. It runs with `context`, the layer's (S43), so the
 * faults a test plants (`ChildWorkspaceFaults`) and the tracer reach it.
 */
export const workspaceAccess = (
  workspaces: ChildWorkspaces["Service"],
  context: Context.Context<never>
): ChildWorkspaceAccess => {
  const run = Effect.runPromiseWith(context);

  return {
    prepare: async (input) =>
      await run(
        workspaces
          .prepare(input)
          .pipe(
            Effect.result,
            Effect.map(Result.mapError((error) => error.message))
          )
      ),
  };
};

/**
 * `RoleAliases.resolve` for the spawn and the start task, which run outside Effect: the resolution,
 * or why not, in the error's words for the parent. A `RoleError` is final (nothing ready answers to
 * the spec); `RoleAliasesUnavailable` is a read that failed and says nothing about the role, so it
 * is marked `retry`. It runs with `context`, the layer's (S43).
 */
export const roleAccess = (
  roles: RoleAliases["Service"],
  context: Context.Context<never>
): RoleAccess => {
  const run = Effect.runPromiseWith(context);

  return {
    resolve: async (spec) =>
      await run(
        roles.resolve(spec, Option.none()).pipe(
          Effect.result,
          Effect.map(
            Result.mapError((error) => ({
              retry: Predicate.isTagged(error, "RoleAliasesUnavailable"),
              why: error.message,
            }))
          )
        )
      ),
  };
};

/** No roles: a brief that names one starts nothing. For tests whose briefs name none. */
const NO_ROLES: RoleAccess = {
  resolve: async () =>
    await Promise.resolve(
      Result.fail({
        retry: false,
        why: "This brain resolves no roles; leave role out.",
      })
    ),
};

/** No workspaces: for the host's copy of the task definitions, whose start task never runs. */
const NO_WORKSPACES: ChildWorkspaceAccess = {
  prepare: async () =>
    await Promise.resolve(
      Result.fail("This copy of the subagent tasks makes no workspaces.")
    ),
};

/** The tools and tasks with `faults` planted, as one extension. */
const build = (
  faults: SubagentFaultSet,
  tuning: SubagentToolOptions,
  workspaces: ChildWorkspaceAccess,
  briefFaults: BriefFaultHooks,
  roles: RoleAccess
) => {
  // The child's agent change names the tools, and the tools create the tasks, so the tasks read
  // the change through this holder, filled once the tools exist and before any task can run.
  const child: ChildAgentHolder = { agent: () => ({}) };

  const tasks: SubagentTasks = subagentTaskSet({
    faults,
    childAgent: (typed) => child.agent(typed),
    workspaces,
    settleDelayMillis: tuning.settleDelayMillis,
    briefFaults,
    roles,
    maxLivePerBrain: tuning.maxLivePerBrain,
  });

  const tools = subagentToolSet(faults, tasks, roles, tuning);

  child.agent = childAgentOf(tools);

  return {
    tasks,
    extension: defineExtension({
      name: SUBAGENTS_EXTENSION,
      tools: [...tools.parent, ...tools.child],
      tasks: [
        tasks.Anchor,
        tasks.Brief,
        tasks.StartChild,
        tasks.BriefTell,
        tasks.Reporter,
      ],
    }),
  };
};

/**
 * The subagents extension with `faults` planted, making children's workspaces with `workspaces`;
 * the conformance suite's mutation check uses it, and a test that needs a question to expire soon
 * passes `tuning`.
 */
export const subagentsExtension = (
  faults: SubagentFaultSet,
  workspaces: ChildWorkspaceAccess,
  tuning: SubagentToolOptions = DEFAULT_TOOL_OPTIONS,
  briefFaults: BriefFaultHooks = NO_BRIEF_FAULTS,
  roles: RoleAccess = NO_ROLES
): CairnExtension => ({
  order: ExtensionOrder.subagents,
  extension: build(faults, tuning, workspaces, briefFaults, roles).extension,
});

/**
 * The task definitions host code creates tasks from. pi-durable runs a task by its registered name,
 * so the installed extension's code runs it, faults included.
 */
const hostTasks = build(
  NO_SUBAGENT_FAULTS,
  DEFAULT_TOOL_OPTIONS,
  NO_WORKSPACES,
  NO_BRIEF_FAULTS,
  NO_ROLES
).tasks;

/**
 * What a brief's answer starts, for the answering commit (`answerApproval`'s `answered` hook,
 * passed by `PiDurableHarness.respond`): Go creates the child's start task in the same transaction
 * that accepts the brief (ADR 0030), and Decline or Send back the task that tells the parent.
 * Nothing for any other record. `faults` is where a judge brain kills itself inside that commit;
 * the tasks themselves run the installed extension's code, which carries its own.
 */
export const answerBrief =
  (faults: BriefFaultHooks) =>
  async (
    tx: Tx,
    parent: ConversationId,
    record: ApprovalRecord
  ): Promise<void> => {
    await hostTasks.briefAnswered(tx, parent, record);
    faults.at("go-commit");
  };

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

      // A settled child works again: its parent is listed for the brain's count.
      await listParent(tx, parent);

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
  /**
   * The extension with `faults` planted and `tuning`, for a test brain (the conformance suite's
   * `piDurableLayer`) once the production set carries `Subagents`.
   */
  static readonly layerWith = (
    faults: SubagentFaultSet,
    tuning: SubagentToolOptions = DEFAULT_TOOL_OPTIONS
  ) =>
    Layer.effect(
      Subagents,
      Effect.gen(function* () {
        const workspaces = workspaceAccess(
          yield* ChildWorkspaces,
          yield* Effect.context()
        );

        return Subagents.of({
          extension: subagentsExtension(
            faults,
            workspaces,
            tuning,
            yield* BriefFaults,
            roleAccess(yield* RoleAliases, yield* Effect.context())
          ),
        });
      })
    ).pipe(Layer.provide(RoleAliases.layerNoDeps));

  /**
   * The extension with the faults `SubagentFaults` and `BriefFaults` name (none, unless a test or a
   * judge brain plants some) and briefs that live as long as `BriefTtl` says (a week), making
   * children's worktrees with `ChildWorkspaces`.
   */
  static readonly layer = Layer.effect(
    Subagents,
    Effect.gen(function* () {
      const faults = yield* SubagentFaults;
      const briefFaults = yield* BriefFaults;
      const briefTtlMillis = yield* BriefTtl;

      const workspaces = workspaceAccess(
        yield* ChildWorkspaces,
        yield* Effect.context()
      );

      return Subagents.of({
        extension: subagentsExtension(
          faults,
          workspaces,
          { ...DEFAULT_TOOL_OPTIONS, briefTtlMillis },
          briefFaults,
          roleAccess(yield* RoleAliases, yield* Effect.context())
        ),
      });
    })
  ).pipe(Layer.provide(RoleAliases.layerNoDeps));

  /**
   * For tests that build the production extension set: no faults, children's workspaces under a
   * fresh temporary data folder (`ChildWorkspaces.layerTest`), and roles resolved over the test
   * settings and health (`SettingsStore.layerTest`, `ModelHealth.layerTest`, the references such
   * a test gives the extension set too, so it builds one of each) and the test's models.
   */
  static readonly layerTest = Subagents.layer.pipe(
    Layer.provide(ChildWorkspaces.layerTest),
    Layer.provide(SettingsStore.layerTest),
    Layer.provide(ModelHealth.layerTest)
  );
}
