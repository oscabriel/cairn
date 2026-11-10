// The judge brain of `judges/approval-kill.ts` (ADR 0046, ADR 0013's gate S4): Cairn's production
// seam, brain and extension set over pi-ai's faux provider and a scratch data folder (its own
// `brain.sqlite` and `cairn.sqlite`, never the deployed unit's). One thread in Supervised calls the
// production gated `bash`, which asks first. Each run of this script is one life of the brain: it
// boots (the production repairs that touch approvals and crashed tasks, in `BootRepairs.ts`'s
// order, then the Harness resumes), does its step, and prints JSON lines. The judge kills it, and
// runs the next life over the same folder.
//
//   node judges/fixtures/approval-kill/ApprovalBrain.ts --dir <run> --step ask|wait|answer [--control]
//
// Steps:
// - `ask`: the thread's first life. It sends the message whose answer calls `bash`, then waits.
// - `wait`: boots and waits.
// - `answer`: boots, accepts the pending approval as the user (`answerApproval`, what
//   `thread.respond` calls), waits until the thread is idle, and prints its report.
//
// Every life prints `{"event":"pending",...}` once the call's approval is pending again (the gated
// call reran after the restart and waits on its record), and `{"event":"gone"}` when the thread is
// idle with no pending approval instead. `--control` opens the Harness with pi-durable's own restart
// limit, as a bump that kept it would: the judge must fail on what it leaves.
//
// The command appends one line to `<run>/effects.log`, so the report's `effects` counts how often
// the approved call ran. No network, no model spend.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { DEFAULT_RESTART_LIMIT, LiveDoc } from "@earendil-works/pi-durable";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Duration, Effect, Layer, Option } from "effect";

import {
  answerApproval,
  cancelAbandonedApprovalsAtBoot,
  expireLapsedApprovalsAtBoot,
} from "../../../apps/server/src/approvals/ApprovalLedger.ts";
import { KEPT_WAITS } from "../../../apps/server/src/BootRepairs.ts";
import { Brain } from "../../../apps/server/src/brain/Brain.ts";
import { testBrain } from "../../../apps/server/src/brain/BrainTestKit.ts";
import { Approvals } from "../../../apps/server/src/brain/CairnDocs.ts";
import { endCrashLoopedTasks } from "../../../apps/server/src/brain/CrashLimit.ts";
import { durable } from "../../../apps/server/src/brain/Durable.ts";
import {
  FauxModels,
  FAUX_MODEL,
} from "../../../apps/server/src/brain/FauxModels.ts";
import { HarnessSeam } from "../../../apps/server/src/brain/HarnessSeam.ts";
import { piConversationId } from "../../../apps/server/src/brain/PiIds.ts";
import { RestartLimit } from "../../../apps/server/src/brain/RestartLimit.ts";
import { Git } from "../../../apps/server/src/git/Git.ts";
import { Subagents } from "../../../apps/server/src/subagents/Subagents.ts";
import { workspacesAt } from "../../../apps/server/src/workspaces/ChildWorkspacesTestKit.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    step: { type: "string", default: "wait" },
    control: { type: "boolean", default: false },
  },
});

const dir = path.resolve(values.dir ?? ".");

const dataDir = path.join(dir, "data");

const effectsFile = path.join(dir, "effects.log");

/** The thread every life works on. */
const THREAD = ThreadId.make("0190f0c0-0000-7000-8000-00000000a5e4");

/** The model's script: call `bash` once, then say done. */
const answer = (request: { readonly messages: ReadonlyArray<Message> }) =>
  request.messages.some((message) => message.role === "toolResult")
    ? fauxAssistantMessage("done")
    : fauxAssistantMessage(
        fauxToolCall(
          "bash",
          { command: `echo ran >> ${JSON.stringify(effectsFile)}` },
          { id: "call_bash" }
        ),
        { stopReason: "toolUse" }
      );

// ── The brain ────────────────────────────────────────────────────────────────────────────────────

const brain = testBrain({ subagents: Subagents.layer, dataDir }).pipe(
  Layer.provideMerge(workspacesAt(dataDir)),
  Layer.provide(
    values.control
      ? Layer.succeed(RestartLimit, DEFAULT_RESTART_LIMIT)
      : Layer.empty
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

/** The thread's conversation (ensured again: a second ensure changes nothing). */
const conversation = Effect.gen(function* () {
  const seam = yield* HarnessSeam;

  const handle = yield* seam.ensureThread({
    threadId: THREAD,
    projectId: ProjectId.make("approval-kill"),
    model: FAUX_MODEL,
    thinkingLevel: "off",
    cwd: dir,
    instructions: Option.none(),
    runtimeMode: "approval-required",
  });

  return piConversationId(handle.conversationId);
});

/** The thread's call approvals. */
const approvalsOf = (id: ConversationId) =>
  read("judge.approvals", async (harness, context) => {
    const ledger = await harness.snapshot(Approvals, id, context);

    return Object.values(ledger?.items ?? {}).filter(
      (record) => record.kind === "tool-call"
    );
  });

/** Whether the thread runs nothing. */
const idle = (id: ConversationId) =>
  read("judge.live", async (harness, context) => {
    const live = await harness.snapshot(LiveDoc, id, context);

    return live?.run === undefined;
  });

/** Waits until the call's approval is pending, or the thread is idle without one. */
const settleOnApproval = (id: ConversationId) =>
  Effect.gen(function* () {
    for (;;) {
      const pending = (yield* approvalsOf(id)).find(
        (record) => record.status === "pending"
      );

      if (pending !== undefined) {
        return Option.some(pending.id);
      }

      if (yield* idle(id)) {
        return Option.none<string>();
      }

      yield* Effect.sleep(Duration.millis(50));
    }
  });

/** The tool results' texts, in order. */
const resultsOf = (id: ConversationId) =>
  read(
    "judge.entries",
    async (harness, context) =>
      await harness.commit(
        async (tx) => await tx.scanEntries({ conversationId: id }, 200),
        context
      )
  ).pipe(
    Effect.map((page) =>
      page.items
        .filter((entry) => entry.kind === "pi.tool-result")
        .flatMap((entry) => entry.model ?? [])
        .flatMap((message) =>
          message.role === "toolResult"
            ? [
                {
                  isError: message.isError,
                  text: message.content
                    .flatMap((part) =>
                      part.type === "text" ? [part.text] : []
                    )
                    .join(""),
                },
              ]
            : []
        )
    )
  );

const effects = () =>
  existsSync(effectsFile)
    ? readFileSync(effectsFile, "utf-8").split("\n").filter(Boolean).length
    : 0;

const program = Effect.gen(function* () {
  const brainService = yield* Brain;

  // The production boot repairs that touch approvals and crashed tasks, in `BootRepairs.ts`'s
  // order, then the Harness resumes.
  yield* cancelAbandonedApprovalsAtBoot;
  yield* expireLapsedApprovalsAtBoot;
  yield* endCrashLoopedTasks(KEPT_WAITS);
  yield* brainService.resume;

  const { faux } = yield* FauxModels;

  faux.setResponses(Array.from({ length: 16 }, () => answer));

  const id = yield* conversation;

  if (values.step === "ask") {
    yield* (yield* HarnessSeam).submit(THREAD, {
      requestId: "approval-kill-1",
      content: [{ type: "text", text: "run it" }],
      entry: Option.none(),
      whenBusy: "followUp",
    });
  }

  const pending = yield* settleOnApproval(id);

  yield* Console.log(
    JSON.stringify(
      Option.match(pending, {
        onNone: () => ({ event: "gone" }),
        onSome: (approvalId) => ({ event: "pending", approvalId }),
      })
    )
  );

  if (values.step !== "answer") {
    return yield* Effect.never;
  }

  if (Option.isSome(pending)) {
    yield* answerApproval(
      (yield* brainService.session).harness,
      id,
      pending.value,
      {
        decision: "accept",
        by: { kind: "user" },
        reason: Option.none(),
        answers: Option.none(),
        launch: Option.none(),
      },
      brainService.now()
    );
  }

  while (!(yield* idle(id))) {
    yield* Effect.sleep(Duration.millis(50));
  }

  const records = yield* approvalsOf(id);

  return yield* Console.log(
    JSON.stringify({
      event: "report",
      effects: effects(),
      approvals: records.map((record) => ({
        status: record.status,
        decidedBy: record.decidedBy?.kind ?? null,
      })),
      results: yield* resultsOf(id),
    })
  );
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
