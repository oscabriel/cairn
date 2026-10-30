// The scripted brain the request card judge (judges/surfaces.ts, plan 6A) drives: a model that asks
// for what the user's message names and then says what came back, over the conformance tools
// (`gate` asks for an approval through the scripted ledger; `ask_user` is the harness's own).
//
// - A message containing "gate" is answered with one `gate` call: a `tool-call` approval whose
//   summary is "Open the gate".
// - A message containing "ask" is answered with one `ask_user` call of two single-select
//   questions: "Database" (Postgres, recommended, or SQLite, or the user's own words) and "Name"
//   (heron or wren, or the user's own words).
// - Once a tool answered, the model says "Tool said: <the tool's text>", so the judge reads the
//   decision, the Decline reason and the numbered answers in the transcript.
// - Anything else is answered "Noted.".
// No provider is called; nothing is billed.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { Clock, Effect, Layer } from "effect";

import { messageText } from "../../../apps/server/src/brain/CommitFeed.ts";
import { scriptedConformanceTools } from "../../../apps/server/src/brain/conformance/ConformanceTools.ts";
import {
  ScriptedModel,
  scriptedAnswer,
} from "../../../apps/server/src/brain/ScriptedHarness.ts";
import type { CairnBrain } from "../parity/CairnApp.ts";

/** The two questions `ask` puts to the user, as `ask_user` takes them. */
export const CARD_QUESTIONS = [
  {
    header: "Database",
    question: "Which database should the service use?",
    options: [
      { label: "Postgres", description: "The usual choice", recommended: true },
      { label: "SQLite", description: "One file, no server" },
    ],
  },
  {
    header: "Name",
    question: "What should the service be called?",
    options: [{ label: "heron" }, { label: "wren" }],
  },
];

/** The text of a tool result, as the model reads it. */
const toolText = (message: Message): string =>
  message.role === "toolResult"
    ? message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
    : "";

const answerFor = (messages: ReadonlyArray<Message>, now: number) => {
  const last = messages.at(-1);

  if (last === undefined) {
    return scriptedAnswer("Noted.", now);
  }

  if (last.role === "toolResult") {
    return scriptedAnswer(`Tool said: ${toolText(last)}`, now);
  }

  const asked = messageText(last);

  if (asked.includes("gate")) {
    return fauxAssistantMessage(
      [fauxToolCall("gate", {}, { id: `gate-${now}` })],
      {
        stopReason: "toolUse",
      }
    );
  }

  if (asked.includes("ask")) {
    return fauxAssistantMessage(
      [
        fauxToolCall(
          "ask_user",
          { questions: CARD_QUESTIONS },
          { id: `ask-${now}` }
        ),
      ],
      { stopReason: "toolUse" }
    );
  }

  return scriptedAnswer("Noted.", now);
};

const CardModel = Layer.succeed(
  ScriptedModel,
  ScriptedModel.of({
    answer: (request) =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        answerFor(request.messages, now)
      ),
  })
);

/** The card judge's brain: the asking model over the conformance tools. */
export const cardBrain: CairnBrain = {
  model: CardModel,
  tools: scriptedConformanceTools,
};
