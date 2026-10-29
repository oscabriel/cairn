// The judge brain of `judges/brief-go.sh` (ADR 0030): Cairn's production seam, brain and extension
// set (the subagents extension with its Go commit, start, tell and expiry tasks) over pi-ai's faux
// provider, a scratch data folder (its own `brain.sqlite` and `cairn.sqlite`, never the deployed
// unit's) and a scratch git repository. Each run of this script is one life of the brain: it boots
// (the production repairs that touch approvals, parked tasks and child workspaces, in
// `BootRepairs.ts`'s order, then the Harness resumes), does its step, waits for the brief to come to rest, prints its report as
// the last stdout line and exits. The orchestrator kills it, or it kills itself at a planted
// window, and runs the next life over the same folder.
//
//   node judges/fixtures/brief-go/GoBrain.ts --dir <run> --step <step> [--fault <point> --times N]
//
// Steps:
// - `spawn`: the parent asks for a brief (a writing role, so Go makes a worktree); ends once the
//   brief is pending and the parent's run is over. `--die` then kills the brain before any answer.
//   `--second` asks for a second brief in the same answer, left pending for the whole run, so the
//   parent always has a pending approval (the case the approval-wait boot repair acts on).
// - `go`, `decline`: the user answers the brief.
// - `race`: Go, Decline and Go at once, from three callers.
// - `split`: the broken control. It answers Go with a plain answer that creates nothing, then
//   kills itself before a second commit would have created the start task: what ADR 0030's one
//   commit rules out. The judge must fail on what it leaves.
// - `boot`: boots and waits; nothing else.
// - `retry`: retries the parked start task, as the parent's Retry would.
//
// `--fault <point>` (`BriefFaultPoint`) kills the brain with SIGKILL at that window of the Go, at
// most `--times` times across lives (counted in `<run>/fault-count`), so the next life runs clean.
//
// The report counts what the judge asserts on: the record's status and `started`, Cairn worktrees
// git lists for the repository, open workspace plans, child conversations linked to the brief,
// user inputs each child holds, answers delivered to the parent, and the start tasks with their
// states. No network, no model spend.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ApprovalId, ProjectId, ThreadId } from "@cairn/protocol/Ids";
import type {
  AssistantMessage,
  Message,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Console,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";

import { retryParkedApprovalWaits } from "../../../apps/server/src/Boot.ts";
import { Brain } from "../../../apps/server/src/brain/Brain.ts";
import { BrainConfig } from "../../../apps/server/src/brain/BrainConfig.ts";
import {
  answerApproval,
  Approvals,
  cancelAbandonedApprovalsAtBoot,
} from "../../../apps/server/src/brain/CairnDocs.ts";
import { repairChildWorkspacesAtBoot } from "../../../apps/server/src/brain/ChildWorkspaceRepair.ts";
import { messageText } from "../../../apps/server/src/brain/CommitFeed.ts";
import { durable } from "../../../apps/server/src/brain/Durable.ts";
import { ExtensionSet } from "../../../apps/server/src/brain/ExtensionSet.ts";
import { FauxModels } from "../../../apps/server/src/brain/FauxModels.ts";
import { HarnessSeam } from "../../../apps/server/src/brain/HarnessSeam.ts";
import {
  FAUX_MODEL,
  ModelSource,
} from "../../../apps/server/src/brain/ModelSource.ts";
import { PiDurableHarness } from "../../../apps/server/src/brain/PiDurableHarness.ts";
import { piConversationId } from "../../../apps/server/src/brain/PiIds.ts";
import { BRIEF_ANSWER_ENTRY } from "../../../apps/server/src/brain/SubagentText.ts";
import { ExecutorLink } from "../../../apps/server/src/executor/ExecutorLink.ts";
import { Git } from "../../../apps/server/src/git/Git.ts";
import { ModelHealth } from "../../../apps/server/src/models/ModelHealth.ts";
import { PiModelSource } from "../../../apps/server/src/models/PiModelSource.ts";
import { SettingsStore } from "../../../apps/server/src/models/SettingsStore.ts";
import { PiHost } from "../../../apps/server/src/pi-host/PiHost.ts";
import { ReachServicesTest } from "../../../apps/server/src/reach/ReachLayer.ts";
import {
  BriefFaultPoint,
  BriefFaults,
} from "../../../apps/server/src/subagents/BriefFaults.ts";
import type { BriefFaultHooks } from "../../../apps/server/src/subagents/BriefFaults.ts";
import {
  ChildDoc,
  isLinked,
} from "../../../apps/server/src/subagents/SubagentDocs.ts";
import { retryParkedSubagentTasks } from "../../../apps/server/src/subagents/SubagentRepairs.ts";
import { Subagents } from "../../../apps/server/src/subagents/Subagents.ts";
import { START_TASK } from "../../../apps/server/src/subagents/SubagentTasks.ts";
import {
  cairnWorktrees,
  workspacesAt,
} from "../../../apps/server/src/workspaces/ChildWorkspacesTestKit.ts";
import { ChildWorkspaceStore } from "../../../apps/server/src/workspaces/ChildWorkspaceStore.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    step: { type: "string", default: "boot" },
    fault: { type: "string" },
    times: { type: "string", default: "1" },
    die: { type: "boolean", default: false },
    second: { type: "boolean", default: false },
    wait: { type: "string", default: "30" },
  },
});

const dir = path.resolve(values.dir ?? ".");

const dataDir = path.join(dir, "data");

const repo = path.join(dir, "repo");

/** Where the spawn life writes the brief's approval id for the lives after it. */
const briefFile = path.join(dir, "brief-id");

/** How many times the planted fault has fired, over every life of the run. */
const faultCount = path.join(dir, "fault-count");

/** The parent thread every life works on. */
const PARENT = ThreadId.make("0190f0c0-0000-7000-8000-0000000b71e0");

/** The parent's request. */
const DELEGATE = "delegate it";

/** The brief's title, its child's first line. */
const TITLE = "Fix the readme";

/** The second brief's title (`--second`), never answered. */
const SECOND_TITLE = "Tidy the changelog";

/**
 * How long a life waits for the brief to come to rest before it reports anyway (`--wait`, in
 * seconds): a life that must find nothing happening waits a few seconds, not thirty.
 */
const REST_TIMEOUT = Duration.seconds(Number(values.wait));

// ── Faults ───────────────────────────────────────────────────────────────────────────────────────

const decodePoint = Schema.decodeUnknownOption(BriefFaultPoint);

const firedSoFar = () =>
  existsSync(faultCount) ? Number(readFileSync(faultCount, "utf-8")) : 0;

/** Kills this life at `--fault`, at most `--times` times over every life of the run. */
const judgeFaults = (
  spec: string | undefined,
  times: number
): BriefFaultHooks => {
  const target = decodePoint(spec);

  return {
    at: (point) => {
      if (Option.isNone(target) || point !== target.value) {
        return;
      }

      const fired = firedSoFar();

      if (fired >= times) {
        return;
      }

      writeFileSync(faultCount, String(fired + 1));
      process.stdout.write(`${JSON.stringify({ event: "fault", point })}\n`);
      process.kill(process.pid, "SIGKILL");
    },
  };
};

// ── The model ────────────────────────────────────────────────────────────────────────────────────

const firstUserText = (messages: ReadonlyArray<Message>) => {
  const first = messages.find((message) => message.role === "user");

  return first === undefined ? "" : messageText(first);
};

/**
 * The parent asks for a writing child on its first request, then acknowledges whatever it is
 * told; the child answers its brief at once.
 */
const answer = (request: TranscriptContext): AssistantMessage => {
  const first = firstUserText(request.messages);

  if (first.startsWith(TITLE)) {
    return fauxAssistantMessage("Fixed the typo.");
  }

  const asked = request.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some((part) => part.type === "toolCall")
  );

  const spawnCall = fauxToolCall(
    "subagent_spawn",
    {
      description: TITLE,
      brief: "Fix the typo in README.md.",
      isolation: "worktree",
    },
    { id: "call_spawn" }
  );

  const secondCall = fauxToolCall(
    "subagent_spawn",
    {
      description: SECOND_TITLE,
      brief: "Sort the changelog's entries by date.",
      isolation: "worktree",
    },
    { id: "call_spawn_second" }
  );

  return asked
    ? fauxAssistantMessage("Noted.")
    : fauxAssistantMessage(
        values.second ? [spawnCall, secondCall] : spawnCall,
        {
          stopReason: "toolUse",
        }
      );
};

// ── The brain ────────────────────────────────────────────────────────────────────────────────────

const brain = PiDurableHarness.layer.pipe(
  Layer.provide(
    ExtensionSet.layer.pipe(
      Layer.provide(Subagents.layer),
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
  Layer.provide(BrainConfig.layerFrom(dataDir)),
  Layer.provide(
    Layer.succeed(BriefFaults, judgeFaults(values.fault, Number(values.times)))
  )
);

/** Reads through the brain's Harness, outside any commit. */
const read = <A>(
  name: string,
  body: (
    harness: Harness,
    context: Parameters<Harness["inspect"]>[0]
  ) => Promise<A>
) =>
  Effect.gen(function* () {
    const { harness } = yield* (yield* Brain).session;

    return yield* durable(
      name,
      async (context) => await body(harness, context)
    );
  });

/** The parent's conversation, from its thread (ensured again: a second ensure changes nothing). */
const parentConversation = Effect.gen(function* () {
  const seam = yield* HarnessSeam;

  const handle = yield* seam.ensureThread({
    threadId: PARENT,
    projectId: ProjectId.make("brief-go"),
    model: FAUX_MODEL,
    thinkingLevel: "off",
    cwd: repo,
    instructions: Option.none(),
    runtimeMode: "full-access",
  });

  return piConversationId(handle.conversationId);
});

/** The parent's brief records. */
const briefsOf = (parent: ConversationId) =>
  read("judge.approvals", async (harness, context) => {
    const ledger = await harness.snapshot(Approvals, parent, context);

    return Object.values(ledger?.items ?? {}).filter(
      (record) => record.kind === "brief"
    );
  });

/** What the judge asserts on, read from the store and the repository. */
const report = (parent: ConversationId, approvalId: string) =>
  Effect.gen(function* () {
    const records = yield* briefsOf(parent);
    const record = records.find((found) => found.id === approvalId);

    const counts = yield* read("judge.report", async (harness, context) => {
      const page = await harness.commit(
        async (tx) => ({
          conversations: await tx.scanConversations({}, 512),
          starts: await tx.scanTasks({ kind: START_TASK }, 64),
          told: await tx.scanEntries({ conversationId: parent }, 512),
        }),
        context
      );

      const links = await Promise.all(
        page.conversations.items.map(async (conversation) => ({
          id: conversation.id,
          link: await harness.snapshot(ChildDoc, conversation.id, context),
        }))
      );

      const children = links.flatMap(({ id, link }) =>
        isLinked(link) && link.key === approvalId ? [id] : []
      );

      const inputs = await Promise.all(
        children.map(async (child) => {
          const entries = await harness.commit(
            async (tx) => await tx.scanEntries({ conversationId: child }, 512),
            context
          );

          return entries.items.filter((entry) => entry.kind === "pi.user")
            .length;
        })
      );

      const inspection = await harness.inspect(context);

      return {
        children: children.length,
        inputs,
        // The brief's answer reached the parent once: a note, or an input naming the brief.
        told: page.told.items.filter(
          (entry) =>
            entry.kind === BRIEF_ANSWER_ENTRY ||
            (entry.kind === "pi.user" &&
              (entry.model ?? []).some((message) =>
                messageText(message).includes(`brief "${TITLE}"`)
              ))
        ).length,
        starts: page.starts.items.map((task) => {
          const state = inspection.tasks.find(
            (found) => found.record.id === task.id
          )?.state;

          return {
            status: task.state.status,
            inspected: state?.kind ?? "unknown",
            reason:
              state !== undefined && Predicate.hasProperty(state, "reason")
                ? state.reason
                : null,
          };
        }),
      };
    });

    const worktrees = yield* cairnWorktrees(repo, dataDir);
    const plans = yield* (yield* ChildWorkspaceStore).listOpen;

    return {
      status: record?.status ?? "missing",
      started: record?.started?.childThreadId ?? null,
      worktrees: worktrees.length,
      plans: plans.length,
      ...counts,
    };
  });

/** Whether the brief has come to rest: answered, and its child's result or its answer delivered. */
const atRest = (
  status: string,
  counted: {
    readonly children: number;
    readonly told: number;
    readonly inputs: ReadonlyArray<number>;
    readonly starts: ReadonlyArray<{ readonly inspected: string }>;
  }
) => {
  if (counted.starts.some((start) => start.inspected === "blocked")) {
    return true;
  }

  if (status === "accepted") {
    return (
      counted.children > 0 &&
      counted.told > 0 &&
      counted.inputs.every((n) => n > 0)
    );
  }

  return status !== "pending" && counted.told > 0;
};

/** Polls the report until the brief is at rest, or the timeout passes. */
const settle = (parent: ConversationId, approvalId: string) =>
  Effect.gen(function* () {
    for (;;) {
      const now = yield* report(parent, approvalId);

      if (atRest(now.status, now)) {
        // Give the child's reporter its moment, then read once more.
        yield* Effect.sleep(Duration.millis(500));

        return { ...(yield* report(parent, approvalId)), rested: true };
      }

      yield* Effect.sleep(Duration.millis(100));
    }
  }).pipe(
    Effect.timeoutOption(REST_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.map(report(parent, approvalId), (last) => ({
            ...last,
            rested: false,
          })),
        onSome: Effect.succeed,
      })
    )
  );

const respond = (approvalId: string, decision: "accept" | "decline") =>
  Effect.gen(function* () {
    const seam = yield* HarnessSeam;

    return yield* seam
      .respond(PARENT, ApprovalId.make(approvalId), {
        decision,
        reason: decision === "decline" ? Option.some("not now") : Option.none(),
        answers: Option.none(),
      })
      .pipe(Effect.result);
  });

const program = Effect.gen(function* () {
  const brainService = yield* Brain;

  // The production boot repairs that touch approvals, parked tasks and child workspaces, in
  // `BootRepairs.ts`'s order (the approval-wait retry among them, which a parent with a second brief
  // pending reaches), then the Harness resumes.
  yield* cancelAbandonedApprovalsAtBoot;
  yield* retryParkedApprovalWaits.repair;
  yield* retryParkedSubagentTasks;
  yield* repairChildWorkspacesAtBoot;
  yield* brainService.resume;

  const { faux } = yield* FauxModels;

  faux.setResponses(Array.from({ length: 32 }, () => answer));

  const parent = yield* parentConversation;
  const { step } = values;

  if (step === "spawn") {
    const seam = yield* HarnessSeam;

    yield* seam.submit(PARENT, {
      requestId: "delegate",
      content: [{ type: "text", text: DELEGATE }],
      entry: Option.none(),
      whenBusy: "followUp",
    });

    for (;;) {
      const briefs = yield* briefsOf(parent);

      const pending = briefs.find(
        (record) => record.status === "pending" && record.summary === TITLE
      );

      const secondReady =
        !values.second ||
        briefs.some(
          (record) =>
            record.status === "pending" && record.summary === SECOND_TITLE
        );

      if (pending !== undefined && secondReady) {
        writeFileSync(briefFile, pending.id);
        yield* Console.log(
          JSON.stringify({ event: "pending", id: pending.id })
        );

        if (values.die) {
          process.kill(process.pid, "SIGKILL");
        }

        // Let the parent's run end on its acknowledgement.
        yield* Effect.sleep(Duration.millis(300));
        break;
      }

      yield* Effect.sleep(Duration.millis(50));
    }
  }

  const approvalId = readFileSync(briefFile, "utf-8").trim();

  if (step === "go" || step === "decline") {
    yield* respond(approvalId, step === "go" ? "accept" : "decline");
  }

  if (step === "race") {
    yield* Effect.all(
      [
        respond(approvalId, "accept"),
        respond(approvalId, "decline"),
        respond(approvalId, "accept"),
      ],
      { concurrency: "unbounded" }
    );
  }

  if (step === "split") {
    // The control: an answer that creates nothing, then death before a second commit would.
    const { harness } = yield* brainService.session;

    yield* answerApproval(
      harness,
      parent,
      approvalId,
      {
        decision: "accept",
        by: { kind: "user" },
        reason: Option.none(),
        answers: Option.none(),
      },
      brainService.now()
    );

    process.kill(process.pid, "SIGKILL");
  }

  if (step === "retry") {
    const parked = yield* read("judge.inspect", async (harness, context) => {
      const inspection = await harness.inspect(context);

      return inspection.tasks.filter(
        (task) =>
          task.record.kind === START_TASK && task.state.kind === "blocked"
      );
    });

    for (const task of parked) {
      yield* read("judge.retry", async (harness, context) => {
        await harness.retryTask(task.record.id, context);
      });
    }
  }

  const final = yield* step === "spawn"
    ? report(parent, approvalId).pipe(
        Effect.map((now) => ({ ...now, rested: true }))
      )
    : settle(parent, approvalId);

  yield* Console.log(JSON.stringify({ event: "report", step, ...final }));
});

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(
      brain.pipe(
        Layer.provideMerge(Layer.mergeAll(Git.layer, NodeServices.layer))
      )
    )
  )
);
