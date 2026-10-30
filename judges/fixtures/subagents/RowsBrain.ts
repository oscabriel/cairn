// The scripted brain the subagent rows judge (judges/rows-subagent.ts, plan 6C) drives: a parent
// that spawns three children in one step, and children whose runs end three ways, so one group
// shows every kind of row. The subagent tools are the scripted harness's own (briefs, Go, the
// child's thread, settlement notes and the wake); no provider is called and nothing is billed.
//
// - The parent (the seeded thread): a message containing "delegate" is answered with three
//   `subagent_spawn` calls in one step (`SPAWNED`); once a tool answered it says "Waiting for Go.",
//   and anything else (a child's wake) is answered "Noted.".
// - A child, by its brief's first line: "Count the files" answers at once; "Read the README" fails
//   its run (a model error); "List the docs" keeps working until the judge calls `releaseSlow`,
//   then answers.

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

/** The three children the parent spawns, in order: each one's description and how its run ends. */
export const SPAWNED = [
  { description: "Count the files", ends: "done" },
  { description: "Read the README", ends: "failed" },
  { description: "List the docs", ends: "slow" },
] as const;

/** What the quick child answers, which its row previews once it settles. */
export const QUICK_ANSWER = "There are 3 files.";

/** Why the failing child's run fails. */
export const FAILURE = "The model could not read the README.";

/** What the slow child answers once released. */
export const SLOW_ANSWER = "One doc: docs/guide.md.";

// The judge releases the slow child from the same process; a flag, read by the child's wait.
const slow = { released: false };

/** Lets the slow child answer. */
export const releaseSlow = (): void => {
  slow.released = true;
};

/** Holds the slow child again, for the next run of the judge. */
export const holdSlow = (): void => {
  slow.released = false;
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

  if (child?.ends === "failed") {
    const now = yield* Clock.currentTimeMillis;

    return {
      ...scriptedAnswer("", now),
      stopReason: "error" as const,
      errorMessage: FAILURE,
    };
  }

  if (child?.ends === "slow") {
    while (!slow.released) {
      yield* Effect.sleep(Duration.millis(50));
    }

    return scriptedAnswer(SLOW_ANSWER, yield* Clock.currentTimeMillis);
  }

  return scriptedAnswer(QUICK_ANSWER, yield* Clock.currentTimeMillis);
});

const RowsModel = Layer.succeed(
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

/** The rows judge's brain: the spawning parent and its three children, over the echo tool. */
export const rowsBrain: CairnBrain = {
  model: RowsModel,
  tools: ScriptedTools.layerEcho,
};
