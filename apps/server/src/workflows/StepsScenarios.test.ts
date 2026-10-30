// The steps scenarios (workflows note W8, surfaces note S7): a workflow runs on a real pi-durable
// Harness over the kit's faux model (WorkflowTestKit.ts) while its launching thread is watched the
// way the thread stream watches it (the conversation plus its `cairn.workflows` document, as
// `PiDurableHarness.watch` merges them). Every revision goes through the wire projector and a
// client built on @cairn/client-logic's ThreadView applies the frames; after each frame the client
// must hold the projection of that revision, its ledger must decode whole, and the steps panel read
// from it (`WorkflowSteps.ts`) must keep the panel's rules: phases only grow and keep their order, a
// phase moves pending, running, done and never back, and a node never leaves an ended status.
// The scripted harness has no workflows, so these run on pi-durable only, as the ledger suite does.

import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import {
  deriveWorkflowGroups,
  isEndedNodeStatus,
  phaseLabel,
  workflowHeadline,
  workflowRecordsOf,
} from "@cairn/client-logic/WorkflowSteps";
import type {
  NodeStatus,
  PhaseState,
  WorkflowGroup,
} from "@cairn/client-logic/WorkflowSteps";
import { ThreadOpsItem, ThreadSnapshotItem } from "@cairn/protocol/Thread";
import { WORKFLOWS_DOCUMENT } from "@cairn/protocol/Workflows";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationView as PiConversationView } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";

import { projectView, wireProjector } from "../brain/ThreadWire.ts";
import { WorkflowsDoc } from "./WorkflowDocs.ts";
import type { WorkflowsState } from "./WorkflowDocs.ts";
import {
  KitLayer,
  kitParts,
  openKit,
  pause,
  plant,
  plantDefaults,
  runScript,
  UNRESOLVABLE_ROLE,
} from "./WorkflowTestKit.ts";
import { NO_WORKFLOW_FAULTS } from "./WorkflowTools.ts";

const context = BACKGROUND_CONTEXT;

const WF = "wf-1";

/** What the client's steps panel showed after one frame. */
interface Frame {
  readonly seq: number;
  readonly groups: ReadonlyArray<WorkflowGroup>;
}

const unwrap = <A, E>(result: Result.Result<A, E>, what: string): A => {
  assert.isTrue(Result.isSuccess(result), `${what} was refused`);

  return Result.getOrThrow(result);
};

/** One revision the watches delivered: the merged view and the brain's own ledger in it. */
interface Revision {
  readonly view: PiConversationView;
  readonly ledger: Readonly<WorkflowsState> | null;
}

/** How many nodes the brain's ledger holds. */
const ledgerNodeCount = (ledger: Readonly<WorkflowsState> | null): number => {
  let count = 0;

  for (const row of Object.values(ledger?.items ?? {})) {
    count += Object.keys(row.nodes).length;
  }

  return count;
};

/** Every node row of a group: phased, then unphased. */
const nodesOf = (group: WorkflowGroup) => [
  ...group.phases.flatMap((phase) => phase.members),
  ...group.unphasedNodes,
];

const panelNodeCount = (groups: ReadonlyArray<WorkflowGroup>) =>
  groups.flatMap(nodesOf).length;

/**
 * Runs `source` as an approved launch while watching the root thread, then replays every revision
 * the watches delivered through the wire projector into a client, checking it after each frame.
 */
const playSteps = (source: string) =>
  Effect.gen(function* () {
    const parts = yield* kitParts({
      faults: NO_WORKFLOW_FAULTS,
      hold: async () => {},
      effect: () => {},
      tokensPerSecond: 50_000,
    });

    const brain = yield* Effect.acquireRelease(
      Effect.promise(
        async () => await openKit(new MemoryStorage(), parts, context)
      ),
      (open) =>
        Effect.promise(async () => {
          await open.harness.close(context);
        })
    );

    yield* plant(brain, source, plantDefaults(WF), context);

    const revisions = yield* Effect.promise(async () => {
      const conversation = await brain.harness.conversation(
        brain.root,
        context
      );

      assert.isDefined(conversation, "the kit's root thread is missing");

      const watch = await conversation.watch(context);

      const docWatch = await brain.harness.watchDoc(
        WorkflowsDoc,
        brain.root,
        context
      );

      assert.isDefined(docWatch, "the planted ledger is not watchable");

      let latest = watch.value;
      let ledger = docWatch.value;

      // As `PiDurableHarness.watch` merges them: the newest view with the newest ledger beside it.
      const merged = (): Revision => ({
        view:
          ledger === null
            ? latest
            : {
                ...latest,
                docs: { ...latest.docs, [WORKFLOWS_DOCUMENT]: ledger },
              },
        ledger,
      });

      const seen: Array<Revision> = [merged()];

      watch.start(async (value) => {
        latest = value;
        seen.push(merged());
        await Promise.resolve();
      });

      docWatch.start(async (value) => {
        ledger = value;
        seen.push(merged());
        await Promise.resolve();
      });

      await runScript(brain, source, "run-1", context);
      await brain.harness.waitForIdle(context);

      // The node watcher may end the row after the thread is idle; wait for it.
      const until = performance.now() + 5000;

      while (performance.now() < until) {
        // oxlint-disable-next-line no-await-in-loop
        const current = await brain.harness.snapshot(
          WorkflowsDoc,
          brain.root,
          context
        );

        const row = current?.items[WF];

        if (row !== undefined && ["finished", "failed"].includes(row.state)) {
          break;
        }

        // oxlint-disable-next-line no-await-in-loop
        await pause(20);
      }

      await pause(50);
      await watch.stop();
      await docWatch.stop();

      return seen;
    });

    const projector = wireProjector();
    const [first, ...rest] = revisions;

    assert.isDefined(first);

    let client: ThreadViewState = unwrap(
      applyThreadStreamItem(
        Option.none(),
        ThreadSnapshotItem.make({
          seq: 0,
          view: unwrap(projector.snapshot(first.view), "the snapshot"),
          entriesOffset: 0,
          hasMoreHistory: false,
        })
      ),
      "the snapshot frame"
    );

    const frames: Array<Frame> = [];

    const read = (seq: number, revision: Revision) => {
      assert.deepStrictEqual(
        client.view,
        unwrap(projectView(revision.view), "the projection"),
        `frame ${String(seq)}: the client did not converge`
      );

      const groups = deriveWorkflowGroups(
        workflowRecordsOf(client.view.docs[WORKFLOWS_DOCUMENT])
      );

      assert.strictEqual(
        panelNodeCount(groups),
        ledgerNodeCount(revision.ledger),
        `frame ${String(seq)}: a node did not decode`
      );

      frames.push({ seq, groups });
    };

    read(0, first);

    for (const [index, revision] of rest.entries()) {
      const seq = index + 1;

      client = unwrap(
        applyThreadStreamItem(
          Option.some(client),
          ThreadOpsItem.make({
            seq,
            ops: unwrap(projector.advance(revision.view), "the ops"),
          })
        ),
        `frame ${String(seq)}`
      );

      read(seq, revision);
    }

    return frames;
  }).pipe(Effect.scoped, Effect.provide(KitLayer));

const PHASE_RANK: Record<PhaseState, number> = {
  pending: 0,
  running: 1,
  done: 2,
};

/** Ranks a node's status: queued, then live, then ended; an ended status is final. */
const nodeRank = (status: NodeStatus) => {
  if (status === "queued") {
    return 0;
  }

  return isEndedNodeStatus(status) ? 2 : 1;
};

/** Every rule a frame must keep against the frame before it; the broken ones, as text. */
const ruleBreaks = (frames: ReadonlyArray<Frame>): ReadonlyArray<string> => {
  const breaks: Array<string> = [];

  for (const [index, frame] of frames.entries()) {
    const previous = frames[index - 1];

    if (previous === undefined) {
      continue;
    }

    for (const before of previous.groups) {
      const now = frame.groups.find(
        (group) => group.workflow.id === before.workflow.id
      );

      if (now === undefined) {
        breaks.push(`frame ${String(frame.seq)}: ${before.workflow.id} left`);

        continue;
      }

      const titles = now.phases.map((phase) => phase.title);

      const kept = titles.filter((title) =>
        before.phases.some((phase) => phase.title === title)
      );

      if (
        kept.join("\n") !== before.phases.map((phase) => phase.title).join("\n")
      ) {
        breaks.push(
          `frame ${String(frame.seq)}: phases went from [${before.phases.map((phase) => phase.title).join(", ")}] to [${titles.join(", ")}]`
        );
      }

      for (const phase of before.phases) {
        const later = now.phases.find((next) => next.title === phase.title);

        if (
          later !== undefined &&
          PHASE_RANK[later.state] < PHASE_RANK[phase.state]
        ) {
          breaks.push(
            `frame ${String(frame.seq)}: phase ${phase.title} went from ${phase.state} to ${later.state}`
          );
        }
      }

      for (const node of nodesOf(before)) {
        const later = nodesOf(now).find(
          (next) => next.node.id === node.node.id
        );

        if (later === undefined) {
          breaks.push(
            `frame ${String(frame.seq)}: node ${node.node.label} left`
          );
        } else if (
          nodeRank(later.status) < nodeRank(node.status) ||
          (isEndedNodeStatus(node.status) && later.status !== node.status)
        ) {
          breaks.push(
            `frame ${String(frame.seq)}: node ${node.node.label} went from ${node.status} to ${later.status}`
          );
        }
      }
    }
  }

  return breaks;
};

const workflow = (phases: ReadonlyArray<string>, body: string) =>
  `export const meta = {\n  name: "steps-flow",\n  description: "A steps scenario",\n  phases: [${phases.map((title) => `{ title: "${title}" }`).join(", ")}],\n};\n${body}`;

/** The panel's phases of the one workflow on the last frame: title, state, label, settled of all. */
const lastPhases = (frames: ReadonlyArray<Frame>) =>
  (frames.at(-1)?.groups[0]?.phases ?? []).map((phase) => [
    phase.title,
    phase.state,
    phaseLabel(phase),
    `${String(phase.settledCount)}/${String(phase.members.length)}`,
  ]);

/** Whether some frame showed `title` in `state`. */
const sawPhase = (
  frames: ReadonlyArray<Frame>,
  title: string,
  state: PhaseState
) =>
  frames.some((frame) =>
    (frame.groups[0]?.phases ?? []).some(
      (phase) => phase.title === title && phase.state === state
    )
  );

describe("steps scenarios on pi-durable", () => {
  it.live(
    "steps_phased_run: phases fill in order, a run-time phase joins at the end, every node ends done",
    () =>
      Effect.gen(function* () {
        const frames = yield* playSteps(
          workflow(
            ["Gather", "Review"],
            `phase("Gather");
const found = await parallel([
  () => agent("node:g1 ms=150", { label: "g1" }),
  () => agent("node:g2 ms=100", { label: "g2" }),
  () => agent("node:g3 ms=50", { label: "g3" }),
]);
phase("Review");
const review = await agent("node:r1 ms=100", { label: "r1" });
phase("Wrap");
const wrap = await agent("node:w1", { label: "w1" });
return { found, review, wrap };`
          )
        );

        assert.deepStrictEqual(ruleBreaks(frames), []);
        assert.isAbove(frames.length, 10, "too few frames to judge");

        // The declared phases show before anything runs, the run-time one only once reached.
        assert.deepStrictEqual(
          (frames[0]?.groups[0]?.phases ?? []).map((phase) => [
            phase.title,
            phase.state,
            phaseLabel(phase),
          ]),
          [
            ["Gather", "pending", "not started"],
            ["Review", "pending", "not started"],
          ]
        );

        assert.isTrue(sawPhase(frames, "Gather", "running"));
        assert.isTrue(
          frames.some((frame) => {
            const phases = frame.groups[0]?.phases ?? [];

            return (
              phases[0]?.state === "done" &&
              phases[1]?.state === "running" &&
              phases.length === 2
            );
          }),
          "no frame showed Gather done while Review ran"
        );
        assert.isTrue(sawPhase(frames, "Wrap", "running"));

        assert.deepStrictEqual(lastPhases(frames), [
          ["Gather", "done", "done", "3/3"],
          ["Review", "done", "done", "1/1"],
          ["Wrap", "done", "done", "1/1"],
        ]);

        const group = frames.at(-1)?.groups[0];

        assert.isDefined(group);
        assert.strictEqual(group.workflow.state, "finished");
        // Parallel nodes take their index in dispatch order, which the race decides.
        const gathered = group.phases[0]?.members ?? [];

        assert.deepStrictEqual(
          gathered.map((member) => member.node.label).toSorted(),
          ["g1", "g2", "g3"]
        );
        assert.deepStrictEqual(
          gathered.map((member) => member.node.index),
          [0, 1, 2]
        );
        assert.deepStrictEqual(group.unphasedNodes, []);
        assert.deepStrictEqual(workflowHeadline(group), {
          title: "steps-flow",
          description: Option.some("A steps scenario"),
          nodes: Option.some("5 nodes · 5 done"),
        });
      })
  );

  it.live(
    "steps_failures: an unphased node, a failed node and a refused one each read as they ended",
    () =>
      Effect.gen(function* () {
        const frames = yield* playSteps(
          workflow(
            ["Try"],
            `const first = await agent("node:u1", { label: "u1" });
phase("Try");
const tried = await parallel([
  () => agent("node:t1 ms=50", { label: "t1" }),
  () => agent("node:t2 fail", { label: "t2" }),
  () => agent.full("node:t3", { label: "t3", role: "${UNRESOLVABLE_ROLE}" }),
]);
return { first, tried };`
          )
        );

        assert.deepStrictEqual(ruleBreaks(frames), []);

        assert.deepStrictEqual(lastPhases(frames), [
          ["Try", "done", "failed", "3/3"],
        ]);

        const group = frames.at(-1)?.groups[0];

        assert.isDefined(group);
        assert.deepStrictEqual(
          group.unphasedNodes.map((node) => [node.node.label, node.status]),
          [["u1", "done"]]
        );
        assert.deepStrictEqual(
          group.phases[0]?.members
            .map((member) => [member.node.label, member.status])
            .toSorted(([a], [b]) => (a ?? "").localeCompare(b ?? "")),
          [
            ["t1", "done"],
            ["t2", "failed"],
            ["t3", "refused"],
          ]
        );
        assert.deepStrictEqual(
          workflowHeadline(group).nodes,
          Option.some("4 nodes · 2 done · 1 failed · 1 refused")
        );
      })
  );
});
