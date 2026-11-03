// The `model` judge's rules (briefs note section 3): one plain request to the model the criterion
// names, or to the goal thread's own model when it names none (ADR 0043), which reads the objective,
// the criterion, its rubric and the end of the thread's transcript, and answers MET or NOT MET on
// its first line. It is not a subagent, so it needs no brief; its model id and reply are the
// verdict's evidence. A reply that says neither is not met: a criterion is met only when its judge
// says so. A judge from another model family is the user's or the model's choice, never a rule.

import type { ModelRef } from "@cairn/protocol/Models";
import { Option } from "effect";

import { isRoleName } from "../models/ModelSpecs.ts";

/** The provider the Claude bridge registers: it answers conversations, not one plain request. */
export const BRIDGE_PROVIDER = "claude-bridge";

/** How much of the thread's transcript the judge reads, from its end. */
export const TRANSCRIPT_LIMIT = 12_000;

/** How much of the judge's reply the verdict keeps. */
export const REPLY_LIMIT = 2000;

/** The system prompt of every model judge. */
export const MODEL_JUDGE_SYSTEM = [
  "You are an outside judge for one criterion of a goal another model is working on.",
  "Decide from the evidence in the transcript only. A claim that the work is done is not evidence; a command's output, a quoted file or a result the user confirmed is.",
  "Answer with MET or NOT MET alone on the first line, then at most three sentences saying why.",
].join(" ");

/** `provider/modelId`. */
export const modelText = (model: ModelRef): string =>
  `${model.provider}/${model.modelId}`;

/**
 * The spec a model judge names; none when it names none, or names a role (a judge recorded before
 * ADR 0043), which reads as none: the judge runs on the goal thread's model.
 */
export const judgeSpecOf = (spec: string | null): Option.Option<string> =>
  Option.filter(Option.fromNullOr(spec), (named) => !isRoleName(named));

/**
 * Why `judge` may not judge a thread; none when it may. The Claude bridge is refused, since it
 * answers conversations, not one plain request; `named` says whether the criterion named the model
 * or it is the thread's own.
 */
export const judgeModelRefusal = (
  judge: ModelRef,
  named: boolean
): Option.Option<string> => {
  if (judge.provider !== BRIDGE_PROVIDER) {
    return Option.none();
  }

  return Option.some(
    named
      ? `${modelText(judge)} runs through the Claude bridge, which cannot answer a judge's one request. Name a model served by another provider (call models to see them), such as an opencode-go model.`
      : `This thread runs on ${modelText(judge)}, through the Claude bridge, which cannot answer a judge's one request, so a model judge cannot run on the thread's own model. Name a model served by another provider (call models to see them), such as an opencode-go model.`
  );
};

/** What the judge is asked to decide. */
export interface ModelJudgeAsk {
  readonly objective: string;
  readonly criterion: string;
  readonly rubric: string;
  /** The thread's transcript as text, oldest first. */
  readonly transcript: string;
}

/** The judge's one user message. */
export const modelJudgePrompt = (ask: ModelJudgeAsk): string => {
  const transcript =
    ask.transcript.length > TRANSCRIPT_LIMIT
      ? `[earlier transcript left out]\n${ask.transcript.slice(-TRANSCRIPT_LIMIT)}`
      : ask.transcript;

  return [
    `Goal: ${ask.objective === "" ? "(none stated)" : ask.objective}`,
    `Criterion: ${ask.criterion}`,
    `Rubric: ${ask.rubric}`,
    "",
    "Transcript (the end of the goal thread):",
    "<transcript>",
    transcript,
    "</transcript>",
    "",
    "Is the criterion met? First line: MET or NOT MET.",
  ].join("\n");
};

/** How a judge's reply reads. */
export interface ModelVerdict {
  readonly ok: boolean;
  /** Whether the first line said MET or NOT MET. */
  readonly understood: boolean;
  /** The reply, cut to `REPLY_LIMIT`. */
  readonly reply: string;
}

/** Reads a judge's reply: MET or NOT MET on its first line; anything else is not met. */
export const parseModelVerdict = (reply: string): ModelVerdict => {
  const trimmed = reply.trim();

  const first = (trimmed.split("\n")[0] ?? "")
    .replaceAll(/[*_`#>.:]/gu, " ")
    .trim()
    .toUpperCase();

  const cut = trimmed.slice(0, REPLY_LIMIT);

  if (/^NOT\s+MET\b/u.test(first)) {
    return { ok: false, understood: true, reply: cut };
  }

  if (/^MET\b/u.test(first)) {
    return { ok: true, understood: true, reply: cut };
  }

  return { ok: false, understood: false, reply: cut };
};
