// The look tool's scripted brain (judges/look.ts): the launch brain the launch-approval state
// drives (judges/fixtures/workflows/LaunchBrain.ts), with threads of its own that spawn one
// subagent each, for the brief-card and child-steps states. The subagent tools are the scripted
// harness's own (briefs, Go, the child's thread, its `done_when` check), as in
// judges/fixtures/subagents/WorkBrain.ts; no provider is called and nothing is billed.
//
// - A spawning thread (`SPAWNING_THREADS`, made by CairnApp's `putThread`): a message that names a
//   subagent is answered with one `subagent_spawn` call (`SPAWNED`), whose brief names
//   `done_when: ["test", "-f", "docs/guide.md"]`; once the tool answered it says "Waiting for Go.",
//   and anything else (the child's wake) is answered "Noted.".
// - The child, by its brief's first words: answers at once, so the scripted brain runs its
//   `done_when` in the child's workspace (the project's, where docs/guide.md exists) and its steps
//   end checked by an outside judge.
// - Every other thread is the launch brain's.

import type { ThreadId } from "@cairn/protocol/Ids";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { Clock, Effect, Layer } from "effect";

import { messageText } from "../../../apps/server/src/brain/CommitFeed.ts";
import {
  ScriptedModel,
  scriptedAnswer,
} from "../../../apps/server/src/brain/ScriptedHarness.ts";
import type { CairnBrain, ThreadSeed } from "../parity/CairnApp.ts";
import { seededThreadId } from "../parity/CairnApp.ts";
import { launchBrain } from "../workflows/LaunchBrain.ts";

/** The threads that spawn a subagent: one per state, so each state's card or child is its own. */
export const SPAWNING_THREADS = {
  /** The brief-card state's: full access, so Cairn runs the brief's command itself. */
  brief: {
    index: 1,
    title: "Count the guide's pages",
    runtimeMode: "full-access",
  },
  /** The brief-card-supervised state's: a mode where a command asks first. */
  supervised: {
    index: 2,
    title: "Count the guide's pages, supervised",
    runtimeMode: "approval-required",
  },
  /** The child-steps state's: its brief is answered with Go, and its child runs to its check. */
  steps: {
    index: 3,
    title: "Count the guide's pages, then check",
    runtimeMode: "full-access",
  },
} as const satisfies Record<string, ThreadSeed>;

const spawning: ReadonlySet<ThreadId> = new Set(
  Object.values(SPAWNING_THREADS).map((seed) => seededThreadId(seed.index))
);

/** What the user sends a spawning thread: it names a subagent, so the thread spawns one. */
export const SPAWN_ASK =
  "Have a subagent count the guide's pages, and check its count with a command.";

/** The subagent each spawning thread proposes. */
export const SPAWNED = {
  description: "Count the guide's pages",
  brief:
    "Count the guide's pages under docs/ and say how many there are, with each one's title.",
  why: "So the README can say how long the guide is.",
  doneWhen: ["test", "-f", "docs/guide.md"],
} as const;

/** What the child answers. */
export const CHILD_ANSWER =
  "docs/ holds one page, guide.md, titled “Guide”. The guide is one page long.";

const parentAnswer = (messages: ReadonlyArray<Message>, now: number) => {
  const last = messages.at(-1);

  if (last?.role === "toolResult") {
    return scriptedAnswer("Waiting for Go.", now);
  }

  if (last !== undefined && messageText(last).includes("subagent")) {
    return fauxAssistantMessage(
      [
        fauxToolCall(
          "subagent_spawn",
          {
            description: SPAWNED.description,
            brief: SPAWNED.brief,
            why: SPAWNED.why,
            done_when: [...SPAWNED.doneWhen],
          },
          { id: `spawn-${String(now)}` }
        ),
      ],
      { stopReason: "toolUse" }
    );
  }

  return scriptedAnswer("Noted.", now);
};

/** Whether the request is the spawned child's: its first input is the brief. */
const isChild = (messages: ReadonlyArray<Message>): boolean => {
  const first = messages.find((message) => message.role === "user");

  return first !== undefined && messageText(first).includes(SPAWNED.brief);
};

const LookModel = Layer.effect(
  ScriptedModel,
  Effect.gen(function* () {
    const launch = yield* ScriptedModel;

    return ScriptedModel.of({
      answer: (request) => {
        if (spawning.has(request.threadId)) {
          return Effect.map(Clock.currentTimeMillis, (now) =>
            parentAnswer(request.messages, now)
          );
        }

        if (isChild(request.messages)) {
          return Effect.map(Clock.currentTimeMillis, (now) =>
            scriptedAnswer(CHILD_ANSWER, now)
          );
        }

        return launch.answer(request);
      },
    });
  })
).pipe(Layer.provide(launchBrain.model));

/** The look tool's brain: the launch brain, and the spawning threads with their child. */
export const lookBrain: CairnBrain = { ...launchBrain, model: LookModel };
