// The model the judge brain runs: pi-ai's faux provider answering from a script carried in the
// user's message, so a judge drives tool calls and long replies from outside the process
// (`judge-main.ts` composes it in place of the plain faux layer).
//
// A message starting `judge:` is a script of steps separated by `;`. Each model request answers the
// next step after the newest user message:
//
// - `tool <name> <json arguments>` calls a tool, for example `tool mark {"label":"a"}`;
// - `text <n>` streams a reply of `n` words (at the layer's tokens per second);
// - after the last step the model answers `done`.
//
// A message whose first line is not a script may carry one on a later line (a subagent's brief is
// its title, a blank line, then its task): that line alone is the script. Any other message is
// answered `ok`. The answer never depends on the clock, so a rerun after a crash asks for the same
// step again.

import type {
  AssistantMessage,
  Message,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { Effect, Layer, Option, Predicate, Schema } from "effect";

import { FauxModels } from "../../apps/server/src/brain/FauxModels.ts";
import { ModelSource } from "../../apps/server/src/brain/ModelSource.ts";

/** What a scripted message starts with. */
export const SCRIPT_PREFIX = "judge:";

/** The word a scripted text reply repeats. */
export const REPLY_WORD = "lorem";

const decodeArguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
);

type Step =
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly args: Record<string, Schema.Json>;
    }
  | { readonly kind: "text"; readonly words: number };

const parseStep = (source: string): Option.Option<Step> => {
  const trimmed = source.trim();
  const tool = /^tool\s+(?<name>\S+)\s*(?<args>.*)$/su.exec(trimmed);

  if (tool !== null) {
    const name = tool.groups?.name ?? "";
    const args = (tool.groups?.args ?? "").trim();

    return Option.map(
      args === "" ? Option.some({}) : decodeArguments(args),
      (parsed) => ({ kind: "tool" as const, name, args: { ...parsed } })
    );
  }

  const text = /^text\s+(?<words>\d+)$/u.exec(trimmed);

  return text === null
    ? Option.none()
    : Option.some({
        kind: "text" as const,
        words: Number(text.groups?.words ?? 0),
      });
};

const textOf = (message: Message): string => {
  if (message.role !== "user") {
    return "";
  }

  return Predicate.isString(message.content)
    ? message.content
    : message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
};

/** The answer to one request, from the newest user message and the replies already given to it. */
export const answer = (context: TranscriptContext): AssistantMessage => {
  const { messages } = context;
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const prompt = lastUser === -1 ? undefined : messages[lastUser];

  if (prompt === undefined) {
    return fauxAssistantMessage("ok");
  }

  const whole = textOf(prompt).trim();

  const text = whole.startsWith(SCRIPT_PREFIX)
    ? whole
    : (whole
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith(SCRIPT_PREFIX)) ?? "");

  if (text === "") {
    return fauxAssistantMessage("ok");
  }

  const steps = text
    .slice(SCRIPT_PREFIX.length)
    .split(";")
    .filter((part) => part.trim() !== "")
    .map(parseStep);

  const done = messages
    .slice(lastUser + 1)
    .filter((message) => message.role === "assistant").length;

  const step = steps[done];

  if (step === undefined) {
    return fauxAssistantMessage("done");
  }

  if (Option.isNone(step)) {
    return fauxAssistantMessage(`the judge script has a bad step ${done + 1}`);
  }

  const { value } = step;

  return value.kind === "tool"
    ? fauxAssistantMessage(fauxToolCall(value.name, value.args), {
        stopReason: "toolUse",
      })
    : fauxAssistantMessage(
        Array.from({ length: value.words }, () => REPLY_WORD).join(" ")
      );
};

/** The scripted model over pi-ai's faux provider, streaming at `tokensPerSecond`. */
export const JudgeModel = {
  layer: (tokensPerSecond: number) =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const { faux } = yield* FauxModels;

        // Every request takes one response step; this one puts itself back before answering.
        const step: FauxResponseFactory = (context) => {
          faux.appendResponses([step]);

          return answer(context);
        };

        faux.setResponses([step]);
      })
    ).pipe(
      Layer.provideMerge(
        ModelSource.layerFaux({ tokensPerSecond, settings: {} })
      )
    ),
};
