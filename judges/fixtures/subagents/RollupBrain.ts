// The scripted brain the rollup judge (judges/rollup.ts, plan 6D) drives: a parent that spawns one
// child per message, and four children that each need someone in a different way, so the judge
// sees every path a child's request takes (ADR 0027). The subagent tools are the scripted
// harness's own; `gate` asks for an approval through the scripted ledger. No provider is called and
// nothing is billed.
//
// - The parent (the seeded thread): a message naming a child ("delegate: Fetch the page") is
//   answered with one `subagent_spawn` call for it; once a tool answered it says "Waiting.". A
//   child's question reaches it as an input: "Which folder should I count?" is answered "lib" with
//   `subagent_reply`, but only once the judge calls `releaseParent` (so the judge can look at the
//   question while it is with the parent); any other question is escalated to the user. Anything
//   else (a Go note, a settlement, a wake) is answered "Noted.".
// - A child, by its brief's first line: "Fetch the page" calls `gate` (an approval only the user
//   gives); "Count the files", "Pick a folder" and "Name the module" each ask their parent one
//   question with `ask_parent`. Once their tool answered they say what came back: "Child heard:
//   <the tool's text>".

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

/** The children, by the words their brief starts with, and what each asks. */
export const CHILDREN = {
  approval: { description: "Fetch the page" },
  parentFirst: {
    description: "Count the files",
    question: "Which folder should I count?",
  },
  inParent: {
    description: "Pick a folder",
    question: "Which folder should I pick?",
    options: ["lib", "src"],
  },
  inChild: {
    description: "Name the module",
    question: "What should the module be called?",
    options: ["heron", "wren"],
  },
} as const;

/** What the parent answers the parent-first question with. */
export const PARENT_ANSWER = "lib";

/** Why the parent escalates every other question. */
export const ESCALATE_REASON = "the user knows the layout";

/** The words a child says once its tool answered. */
export const CHILD_HEARD = "Child heard:";

// The judge releases the parent's answer from the same process; a flag, read by the parent's wait.
const parent = { released: false };

/** Lets the parent answer the parent-first question. */
export const releaseParent = (): void => {
  parent.released = true;
};

/** Holds the parent's answer again, for the next run of the judge. */
export const holdParent = (): void => {
  parent.released = false;
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

  const asker = Object.values(CHILDREN).find(
    (child) =>
      "question" in child && text.includes(`"${child.description}" asks:`)
  );

  if (asker === undefined) {
    return scriptedAnswer("Noted.", now);
  }

  const subagent = Option.getOrElse(
    childIdOf(messages, asker.description),
    () => "unknown"
  );

  if (asker.description === CHILDREN.parentFirst.description) {
    while (!parent.released) {
      yield* Effect.sleep(Duration.millis(50));
    }

    return toolCall(
      "subagent_reply",
      { subagent, answer: PARENT_ANSWER },
      yield* Clock.currentTimeMillis
    );
  }

  return toolCall(
    "subagent_reply",
    { subagent, escalate: ESCALATE_REASON },
    now
  );
});

const firstUserText = (messages: ReadonlyArray<Message>): string => {
  const first = messages.find((message) => message.role === "user");

  return first === undefined ? "" : messageText(first);
};

const childAnswer = Effect.fnUntraced(function* (request: ScriptedRequest) {
  const now = yield* Clock.currentTimeMillis;
  const last = request.messages.at(-1);

  if (last?.role === "toolResult") {
    return scriptedAnswer(`${CHILD_HEARD} ${textOf(last)}`, now);
  }

  const brief = firstUserText(request.messages);

  if (brief.startsWith(CHILDREN.approval.description)) {
    return toolCall("gate", {}, now);
  }

  const asker = [
    CHILDREN.parentFirst,
    CHILDREN.inParent,
    CHILDREN.inChild,
  ].find(({ description }) => brief.startsWith(description));

  if (asker === undefined) {
    return scriptedAnswer("Noted.", now);
  }

  return toolCall(
    "ask_parent",
    "options" in asker
      ? { question: asker.question, options: [...asker.options] }
      : { question: asker.question },
    now
  );
});

const RollupModel = Layer.succeed(
  ScriptedModel,
  ScriptedModel.of({
    answer: (request) =>
      request.threadId === PARITY_THREAD_ID
        ? parentAnswer(request.messages)
        : childAnswer(request),
  })
);

/** The rollup judge's brain: the delegating parent and its asking children, over the conformance tools. */
export const rollupBrain: CairnBrain = {
  model: RollupModel,
  tools: scriptedConformanceTools,
};
