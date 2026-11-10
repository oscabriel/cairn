// The scripted brain the brief card judge (judges/surfaces.ts, `brief-go`, plan 6B) drives: a parent
// that proposes one brief naming the model the user's message names, and children that answer at
// once. The subagent tools are the scripted harness's own (briefs, Go, Send back, the child's
// thread, settlement notes and the wake); no provider is called and nothing is billed.
//
// - The parent (the seeded thread): a message "brief <provider/modelId[:level]> <tag>" is answered
//   with one `subagent_spawn` of "Count the files <tag>" naming that model; once the tool answered
//   it says "Waiting for Go.". Anything else it is given (a Send back's notes, a child's wake) is
//   answered "Parent read: <what it was given>", so the judge reads what reached the parent, and
//   how often.
// - A child answers "Counted 3 files." at once.
// - Models (ADR 0043): the scripted harness takes a named model as named, while `models.check`
//   reads the brain's catalog, which lists the faux model only. A brief naming `READY_MODEL` checks
//   ready; one naming `UNREADY_MODEL` is asked (as when a provider lost its credential after the
//   ask), and `models.check` then finds it is not in the catalog: Go is blocked on it.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { Clock, Effect, Layer } from "effect";

import { messageText } from "../../../apps/server/src/brain/CommitFeed.ts";
import { FAUX_MODEL } from "../../../apps/server/src/brain/FauxModels.ts";
import {
  ScriptedModel,
  ScriptedTools,
  scriptedAnswer,
} from "../../../apps/server/src/brain/ScriptedHarness.ts";
import type { CairnBrain } from "../parity/CairnApp.ts";
import { PARITY_THREAD_ID } from "../parity/CairnApp.ts";

/** What a child answers. */
export const CHILD_ANSWER = "Counted 3 files.";

/** The model a brief names that `models.check` finds ready: the brain's faux model at medium. */
export const READY_MODEL = `${FAUX_MODEL.provider}/${FAUX_MODEL.modelId}:medium`;

/** A model the brain's catalog does not list: `models.check` blocks Go on it. */
export const UNREADY_MODEL = "opencode-go/gpt-6-luna";

const ASK = /^brief (?<model>\S+) (?<tag>.+)$/u;

const parentAnswer = (messages: ReadonlyArray<Message>, now: number) => {
  const last = messages.at(-1);

  if (last === undefined) {
    return scriptedAnswer("Noted.", now);
  }

  if (last.role === "toolResult") {
    return scriptedAnswer("Waiting for Go.", now);
  }

  const given = messageText(last).trim();
  const asked = ASK.exec(given);

  if (asked !== null) {
    const model = asked.groups?.model ?? "";
    const tag = asked.groups?.tag ?? "";

    return fauxAssistantMessage(
      [
        fauxToolCall(
          "subagent_spawn",
          {
            description: `Count the files ${tag}`.trim(),
            brief: "Count the TypeScript files under src and say how many.",
            model,
          },
          { id: `spawn-${String(now)}` }
        ),
      ],
      { stopReason: "toolUse" }
    );
  }

  return scriptedAnswer(`Parent read: ${given}`, now);
};

const BriefModel = Layer.succeed(
  ScriptedModel,
  ScriptedModel.of({
    answer: (request) =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        request.threadId === PARITY_THREAD_ID
          ? parentAnswer(request.messages, now)
          : scriptedAnswer(CHILD_ANSWER, now)
      ),
  })
);

/** The brief card judge's brain: the proposing parent and its children, over the echo tool. */
export const briefBrain: CairnBrain = {
  model: BriefModel,
  tools: ScriptedTools.layerEcho,
};
