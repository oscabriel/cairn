// The scripted brain the work panel judge (judges/work-panel.ts, plan 6E) drives: a parent that
// spawns four children in one step, children that end four ways, and two that keep working until
// the judge lets them answer, so one panel shows live children to stop, resting ones folded, and a
// child whose steps move while the judge watches. The subagent tools are the scripted harness's own
// (briefs, Go, the child's thread, settlement notes and the wake); no provider is called and
// nothing is billed.
//
// - The parent (the seeded thread): a message containing "delegate" is answered with four
//   `subagent_spawn` calls in one step (`SPAWNED`); once a tool answered it says "Waiting for Go.",
//   and anything else (a child's wake) is answered "Noted.".
// - A child, by its brief's first line: "Count the files" answers at once; "Probe the bridge" fails
//   its run (a model error); "Read the README" and "List the docs" keep working until the judge
//   calls `release` with their description (a stopped one never answers).

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { Clock, Duration, Effect, Layer } from "effect";

import { messageText } from "../../../apps/server/src/brain/CommitFeed.ts";
import {
  ScriptedModel,
  ScriptedTools,
  scriptedAnswer,
} from "../../../apps/server/src/brain/ScriptedHarness.ts";
import type { ScriptedRequest } from "../../../apps/server/src/brain/ScriptedHarness.ts";
import type { CairnBrain } from "../parity/CairnApp.ts";
import { PARITY_THREAD_ID } from "../parity/CairnApp.ts";

/** The four children the parent spawns, in order: each one's description and how its run ends. */
export const SPAWNED = [
  { description: "Count the files", ends: "done" },
  { description: "Probe the bridge", ends: "failed" },
  { description: "Read the README", ends: "held" },
  { description: "List the docs", ends: "held" },
] as const;

/** A child's description. */
export type Spawned = (typeof SPAWNED)[number]["description"];

/** Why the failing child's run fails. */
export const FAILURE = "The bridge did not answer.";

/** What a child answers, by its description. */
export const answerOf = (description: string): string =>
  `${description}: done.`;

// The judge releases a held child from the same process; a set of descriptions, read by its wait.
const released = new Set<string>();

/** Lets a held child answer. */
export const release = (description: Spawned): void => {
  released.add(description);
};

/** Holds every held child again, for the judge's next width. */
export const holdAll = (): void => {
  released.clear();
};

const firstUserText = (messages: ReadonlyArray<Message>): string => {
  const first = messages.find((message) => message.role === "user");

  return first === undefined ? "" : messageText(first);
};

const parentAnswer = (messages: ReadonlyArray<Message>, now: number) => {
  const last = messages.at(-1);

  if (last?.role === "toolResult") {
    return scriptedAnswer("Waiting for Go.", now);
  }

  if (last !== undefined && messageText(last).includes("delegate")) {
    return fauxAssistantMessage(
      SPAWNED.map(({ description }, index) =>
        fauxToolCall(
          "subagent_spawn",
          { description, brief: `${description} in the project root.` },
          { id: `spawn-${String(index)}-${String(now)}` }
        )
      ),
      { stopReason: "toolUse" }
    );
  }

  return scriptedAnswer("Noted.", now);
};

const childAnswer = Effect.fnUntraced(function* (request: ScriptedRequest) {
  const brief = firstUserText(request.messages);

  const child = SPAWNED.find(({ description }) =>
    brief.startsWith(description)
  );

  if (child === undefined) {
    return scriptedAnswer("Noted.", yield* Clock.currentTimeMillis);
  }

  if (child.ends === "failed") {
    const now = yield* Clock.currentTimeMillis;

    return {
      ...scriptedAnswer("", now),
      stopReason: "error" as const,
      errorMessage: FAILURE,
    };
  }

  if (child.ends === "held") {
    while (!released.has(child.description)) {
      yield* Effect.sleep(Duration.millis(50));
    }
  }

  return scriptedAnswer(
    answerOf(child.description),
    yield* Clock.currentTimeMillis
  );
});

const WorkModel = Layer.succeed(
  ScriptedModel,
  ScriptedModel.of({
    answer: (request) =>
      request.threadId === PARITY_THREAD_ID
        ? Effect.map(Clock.currentTimeMillis, (now) =>
            parentAnswer(request.messages, now)
          )
        : childAnswer(request),
  })
);

/** The work panel judge's brain: the spawning parent and its four children, over the echo tool. */
export const workBrain: CairnBrain = {
  model: WorkModel,
  tools: ScriptedTools.layerEcho,
};
