// The model answers of one scenario, shared by every request a harness makes, across restarts.
// Both sides take answers from it in request order: pi-durable through pi-ai's faux provider, the
// scripted harness through its model service. A held answer waits for its `release` line, or for
// the request to be aborted (a stop, a close), which is how a scenario keeps a run busy.
//
// A model line with a `thread` alias answers only that thread's requests; one without answers
// whichever request comes next. A request from a thread the scenario has not learned yet waits a
// moment for its alias, since the harness may ask before the runner has read the event naming it.
// Tool arguments may write `$<alias>` for a thread id, resolved when the answer is given.

import type { ThreadId } from "@cairn/protocol/Ids";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Deferred, Duration, Effect, Option } from "effect";
import type { Schema } from "effect";

import { isJsonRecord, resolveAliases } from "./ThreadAliases.ts";
import type { ThreadAliases } from "./ThreadAliases.ts";
import type { ModelLine } from "./Transcript.ts";

interface Step {
  readonly line: ModelLine;
  readonly hold: Option.Option<Deferred.Deferred<true>>;
  taken: boolean;
}

/** How long a request from a thread with no alias yet waits for the runner to learn it. */
const ALIAS_WAIT = Duration.seconds(2);

const ALIAS_POLL = Duration.millis(10);

/** A tool call's arguments with `$<alias>` thread ids resolved. */
const argumentsOf = (
  line: ModelLine["toolCalls"],
  aliases: ThreadAliases
): ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly arguments: { [key: string]: Schema.Json };
}> =>
  (line ?? []).map((call) => {
    const resolved = resolveAliases(call.arguments, aliases);

    return {
      id: call.id,
      name: call.name,
      arguments: isJsonRecord(resolved)
        ? Object.fromEntries(Object.entries(resolved))
        : {},
    };
  });

/** The answer a model line stands for. */
const messageOf = (
  line: ModelLine,
  aliases: ThreadAliases
): AssistantMessage => {
  const calls = argumentsOf(line.toolCalls, aliases).map((call) =>
    fauxToolCall(call.name, call.arguments, { id: call.id })
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
  /**
   * The next answer for a request from `thread` (none when the harness cannot say), once its hold
   * is released or `signal` aborts the request.
   */
  next(
    signal: Option.Option<AbortSignal>,
    thread: Option.Option<ThreadId>
  ): Effect.Effect<AssistantMessage>;
  /** Lets a held answer go; releasing one not taken yet lets it go when it is. */
  release(label: string): Effect.Effect<void>;
}

/** The script of a scenario's model lines, its thread aliases resolved through `aliases`. */
export const responseScript = Effect.fnUntraced(function* (
  lines: ReadonlyArray<ModelLine>,
  aliases: ThreadAliases
) {
  const steps: Array<Step> = [];

  for (const line of lines) {
    const hold =
      line.hold === true
        ? Option.some(yield* Deferred.make<true>())
        : Option.none<Deferred.Deferred<true>>();

    steps.push({ line, hold, taken: false });
  }

  // The alias of the asking thread, waiting a moment for one the runner has not read yet.
  const aliasOf = (thread: Option.Option<ThreadId>) =>
    Effect.gen(function* () {
      if (Option.isNone(thread)) {
        return Option.none<string>();
      }

      const deadline = Duration.toMillis(ALIAS_WAIT);

      for (
        let waited = 0;
        waited < deadline;
        waited += Duration.toMillis(ALIAS_POLL)
      ) {
        const alias = aliases.aliasOf(thread.value);

        if (Option.isSome(alias)) {
          return alias;
        }

        yield* Effect.sleep(ALIAS_POLL);
      }

      return aliases.aliasOf(thread.value);
    });

  const next = (
    signal: Option.Option<AbortSignal>,
    thread: Option.Option<ThreadId>
  ) =>
    Effect.gen(function* () {
      const alias = yield* aliasOf(thread);

      // Taken in the same synchronous step it is found, so two askers never share one.
      const step = steps.find(
        (candidate) =>
          !candidate.taken &&
          (candidate.line.thread === undefined ||
            Option.isNone(thread) ||
            Option.contains(alias, candidate.line.thread))
      );

      if (step === undefined) {
        return exhausted();
      }

      step.taken = true;

      if (Option.isSome(step.hold)) {
        yield* Effect.raceFirst(
          Deferred.await(step.hold.value),
          aborted(signal)
        );
      }

      return messageOf(step.line, aliases);
    });

  const release = (label: string) =>
    Effect.forEach(
      steps.filter((step) => step.line.label === label),
      (step) =>
        Option.match(step.hold, {
          onNone: () => Effect.succeed(true),
          onSome: (hold) => Deferred.succeed(hold, true),
        }),
      { discard: true }
    );

  return { next, release } satisfies ResponseScript;
});
