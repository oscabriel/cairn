// The scripted brain the subagent flows judge (judges/subagent-flows.ts, plan 6J) drives: a parent
// that spawns one child per message, three children that keep working until the judge acts on
// them, and one that asks its parent a question the parent escalates to the user. The subagent
// tools are the scripted harness's own (briefs, Go, the child's thread, steers, settlement notes,
// the wake, `ask_parent` and `subagent_reply`); `echo` is the conformance tools'. No provider is
// called and nothing is billed.
//
// - The parent (the seeded thread): a message naming a child ("delegate: Read the README") is
//   answered with one `subagent_spawn` call for it; once a tool answered it says "Waiting.". A
//   child's question reaches it as an input, which it escalates to the user with `subagent_reply`
//   once the judge calls `releaseParent` (so the judge can see the question while the parent holds
//   it). Anything else (a Go note, a settlement, a wake) is answered "Noted.".
// - A child, by its brief's first line: "Read the README" works until the judge calls `release`
//   with its description, then calls `echo` once, and answers the user's steer placed after that
//   tool round with "Steered: <the steer>" (or "Read: done." when no steer came); "List the docs"
//   and "Probe the bridge" work until they are stopped; "Pick a folder" asks its parent one
//   question with options and, once its tool answered, says "Child heard: <the tool's text>".

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { JsonObject, Message } from "@earendil-works/pi-ai";
import { Clock, Duration, Effect, Layer, Option } from "effect";

import { messageText } from "../../../apps/server/src/brain/CommitFeed.ts";
import { scriptedConformanceTools } from "../../../apps/server/src/brain/conformance/ConformanceTools.ts";
import {
  ScriptedModel,
  scriptedAnswer,
} from "../../../apps/server/src/brain/ScriptedHarness.ts";
import type { ScriptedRequest } from "../../../apps/server/src/brain/ScriptedHarness.ts";
import type { CairnBrain } from "../parity/CairnApp.ts";
import { PARITY_THREAD_ID } from "../parity/CairnApp.ts";

/** The children, by the words their brief starts with. */
export const CHILDREN = {
  steered: { description: "Read the README" },
  stopRow: { description: "List the docs" },
  stopPanel: { description: "Probe the bridge" },
  escalated: {
    description: "Pick a folder",
    question: "Which folder should I pick?",
    options: ["lib", "src"],
  },
} as const;

/** The words the user steers the working child with. */
export const STEER = "Also count the headings.";

/** What the steered child answers once it read the steer. */
export const STEERED = `Steered: ${STEER}`;

/** Why the parent escalates the question. */
export const ESCALATE_REASON = "the user knows the layout";

/** The words a child says once its tool answered. */
export const CHILD_HEARD = "Child heard:";

// The judge lets the held models go from the same process; flags, read by their waits.
const held = { parent: true, children: new Set<string>() };

/** Lets the parent escalate the question it holds. */
export const releaseParent = (): void => {
  held.parent = false;
};

/** Lets a working child go on: `echo`, then its answer. */
export const release = (description: string): void => {
  held.children.add(description);
};

/** Holds the parent and every child again, for the judge's next width. */
export const holdAll = (): void => {
  held.parent = true;
  held.children.clear();
};

const textOf = (message: Message): string =>
  message.role === "toolResult"
    ? message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
    : messageText(message);

/** The thread id the Go note gave the child `description`, from the parent's transcript. */
const childIdOf = (
  messages: ReadonlyArray<Message>,
  description: string
): Option.Option<string> => {
  const pattern = new RegExp(
    `the brief "${description}"; subagent thread (\\S+) started`,
    "u"
  );

  for (const message of messages) {
    const found = pattern.exec(textOf(message));

    if (found?.[1] !== undefined) {
      return Option.some(found[1]);
    }
  }

  return Option.none();
};

const toolCall = (name: string, args: JsonObject, now: number) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `${name}-${now}` })], {
    stopReason: "toolUse",
  });

const parentAnswer = Effect.fnUntraced(function* (
  messages: ReadonlyArray<Message>
) {
  const now = yield* Clock.currentTimeMillis;
  const last = messages.at(-1);

  if (last === undefined) {
    return scriptedAnswer("Noted.", now);
  }

  if (last.role === "toolResult") {
    return scriptedAnswer("Waiting.", now);
  }

  const text = textOf(last);

  const spawn = Object.values(CHILDREN).find(({ description }) =>
    text.includes(`delegate: ${description}`)
  );

  if (spawn !== undefined) {
    return toolCall(
      "subagent_spawn",
      {
        description: spawn.description,
        brief: `${spawn.description} in the project root.`,
      },
      now
    );
  }

  const { escalated } = CHILDREN;

  if (!text.includes(`"${escalated.description}" asks:`)) {
    return scriptedAnswer("Noted.", now);
  }

  while (held.parent) {
    yield* Effect.sleep(Duration.millis(50));
  }

  return toolCall(
    "subagent_reply",
    {
      subagent: Option.getOrElse(
        childIdOf(messages, escalated.description),
        () => "unknown"
      ),
      escalate: ESCALATE_REASON,
    },
    yield* Clock.currentTimeMillis
  );
});

const firstUserText = (messages: ReadonlyArray<Message>): string => {
  const first = messages.find((message) => message.role === "user");

  return first === undefined ? "" : messageText(first);
};

/** Waits until the judge lets `description` go; a stopped child's wait is interrupted. */
const waitFor = Effect.fnUntraced(function* (description: string) {
  while (!held.children.has(description)) {
    yield* Effect.sleep(Duration.millis(50));
  }
});

const childAnswer = Effect.fnUntraced(function* (request: ScriptedRequest) {
  const last = request.messages.at(-1);
  const brief = firstUserText(request.messages);

  if (brief.startsWith(CHILDREN.escalated.description)) {
    const now = yield* Clock.currentTimeMillis;
    const { question, options } = CHILDREN.escalated;

    return last?.role === "toolResult"
      ? scriptedAnswer(`${CHILD_HEARD} ${textOf(last)}`, now)
      : toolCall("ask_parent", { question, options: [...options] }, now);
  }

  if (brief.startsWith(CHILDREN.steered.description)) {
    const users = request.messages.filter((message) => message.role === "user");

    // The steer is placed after the tool round, so it is the last message the model reads.
    if (users.length > 1 && last?.role === "user") {
      return scriptedAnswer(
        `Steered: ${messageText(last)}`,
        yield* Clock.currentTimeMillis
      );
    }

    if (last?.role === "toolResult") {
      return scriptedAnswer("Read: done.", yield* Clock.currentTimeMillis);
    }

    yield* waitFor(CHILDREN.steered.description);

    return toolCall(
      "echo",
      { text: "reading" },
      yield* Clock.currentTimeMillis
    );
  }

  const stoppable = [CHILDREN.stopRow, CHILDREN.stopPanel].find(
    ({ description }) => brief.startsWith(description)
  );

  if (stoppable !== undefined) {
    yield* waitFor(stoppable.description);
  }

  return scriptedAnswer("Noted.", yield* Clock.currentTimeMillis);
});

const FlowsModel = Layer.succeed(
  ScriptedModel,
  ScriptedModel.of({
    answer: (request) =>
      request.threadId === PARITY_THREAD_ID
        ? parentAnswer(request.messages)
        : childAnswer(request),
  })
);

/** The subagent flows judge's brain: the delegating parent and its children, over the conformance tools. */
export const flowsBrain: CairnBrain = {
  model: FlowsModel,
  tools: scriptedConformanceTools,
};
