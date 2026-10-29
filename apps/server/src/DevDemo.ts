// A scripted demo thread for the dev brain, until threads launch from the page (wave 2): a scratch
// project and one thread in the shell store, and a message sent to the scripted harness every few
// seconds, so `pnpm dev` shows a thread whose transcript grows live. Only `dev-main.ts` composes
// it. The ids are fixed, so a restart lands on the same rows (the command receipts dedupe them).

import os from "node:os";

import { CommandId, ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { DEFAULT_RUNTIME_MODE } from "@cairn/protocol/Policy";
import {
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Random,
  Schedule,
} from "effect";

import { HarnessSeam } from "./brain/HarnessSeam.ts";
import { FAUX_MODEL } from "./brain/ModelSource.ts";
import { EventSink } from "./shell/EventSink.ts";
import { ProjectRegister, ThreadCreate } from "./shell/ShellCommands.ts";

/** The demo thread's id, for judges and the dev smoke. */
export const DEV_DEMO_THREAD_ID = ThreadId.make(
  "019a0000-0000-7000-8000-00000000d3e0"
);

const DEV_DEMO_PROJECT_ID = ProjectId.make("prj_dev_demo");

const REGISTER_COMMAND = CommandId.make("019a0000-0000-7000-8000-00000000d3e1");

const CREATE_COMMAND = CommandId.make("019a0000-0000-7000-8000-00000000d3e2");

/** How often the demo sends its next message. */
const TICK = Duration.seconds(4);

/** Registers the demo rows, opens the thread in the harness, then sends a message every `TICK`. */
export const DevDemo = Layer.effectDiscard(
  Effect.gen(function* () {
    const sink = yield* EventSink;
    const seam = yield* HarnessSeam;

    yield* sink.commitCommand(
      ProjectRegister.make({
        commandId: REGISTER_COMMAND,
        projectId: DEV_DEMO_PROJECT_ID,
        kind: "scratch",
        title: "Dev demo",
        workspaceRoot: os.tmpdir(),
        repository: Option.none(),
      })
    );
    yield* sink.commitCommand(
      ThreadCreate.make({
        commandId: CREATE_COMMAND,
        threadId: DEV_DEMO_THREAD_ID,
        projectId: DEV_DEMO_PROJECT_ID,
        title: "Scripted demo",
        provider: FAUX_MODEL.provider,
        modelId: FAUX_MODEL.modelId,
        thinkingLevel: "medium",
        runtimeMode: DEFAULT_RUNTIME_MODE,
        branch: Option.none(),
        worktreePath: Option.none(),
      })
    );
    yield* seam.ensureThread({
      threadId: DEV_DEMO_THREAD_ID,
      projectId: DEV_DEMO_PROJECT_ID,
      model: FAUX_MODEL,
      thinkingLevel: "medium",
      cwd: os.tmpdir(),
      instructions: Option.none(),
      runtimeMode: DEFAULT_RUNTIME_MODE,
    });

    const send = Effect.gen(function* () {
      const requestId = `dev-demo-${String(yield* Random.nextInt)}`;
      const now = yield* DateTime.now;

      yield* seam.submit(DEV_DEMO_THREAD_ID, {
        requestId,
        content: [{ type: "text", text: `tick at ${DateTime.formatIso(now)}` }],
        entry: Option.none(),
        whenBusy: "followUp",
      });
    });

    yield* send.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("dev demo send failed", { cause: String(cause) })
      ),
      Effect.repeat(Schedule.spaced(TICK)),
      Effect.forkScoped
    );
    yield* Effect.logInfo("dev demo ready").pipe(
      Effect.annotateLogs({
        event: "dev_demo",
        threadId: DEV_DEMO_THREAD_ID,
      })
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("dev demo did not start", { cause: String(cause) })
    )
  )
);
