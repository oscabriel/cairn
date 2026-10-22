// The model answers of one scenario, shared by every request a harness makes, across restarts.
// Both sides take answers from it in request order: pi-durable through pi-ai's faux provider, the
// scripted harness through its model service. A held answer waits for its `release` line, or for
// the request to be aborted (a stop, a close), which is how a scenario keeps a run busy.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Deferred, Effect, Option, Ref } from "effect";

import type { ModelLine } from "./Transcript.ts";

interface Step {
  readonly label: string;
  readonly message: AssistantMessage;
  readonly hold: Option.Option<Deferred.Deferred<true>>;
}

/** The answer a model line stands for. */
const messageOf = (line: ModelLine): AssistantMessage => {
  const calls = (line.toolCalls ?? []).map((call) =>
    fauxToolCall(call.name, { ...call.arguments }, { id: call.id })
  );

  if (calls.length > 0) {
    return fauxAssistantMessage(calls, { stopReason: "toolUse" });
  }

  if (line.stopReason === "error") {
    return fauxAssistantMessage(line.text ?? "", {
      stopReason: "error",
      errorMessage: line.errorMessage ?? "scripted failure",
    });
  }

  return fauxAssistantMessage(line.text ?? "");
};

/** What every request gets once the script ran out: a failure that names the cause. */
const exhausted = () =>
  fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage:
      "conformance script exhausted: the scenario has no model line for this request",
  });

/** Completes when `signal` aborts; never without one. */
const aborted = (request: Option.Option<AbortSignal>) =>
  Effect.callback<true>((resume) => {
    if (Option.isNone(request)) {
      return;
    }

    const signal = request.value;

    if (signal.aborted) {
      resume(Effect.succeed(true));

      return;
    }

    signal.addEventListener(
      "abort",
      () => {
        resume(Effect.succeed(true));
      },
      { once: true }
    );
  });

/** The ordered answers of one scenario. */
export interface ResponseScript {
  /** The next answer, once its hold is released or `signal` aborts the request. */
  next(signal: Option.Option<AbortSignal>): Effect.Effect<AssistantMessage>;
  /** Lets a held answer go; releasing one not taken yet lets it go when it is. */
  release(label: string): Effect.Effect<void>;
}

/** The script of a scenario's model lines. */
export const responseScript = Effect.fnUntraced(function* (
  lines: ReadonlyArray<ModelLine>
) {
  const steps: Array<Step> = [];

  for (const line of lines) {
    const hold =
      line.hold === true
        ? Option.some(yield* Deferred.make<true>())
        : Option.none<Deferred.Deferred<true>>();

    steps.push({ label: line.label, message: messageOf(line), hold });
  }

  const cursor = yield* Ref.make(0);

  const next = (signal: Option.Option<AbortSignal>) =>
    Effect.gen(function* () {
      const index = yield* Ref.getAndUpdate(cursor, (n) => n + 1);
      const step = steps[index];

      if (step === undefined) {
        return exhausted();
      }

      if (Option.isSome(step.hold)) {
        yield* Effect.raceFirst(
          Deferred.await(step.hold.value),
          aborted(signal)
        );
      }

      return step.message;
    });

  const release = (label: string) =>
    Effect.forEach(
      steps.filter((step) => step.label === label),
      (step) =>
        Option.match(step.hold, {
          onNone: () => Effect.succeed(true),
          onSome: (hold) => Deferred.succeed(hold, true),
        }),
      { discard: true }
    );

  return { next, release } satisfies ResponseScript;
});
