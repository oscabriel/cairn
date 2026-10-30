// The crash window between a writing role's workspace and its child (docs/phase-2/notes/
// subagents.md section 10): the brief task makes the child's worktree (`ChildWorkspaces.prepare`:
// the plan row, `git worktree add`, the made flags), then creates the child in one commit. Here
// the brain dies between the two: `prepare` completes, and the task's invocation is abandoned
// before its creating commit (the brain closes while it hangs, so nothing of it commits, as after
// `kill -9`). The next boot over the same data dir and repository runs the boot repair, then
// resumes the brief task. Judged:
//
// - the repair removes the plan of the child that never landed (no `cairn.thread` receipt): no
//   worktree, branch or row, and no orphan;
// - the resumed task starts the child once, in the worktree the first `prepare` named (its path and
//   branch come from the child's thread id, minted from the brief's answer), which git lists once,
//   with one plan row and no orphan.
//
// Kept under `brain/`, where pi-durable may be imported in a test (S42).

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ApprovalId,
  ConversationId as ConversationIdOf,
  ProjectId,
  ThreadId,
} from "@cairn/protocol/Ids";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Ref,
  Result,
  Scope,
  Stream,
} from "effect";

import { ExecutorLink } from "../executor/ExecutorLink.ts";
import { Git } from "../git/Git.ts";
import { ModelHealth } from "../models/ModelHealth.ts";
import { PiModelSource } from "../models/PiModelSource.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { PiHost } from "../pi-host/PiHost.ts";
import { ReachServicesTest } from "../reach/ReachLayer.ts";
import { ChildDoc, SubagentsDoc } from "../subagents/SubagentDocs.ts";
import {
  Subagents,
  subagentsExtension,
  workspaceAccess,
} from "../subagents/Subagents.ts";
import type { ChildWorkspaceAccess } from "../subagents/SubagentTasks.ts";
import { DEFAULT_TOOL_OPTIONS } from "../subagents/SubagentTools.ts";
import { ChildWorkspaces } from "../workspaces/ChildWorkspaces.ts";
import type { PreparedChildWorkspace } from "../workspaces/ChildWorkspaces.ts";
import {
  cairnWorktrees,
  hasBranch,
  makeRepo,
  orphansOf,
  workspacesAt,
} from "../workspaces/ChildWorkspacesTestKit.ts";
import { ChildWorkspaceStore } from "../workspaces/ChildWorkspaceStore.ts";
import { Brain } from "./Brain.ts";
import { BrainConfig } from "./BrainConfig.ts";
import { repairChildWorkspacesAtBoot } from "./ChildWorkspaceRepair.ts";
import { durable } from "./Durable.ts";
import { ExtensionSet } from "./ExtensionSet.ts";
import { FauxModels } from "./FauxModels.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import type { HarnessEvent } from "./HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "./ModelSource.ts";
import { PiDurableHarness } from "./PiDurableHarness.ts";
import { piConversationId } from "./PiIds.ts";
import { NO_SUBAGENT_FAULTS } from "./SubagentFaults.ts";

/** The parent's thread. */
const PARENT = ThreadId.make("0190f0c0-0000-7000-8000-000000000170");

/** The first boot's answers: the parent's spawn of a writing role, and its answer while it waits. */
const SPAWN_RESPONSES = [
  fauxAssistantMessage(
    fauxToolCall(
      "subagent_spawn",
      {
        description: "Fix the readme",
        brief: "Fix the typo in README.md.",
        isolation: "worktree",
      },
      { id: "call_1" }
    ),
    { stopReason: "toolUse" }
  ),
  fauxAssistantMessage("Waiting for Go."),
];

/** The second boot's answers: the child's, then the parent's once woken. */
const RESUMED_RESPONSES = [
  fauxAssistantMessage("Fixed."),
  fauxAssistantMessage("Noted."),
];

/** Polls `find` until it finds something, for up to ten seconds. */
const waitFor = <A, E, R>(find: Effect.Effect<Option.Option<A>, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = yield* find;

      if (Option.isSome(found)) {
        return found.value;
      }

      yield* Effect.sleep(Duration.millis(50));
    }

    return yield* Effect.die("waited ten seconds for nothing");
  });

/** The first event `pick` accepts, waited for. */
const eventWhere = <A>(
  events: Ref.Ref<ReadonlyArray<HarnessEvent>>,
  pick: (event: HarnessEvent) => Option.Option<A>
) =>
  waitFor(
    Effect.map(Ref.get(events), (all) => Option.firstSomeOf(all.map(pick)))
  );

/**
 * A pi-durable brain over `dataDir` (its `brain.sqlite`) whose subagents make children's workspaces
 * through `access`, and the workspaces over `<dataDir>/cairn.sqlite`: building it again over the
 * same dir is the next boot.
 */
const brainAt = (
  dataDir: string,
  access: (workspaces: ChildWorkspaceAccess) => ChildWorkspaceAccess
) =>
  PiDurableHarness.layer.pipe(
    Layer.provide(
      ExtensionSet.layer.pipe(
        Layer.provide(
          Layer.effect(
            Subagents,
            Effect.gen(function* () {
              const workspaces = workspaceAccess(
                yield* ChildWorkspaces,
                yield* Effect.context()
              );

              return Subagents.of({
                extension: subagentsExtension(
                  NO_SUBAGENT_FAULTS,
                  access(workspaces),
                  DEFAULT_TOOL_OPTIONS
                ),
              });
            })
          )
        ),
        Layer.provide(ExecutorLink.layerDisabled),
        Layer.provide(PiHost.layerEmpty),
        Layer.provide(ModelHealth.layerTest),
        Layer.provide(SettingsStore.layerTest),
        Layer.provide(ReachServicesTest),
        Layer.provide(PiModelSource.layerFromModelSource)
      )
    ),
    Layer.provideMerge(
      ModelSource.layerFaux({
        tokensPerSecond: 4000,
        settings: { retry: { enabled: false } },
      })
    ),
    Layer.provideMerge(workspacesAt(dataDir)),
    Layer.provide(BrainConfig.layerFrom(dataDir))
  );

/** A brain's events, collected from its seam for the rest of the scope. */
const collect = Effect.gen(function* () {
  const seam = yield* HarnessSeam;
  const events = yield* Ref.make<ReadonlyArray<HarnessEvent>>([]);

  yield* seam.events.pipe(
    Stream.runForEach((event) => Ref.update(events, (all) => [...all, event])),
    Effect.forkScoped
  );

  return events;
});

/** The children a brain's events say it created. */
const childrenIn = (events: ReadonlyArray<HarnessEvent>) =>
  events.flatMap((event) =>
    Predicate.isTagged(event, "ThreadEnsured") && Option.isSome(event.parent)
      ? [event]
      : []
  );

describe("a crash between a child's worktree and its creating commit", () => {
  it.live(
    "the boot repair leaves no orphan, and the resumed brief starts the child once in that worktree",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          realpathSync(mkdtempSync(path.join(tmpdir(), "cairn-crash-")))
        ),
        (dir) =>
          Effect.gen(function* () {
            const repo = yield* makeRepo(dir);
            const dataDir = path.join(dir, "data");

            const prepared =
              yield* Deferred.make<
                Result.Result<PreparedChildWorkspace, string>
              >();

            // The first boot's `prepare` completes, then its invocation hangs until the brain has
            // closed: its creating commit never lands.
            const letGo = yield* Deferred.make<never, Error>();
            const run = Effect.runPromiseWith(Context.empty());

            const crashAfterPrepare = (
              workspaces: ChildWorkspaceAccess
            ): ChildWorkspaceAccess => ({
              prepare: async (input) => {
                const result = await workspaces.prepare(input);

                await run(Deferred.succeed(prepared, result));

                return await run(Deferred.await(letGo));
              },
            });

            // The first boot: the parent spawns, the user says Go, the workspace is made, and the
            // brain dies before the child exists.
            const scope = yield* Scope.make();

            const first = yield* Effect.gen(function* () {
              const context = yield* Layer.buildWithScope(
                brainAt(dataDir, crashAfterPrepare),
                scope
              );

              return yield* Effect.gen(function* () {
                const seam = yield* HarnessSeam;
                const brain = yield* Brain;
                const { faux } = yield* FauxModels;
                const events = yield* collect;

                faux.setResponses([...SPAWN_RESPONSES]);

                yield* brain.resume;

                yield* seam.ensureThread({
                  threadId: PARENT,
                  projectId: ProjectId.make("crash"),
                  model: FAUX_MODEL,
                  thinkingLevel: "off",
                  cwd: repo,
                  instructions: Option.none(),
                  runtimeMode: "full-access",
                });

                yield* seam.submit(PARENT, {
                  requestId: "r1",
                  content: [{ type: "text", text: "delegate it" }],
                  entry: Option.none(),
                  whenBusy: "followUp",
                });

                const brief = yield* eventWhere(events, (event) =>
                  Predicate.isTagged(event, "RuntimeRequestUpdated") &&
                  event.kind === "brief" &&
                  event.status === "pending"
                    ? Option.some(event.id)
                    : Option.none()
                );

                yield* seam.respond(PARENT, ApprovalId.make(brief), {
                  decision: "accept",
                  reason: Option.none(),
                  answers: Option.none(),
                  launch: Option.none(),
                });

                const made = Result.getOrThrow(yield* Deferred.await(prepared));

                return {
                  made,
                  children: childrenIn(yield* Ref.get(events)).length,
                };
              }).pipe(Effect.provideContext(context));
            }).pipe(Effect.orDie);

            // The brain closes with the invocation still hanging: its Session is sealed first, so
            // the invocation, let go once the close has begun, commits nothing.
            yield* Effect.forkChild(
              Effect.sleep(Duration.millis(200)).pipe(
                Effect.andThen(
                  Deferred.fail(
                    letGo,
                    new Error("abandoned at the crash point")
                  )
                )
              )
            );
            yield* Scope.close(scope, Exit.void);

            const worktree = Option.getOrThrow(first.made.worktree);

            assert.strictEqual(first.children, 0);

            // The next boot: the repair runs before the Harness resumes, then the brief task reruns.
            yield* Effect.gen(function* () {
              const context = yield* Layer.build(
                brainAt(dataDir, (workspaces) => workspaces)
              );

              yield* Effect.gen(function* () {
                const brain = yield* Brain;
                const { faux } = yield* FauxModels;
                const store = yield* ChildWorkspaceStore;
                const events = yield* collect;

                faux.setResponses([...RESUMED_RESPONSES]);

                // What the crash left: the made worktree and its plan, for a child that does not exist.
                assert.deepStrictEqual(yield* cairnWorktrees(repo, dataDir), [
                  first.made.cwd,
                ]);
                assert.strictEqual((yield* store.listOpen).length, 1);

                yield* repairChildWorkspacesAtBoot;

                // The child never landed: its plan, worktree and branch are gone, and nothing is
                // left that no plan accounts for.
                assert.deepStrictEqual(yield* store.listOpen, []);
                assert.deepStrictEqual(
                  yield* cairnWorktrees(repo, dataDir),
                  []
                );
                assert.isFalse(yield* hasBranch(repo, worktree.branch));
                assert.deepStrictEqual(yield* orphansOf(repo, dataDir), []);

                yield* brain.resume;

                const child = yield* eventWhere(events, (event) =>
                  Predicate.isTagged(event, "ThreadEnsured") &&
                  Option.isSome(event.parent)
                    ? Option.some(event)
                    : Option.none()
                );

                yield* eventWhere(events, (event) =>
                  Predicate.isTagged(event, "SubagentUpdated") &&
                  event.child === child.threadId &&
                  event.status === "settled"
                    ? Option.some(true)
                    : Option.none()
                );

                const { harness } = yield* brain.session;

                const record = yield* durable("test.read", async (read) => {
                  const conversation = piConversationId(child.conversationId);

                  const link = await harness.snapshot(
                    ChildDoc,
                    conversation,
                    read
                  );

                  const registry = await harness.snapshot(
                    SubagentsDoc,
                    piConversationId(
                      ConversationIdOf.make(link?.parentConversationId ?? 0)
                    ),
                    read
                  );

                  return Object.values(registry?.items ?? {});
                });

                // One child, started in the worktree the first boot's `prepare` named.
                assert.strictEqual(
                  childrenIn(yield* Ref.get(events)).length,
                  1
                );
                assert.strictEqual(record.length, 1);
                assert.strictEqual(record[0]?.worktree?.path, worktree.path);
                assert.strictEqual(
                  record[0]?.worktree?.branch,
                  worktree.branch
                );

                // Git lists that worktree once, one plan row holds it, and nothing is orphaned.
                assert.deepStrictEqual(yield* cairnWorktrees(repo, dataDir), [
                  worktree.path,
                ]);

                const rows = yield* store.listOpen;

                assert.strictEqual(rows.length, 1);
                assert.strictEqual(rows[0]?.worktreePath, worktree.path);
                assert.deepStrictEqual(yield* orphansOf(repo, dataDir), []);
              }).pipe(Effect.provideContext(context));
            }).pipe(Effect.scoped, Effect.orDie);
          }).pipe(
            Effect.provide(Layer.mergeAll(Git.layer, NodeServices.layer))
          ),
        (dir) =>
          Effect.sync(() => {
            rmSync(dir, { recursive: true, force: true });
          })
      ),
    60_000
  );
});
