// The replay conformance suite of the harness seam (ADR 0024), in the shape of pi-durable's
// `registerEnvConformance`: `registerHarnessConformance(runner, name, makeTarget, scenarios)`
// registers one test per scenario against one harness, and `runScenario` runs one scenario and
// reports how it went, which the mutation check and the drift goldens also use.
//
// A run plays the scenario's lines in order. The harness's events are logged as they arrive, and a
// client built on @cairn/client-logic's ThreadView follows the thread stream exactly as the web
// client does (a refused frame means a fresh subscription). Expectations wait up to a timeout for
// the log or the client's normalized view to show what the line says, so the suite judges what a
// client would see, not internal state.

import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { ApprovalId, ProjectId, ThreadId } from "@cairn/protocol/Ids";
import type { SubmissionId } from "@cairn/protocol/Ids";
import type { ThreadStreamItem } from "@cairn/protocol/Thread";
import {
  Clock,
  Duration,
  Effect,
  Fiber,
  Match,
  Option,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import type { describe, it } from "vitest";

import { HarnessEvent } from "../HarnessSeam.ts";
import type {
  HarnessError,
  HarnessSeam,
  HarnessTurnInput,
} from "../HarnessSeam.ts";
import { FAUX_MODEL } from "../ModelSource.ts";
import type { Mutation, MutationState } from "./Mutations.ts";
import { breakSeam } from "./Mutations.ts";
import {
  jsonContains,
  jsonEquals,
  normalizeView,
  pendingApprovalIds,
  valueAt,
} from "./Normalize.ts";
import { responseScript } from "./ResponseScript.ts";
import type { MakeTarget } from "./Targets.ts";
import type {
  InputLine,
  ModelLine,
  Scenario,
  TranscriptLine,
} from "./Transcript.ts";

type Json = Schema.Json;

/** The thread every scenario runs on. */
const THREAD_ID = ThreadId.make("0190f0c0-0000-7000-8000-000000000001");

const PROJECT_ID = ProjectId.make("conformance");

/** A 1x1 PNG, for scenarios that send an image. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const POLL = Duration.millis(20);

/** Why a scenario failed: the line and what was seen instead. */
class ScenarioFailure extends Schema.TaggedError<ScenarioFailure>()(
  "ScenarioFailure",
  { message: Schema.String }
) {}

/** How one scenario went. */
export interface ScenarioOutcome {
  readonly scenario: string;
  /** None when every line passed. */
  readonly failure: Option.Option<string>;
  /** The masked events and final view, for the drift goldens. */
  readonly record: Json;
}

/** How to run scenarios. */
export interface RunOptions {
  /** How long an expectation may wait. */
  readonly timeout: Duration.Duration;
  /** Breaks applied to every instance of the harness (the mutation check). */
  readonly mutations: ReadonlySet<Mutation>;
}

const encodeEvent = Schema.encodeSync(Schema.toCodecJson(HarnessEvent));

const decodeApprovalId = Schema.decodeEffect(ApprovalId);

const isModelLine = (line: TranscriptLine): line is ModelLine =>
  line.type === "model";

/** An event with ids and times masked, for the goldens; none for noisy bookkeeping events. */
const maskEvent = (event: HarnessEvent): Option.Option<Json> =>
  Match.value(event).pipe(
    Match.tagsExhaustive({
      ThreadEnsured: () => Option.some<Json>({ event: "ThreadEnsured" }),
      RunStarted: () => Option.some<Json>({ event: "RunStarted" }),
      RunTerminal: (found) =>
        Option.some<Json>({
          event: found._tag,
          status: found.status,
          failure: Option.match(found.failure, {
            onNone: () => null,
            onSome: (failure) => failure.class,
          }),
        }),
      MessageCommitted: (found) =>
        Option.some<Json>({
          event: found._tag,
          role: found.role,
          text: found.text,
        }),
      QueueChanged: () => Option.none<Json>(),
      RuntimeRequestUpdated: (found) =>
        Option.some<Json>({ event: found._tag, status: found.status }),
      UsageUpdated: () => Option.none<Json>(),
      TaskParked: () => Option.none<Json>(),
      CompactionStarted: () =>
        Option.some<Json>({ event: "CompactionStarted" }),
      CompactionEnded: (found) =>
        Option.some<Json>({ event: found._tag, failed: found.failed }),
    })
  );

const describeLine = (index: number, line: TranscriptLine) =>
  `line ${index + 1} (${JSON.stringify(line)})`;

/** The user input a message line sends. */
const turnInput = (line: InputLine): HarnessTurnInput => {
  const text = { type: "text" as const, text: line.text ?? "" };

  let whenBusy: HarnessTurnInput["whenBusy"] = line.whenBusy ?? "followUp";

  if (line.step === "steer") {
    whenBusy = "steer";
  } else if (line.step === "follow_up") {
    whenBusy = "followUp";
  }

  return {
    requestId: line.requestId ?? "missing-request-id",
    content:
      line.image === true
        ? [text, { type: "image", data: PNG_BASE64, mimeType: "image/png" }]
        : [text],
    entry: Option.none(),
    whenBusy,
  };
};

/** Waits until `check` finds nothing wrong, or fails with its last complaint. */
const eventually = (
  timeout: Duration.Duration,
  where: string,
  check: Effect.Effect<Option.Option<string>>
) =>
  Effect.gen(function* () {
    const deadline =
      (yield* Clock.currentTimeMillis) + Duration.toMillis(timeout);

    let complaint = yield* check;

    while (Option.isSome(complaint)) {
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* new ScenarioFailure({
          message: `${where}: ${complaint.value}`,
        });
      }

      yield* Effect.sleep(POLL);
      complaint = yield* check;
    }

    return yield* Effect.void;
  });

const fromSeam = (where: string) => (failure: HarnessError) =>
  new ScenarioFailure({ message: `${where}: ${failure.message}` });

/** Runs one scenario against one harness. Never fails: a failure is in the outcome. */
export const runScenario = (
  scenario: Scenario,
  makeTarget: MakeTarget,
  options: RunOptions
): Effect.Effect<ScenarioOutcome> =>
  Effect.scoped(
    Effect.gen(function* () {
      const script = yield* responseScript(scenario.lines.filter(isModelLine));
      const target = yield* makeTarget(script);
      const events: Array<HarnessEvent> = [];
      const client = yield* Ref.make(Option.none<ThreadViewState>());
      const submissions = new Map<string, SubmissionId>();
      const feeds: Array<Fiber.Fiber<void>> = [];
      const mutationState: MutationState = { inputs: new Map() };
      const progress = { cursor: 0, ensured: false };

      // One wrapper per open instance, so a mutation's counts hold across calls.
      let wrapped = Option.none<{
        readonly inner: HarnessSeam["Service"];
        readonly seam: HarnessSeam["Service"];
      }>();

      const seamNow = Effect.map(target.seam, (inner) => {
        if (Option.isSome(wrapped) && wrapped.value.inner === inner) {
          return wrapped.value.seam;
        }

        const seam = breakSeam(inner, options.mutations, mutationState);

        wrapped = Option.some({ inner, seam });

        return seam;
      });

      const applyFrame = (item: ThreadStreamItem) =>
        Effect.gen(function* () {
          const next = applyThreadStreamItem(yield* Ref.get(client), item);

          if (Result.isFailure(next)) {
            return yield* new ScenarioFailure({
              message: next.failure.message,
            });
          }

          return yield* Ref.set(client, Option.some(next.success));
        });

      // A client following the thread: a refused frame or an ended stream means a fresh subscription.
      const follow = (seam: HarnessSeam["Service"]) =>
        Effect.gen(function* () {
          if (progress.ensured) {
            yield* Ref.set(client, Option.none());
            yield* seam
              .watch(THREAD_ID)
              .pipe(Stream.runForEach(applyFrame), Effect.ignore);
          }

          yield* Effect.sleep(POLL);
        }).pipe(Effect.forever);

      const startFeeds = Effect.gen(function* () {
        const seam = yield* seamNow;

        feeds.push(
          yield* seam.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              })
            ),
            Effect.forkScoped
          ),
          yield* follow(seam).pipe(Effect.forkScoped)
        );

        // Let the subscriptions start, then let the harness run what a restart left.
        yield* Effect.sleep(Duration.millis(30));
        yield* target.resume;
      });

      const restart = Effect.gen(function* () {
        yield* Effect.forEach(feeds.splice(0), Fiber.interrupt, {
          discard: true,
        });
        yield* target.restart;
        yield* startFeeds;
      });

      const normalized = Effect.map(Ref.get(client), (state) =>
        Option.map(state, (found) => normalizeView(found.view))
      );

      const ensure = (where: string) =>
        Effect.flatMap(seamNow, (seam) =>
          seam
            .ensureThread({
              threadId: THREAD_ID,
              projectId: PROJECT_ID,
              model: FAUX_MODEL,
              thinkingLevel: "off",
              cwd: process.cwd(),
              instructions: Option.none(),
            })
            .pipe(Effect.mapError(fromSeam(where)))
        );

      const submitStep = Effect.fn("Conformance.submit")(function* (
        where: string,
        line: InputLine
      ) {
        const seam = yield* seamNow;
        const expect = line.expect ?? {};

        const result = yield* Effect.result(
          seam.submit(THREAD_ID, turnInput(line))
        );

        if (Result.isFailure(result)) {
          return expect.error === result.failure.reason
            ? yield* Effect.void
            : yield* new ScenarioFailure({
                message: `${where}: submit failed with ${result.failure.reason}: ${result.failure.message}`,
              });
        }

        if (expect.error === undefined) {
          const earlier = Option.fromUndefinedOr(
            submissions.get(expect.sameSubmissionAs ?? "")
          );

          if (
            expect.sameSubmissionAs !== undefined &&
            !Option.contains(earlier, result.success.submissionId)
          ) {
            return yield* new ScenarioFailure({
              message: `${where}: submission ${result.success.submissionId} differs from the one of ${expect.sameSubmissionAs}`,
            });
          }

          submissions.set(line.requestId ?? "", result.success.submissionId);

          return yield* Effect.void;
        }

        return yield* new ScenarioFailure({
          message: `${where}: submit succeeded, expected ${expect.error}`,
        });
      });

      const withdrawStep = Effect.fn("Conformance.withdraw")(function* (
        where: string,
        line: InputLine
      ) {
        const seam = yield* seamNow;
        const submissionId = submissions.get(line.requestId ?? "");

        if (submissionId === undefined) {
          return yield* new ScenarioFailure({
            message: `${where}: no submission for ${line.requestId ?? "(none)"}`,
          });
        }

        const result = yield* seam
          .withdraw(THREAD_ID, submissionId)
          .pipe(Effect.mapError(fromSeam(where)));

        const expected = line.expect?.withdrawn;

        if (expected !== undefined && expected !== result.withdrawn) {
          return yield* new ScenarioFailure({
            message: `${where}: withdrawn was ${result.withdrawn}`,
          });
        }

        return yield* Effect.void;
      });

      const respondStep = Effect.fn("Conformance.respond")(function* (
        where: string,
        line: InputLine
      ) {
        const seam = yield* seamNow;

        const pending = Effect.map(Ref.get(client), (state) =>
          Option.flatMap(state, (found) =>
            Option.fromUndefinedOr(pendingApprovalIds(found.view)[0])
          )
        );

        yield* eventually(
          options.timeout,
          where,
          Effect.map(pending, (found) =>
            Option.isSome(found)
              ? Option.none()
              : Option.some("no pending approval in the client's view")
          )
        );

        const approval = yield* pending;

        const approvalId = yield* decodeApprovalId(
          Option.getOrElse(approval, () => "")
        ).pipe(
          Effect.mapError(
            () => new ScenarioFailure({ message: `${where}: no approval id` })
          )
        );

        yield* seam
          .respond(THREAD_ID, approvalId, line.decision ?? "accept")
          .pipe(Effect.mapError(fromSeam(where)));
      });

      const inputSteps: Record<
        InputLine["step"],
        (
          where: string,
          line: InputLine
        ) => Effect.Effect<void, ScenarioFailure, Scope.Scope>
      > = {
        ensure: (where) =>
          Effect.map(ensure(where), () => {
            progress.ensured = true;
          }),
        ensure_race: (where, line) =>
          Effect.gen(function* () {
            const [a, b] = yield* Effect.all([ensure(where), ensure(where)], {
              concurrency: 2,
            });

            progress.ensured = true;

            if (
              line.expect?.sameConversation === true &&
              a.conversationId !== b.conversationId
            ) {
              return yield* new ScenarioFailure({
                message: `${where}: raced ensures made conversations ${a.conversationId} and ${b.conversationId}`,
              });
            }

            return yield* Effect.void;
          }),
        message: submitStep,
        steer: submitStep,
        follow_up: submitStep,
        stop: (where) =>
          Effect.flatMap(seamNow, (seam) =>
            seam
              .stop(THREAD_ID, { clearQueue: false })
              .pipe(Effect.mapError(fromSeam(where)))
          ),
        stop_clear: (where) =>
          Effect.flatMap(seamNow, (seam) =>
            seam
              .stop(THREAD_ID, { clearQueue: true })
              .pipe(Effect.mapError(fromSeam(where)))
          ),
        withdraw: withdrawStep,
        respond: respondStep,
        compact: (where) =>
          Effect.flatMap(seamNow, (seam) =>
            seam
              .compact(THREAD_ID, Option.none())
              .pipe(Effect.mapError(fromSeam(where)))
          ),
        restart: () => restart,
      };

      const findEvent = (expected: Json) =>
        Effect.sync(() => {
          const found = events.findIndex(
            (event, at) =>
              at >= progress.cursor &&
              jsonContains(expected, encodeEvent(event))
          );

          if (found === -1) {
            return Option.some(
              `no such event after position ${progress.cursor}; seen ${JSON.stringify(events.slice(progress.cursor).map((event) => event._tag))}`
            );
          }

          progress.cursor = found + 1;

          return Option.none<string>();
        });

      const countEvents = (expected: Json, count: number) =>
        Effect.sync(() => {
          const counted = events.filter((event) =>
            jsonContains(expected, encodeEvent(event))
          ).length;

          return counted === count
            ? Option.none<string>()
            : Option.some(`counted ${counted}`);
        });

      const viewAt = (path: ReadonlyArray<string | number>, equals: Json) =>
        Effect.map(normalized, (view) => {
          if (Option.isNone(view)) {
            return Option.some("the client has no snapshot");
          }

          const value = valueAt(view.value, path);

          if (Option.isSome(value) && jsonEquals(value.value, equals)) {
            return Option.none<string>();
          }

          return Option.some(
            `found ${JSON.stringify(Option.getOrNull(value))} in ${JSON.stringify(view.value)}`
          );
        });

      const play = (where: string, line: TranscriptLine) =>
        Match.value(line).pipe(
          Match.discriminatorsExhaustive("type")({
            transcript_start: () => Effect.void,
            model: () => Effect.void,
            input: (found) => inputSteps[found.step](where, found),
            crash: () => restart,
            release: (found) => script.release(found.label),
            settle: (found) => Effect.sleep(Duration.millis(found.ms)),
            expect_event: (found) =>
              eventually(options.timeout, where, findEvent(found.event)),
            expect_event_count: (found) =>
              eventually(
                options.timeout,
                where,
                countEvents(found.event, found.count)
              ),
            expect_view: (found) =>
              eventually(
                options.timeout,
                where,
                viewAt(found.path, found.equals)
              ),
          })
        );

      const result = yield* Effect.result(
        Effect.gen(function* () {
          yield* startFeeds;

          for (const [index, line] of scenario.lines.entries()) {
            yield* play(describeLine(index, line), line);
          }
        })
      );

      const finalView = yield* normalized;

      return {
        scenario: scenario.name,
        failure: Result.match(result, {
          onFailure: (failure) => Option.some(failure.message),
          onSuccess: () => Option.none<string>(),
        }),
        record: {
          events: events.flatMap((event) => Option.toArray(maskEvent(event))),
          view: Option.getOrNull(finalView),
        },
      };
    })
  );

/** The part of the test framework the suite needs: vitest's `describe` and `it`. */
export interface ConformanceRunner {
  readonly describe: typeof describe;
  readonly it: typeof it;
}

/**
 * Registers one test per scenario against the harness `makeTarget` builds. Each test fails with
 * the line that did not hold and what the client saw instead.
 */
export const registerHarnessConformance = (
  runner: ConformanceRunner,
  name: string,
  makeTarget: MakeTarget,
  scenarios: ReadonlyArray<Scenario>,
  options: RunOptions
) => {
  runner.describe(name, () => {
    for (const scenario of scenarios) {
      runner.it(
        scenario.name,
        async () => {
          const outcome = await Effect.runPromise(
            runScenario(scenario, makeTarget, options)
          );

          if (Option.isSome(outcome.failure)) {
            throw new Error(`${scenario.name}: ${outcome.failure.value}`);
          }
        },
        60_000
      );
    }
  });
};
