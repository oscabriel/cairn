// The replay conformance suite of the harness seam (ADR 0024), in the shape of pi-durable's
// `registerEnvConformance`: `registerHarnessConformance(runner, name, makeTarget, scenarios)`
// registers one test per scenario against one harness, and `runScenario` runs one scenario and
// reports how it went, which the mutation check and the drift goldens also use.
//
// A run plays the scenario's lines in order. The harness's events are logged as they arrive, and a
// client built on @cairn/client-logic's ThreadView follows each thread's stream exactly as the web
// client does (a refused frame means a fresh subscription): the scenario's own thread from its
// ensure, and each subagent from the event that first names it (ThreadAliases). Expectations wait
// up to a timeout for the log or a client's normalized view to show what the line says, so the
// suite judges what a client would see, not internal state.

import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { ApprovalId, ProjectId, ThreadId } from "@cairn/protocol/Ids";
import type { SubmissionId } from "@cairn/protocol/Ids";
import { DEFAULT_RUNTIME_MODE } from "@cairn/protocol/Policy";
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
  ApprovalAnswerInput,
  HarnessError,
  HarnessSeam,
  HarnessTurnInput,
} from "../HarnessSeam.ts";
import { FAUX_MODEL } from "../ModelSource.ts";
import type { Mutation, MutationState } from "./Mutations.ts";
import { breakSeam, faultsOf } from "./Mutations.ts";
import {
  jsonContains,
  jsonEquals,
  normalizeDeviceView,
  normalizeView,
  pendingApprovalIds,
  valueAt,
} from "./Normalize.ts";
import { responseScript } from "./ResponseScript.ts";
import type { MakeTarget } from "./Targets.ts";
import {
  maskThreadIds,
  threadAliasesOf,
  PARENT_ALIAS,
  resolveAliases,
} from "./ThreadAliases.ts";
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

/** How long a `subscribe` line gives its subscription to start waiting before the next line. */
const SUBSCRIBE_SETTLE = Duration.millis(100);

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
  /** The masked events and final views, for the drift goldens. */
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

/** A masked event: a JSON object. */
interface Masked {
  readonly [key: string]: Json;
}

/** An event with ids and times masked, for the goldens; none for noisy bookkeeping events. */
const maskEvent = (
  event: HarnessEvent,
  aliasOf: (threadId: ThreadId) => string
): Option.Option<Masked> => {
  const masked = Match.value(event).pipe(
    Match.tagsExhaustive({
      ThreadEnsured: (found) =>
        Option.some<Masked>(
          Option.match(found.parent, {
            onNone: () => ({ event: "ThreadEnsured" }),
            onSome: (parent) => ({
              event: "ThreadEnsured",
              parent: aliasOf(parent),
            }),
          })
        ),
      RunStarted: () => Option.some<Masked>({ event: "RunStarted" }),
      RunTerminal: (found) =>
        Option.some<Masked>({
          event: found._tag,
          status: found.status,
          failure: Option.match(found.failure, {
            onNone: () => null,
            onSome: (failure) => failure.class,
          }),
        }),
      MessageCommitted: (found) =>
        Option.some<Masked>({
          event: found._tag,
          role: found.role,
          text: found.text,
        }),
      QueueChanged: () => Option.none<Masked>(),
      RuntimeRequestUpdated: (found) =>
        Option.some<Masked>({ event: found._tag, status: found.status }),
      UsageUpdated: () => Option.none<Masked>(),
      SubagentUpdated: (found) =>
        Option.some<Masked>({
          event: found._tag,
          child: aliasOf(found.child),
          status: found.status,
        }),
      TaskParked: () => Option.none<Masked>(),
      CompactionStarted: () =>
        Option.some<Masked>({ event: "CompactionStarted" }),
      CompactionEnded: (found) =>
        Option.some<Masked>({ event: found._tag, failed: found.failed }),
    })
  );

  const thread = aliasOf(event.threadId);

  // The scenario's own thread stays unnamed, so single-thread goldens read as they always did.
  return thread === PARENT_ALIAS
    ? masked
    : Option.map(masked, (found) => ({ thread, ...found }));
};

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

/**
 * The answer a respond line gives: its decision and reason, and a question's answers (in full, as
 * the picked labels and custom text of the first question, or as one custom answer to it).
 */
const answerOf = (line: InputLine): ApprovalAnswerInput => ({
  decision: line.decision ?? "accept",
  reason: Option.fromUndefinedOr(line.reason),
  answers: Option.orElse(Option.fromUndefinedOr(line.answers), () =>
    line.answer === undefined && line.picks === undefined
      ? Option.none()
      : Option.some([
          {
            index: 0,
            picks: line.picks === undefined ? [] : [...line.picks],
            custom: line.answer ?? null,
          },
        ])
  ),
});

/** Waits until `check` finds nothing wrong, or fails with its last complaint. */
const eventually = <A>(
  timeout: Duration.Duration,
  where: string,
  check: Effect.Effect<Result.Result<A, string>>
) =>
  Effect.gen(function* () {
    const deadline =
      (yield* Clock.currentTimeMillis) + Duration.toMillis(timeout);

    let outcome = yield* check;

    while (Result.isFailure(outcome)) {
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* new ScenarioFailure({
          message: `${where}: ${outcome.failure}`,
        });
      }

      yield* Effect.sleep(POLL);
      outcome = yield* check;
    }

    return outcome.success;
  });

/** A check that holds or names what it saw instead. */
const holds = (complaint: Option.Option<string>) =>
  Option.match(complaint, {
    onNone: () => Result.succeedNone,
    onSome: (text) => Result.fail(text),
  });

const fromSeam = (where: string) => (failure: HarnessError) =>
  new ScenarioFailure({ message: `${where}: ${failure.message}` });

/** Applies one stream item to a client's view; a refused frame fails the follow. */
const applyFrame =
  (client: Ref.Ref<Option.Option<ThreadViewState>>) =>
  (item: ThreadStreamItem) =>
    Effect.gen(function* () {
      const next = applyThreadStreamItem(yield* Ref.get(client), item);

      if (Result.isFailure(next)) {
        return yield* new ScenarioFailure({
          message: next.failure.message,
        });
      }

      return yield* Ref.set(client, Option.some(next.success));
    });

// A named client: subscribes to the thread, and subscribes afresh after a refused frame or an
// ended stream, as a second page on another device does.
const followDevice = (
  seam: HarnessSeam["Service"],
  threadId: ThreadId,
  view: Ref.Ref<Option.Option<ThreadViewState>>
) =>
  Effect.gen(function* () {
    yield* Ref.set(view, Option.none());
    yield* seam
      .watch(threadId)
      .pipe(Stream.runForEach(applyFrame(view)), Effect.ignore);
    yield* Effect.sleep(POLL);
  }).pipe(Effect.forever);

const deviceKey = (alias: string | undefined, device: string) =>
  `${alias ?? PARENT_ALIAS}/${device}`;

/** Runs one scenario against one harness. Never fails: a failure is in the outcome. */
export const runScenario = (
  scenario: Scenario,
  makeTarget: MakeTarget,
  options: RunOptions
): Effect.Effect<ScenarioOutcome> =>
  Effect.scoped(
    Effect.gen(function* () {
      const aliases = threadAliasesOf(THREAD_ID);

      const script = yield* responseScript(
        scenario.lines.filter(isModelLine),
        aliases
      );

      const target = yield* makeTarget(script, faultsOf(options.mutations));
      const events: Array<HarnessEvent> = [];

      // One client per thread the scenario met, each holding the view it follows.
      const views = new Map<
        ThreadId,
        Ref.Ref<Option.Option<ThreadViewState>>
      >();

      // Named clients on a thread (`open_device`), by `<thread alias>/<device>`, and the record each
      // last looked at.
      const devices = new Map<
        string,
        {
          readonly threadId: ThreadId;
          readonly view: Ref.Ref<Option.Option<ThreadViewState>>;
        }
      >();

      const looked = new Map<string, string>();
      const submissions = new Map<string, SubmissionId>();
      const feeds: Array<Fiber.Fiber<void>> = [];
      const mutationState: MutationState = { inputs: new Map() };
      // `subscribed`: a `subscribe` line opened the client's one subscription, so `follow` stands
      // down and a subscription that fails is not quietly reopened.
      const progress = { cursor: 0, ensured: false, subscribed: false };

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

      const clientOf = Effect.fnUntraced(function* (threadId: ThreadId) {
        const existing = views.get(threadId);

        if (existing !== undefined) {
          return existing;
        }

        const created = yield* Ref.make(Option.none<ThreadViewState>());

        views.set(threadId, created);

        return created;
      });

      // A client following one thread: a refused frame or an ended stream means a fresh
      // subscription. The scenario's own thread waits for its ensure and stands down for a
      // `subscribe` line; a subagent is followed from the event that named it.
      const follow = (seam: HarnessSeam["Service"], threadId: ThreadId) =>
        Effect.gen(function* () {
          const client = yield* clientOf(threadId);
          const own = threadId === THREAD_ID;

          if (!own || (progress.ensured && !progress.subscribed)) {
            yield* Ref.set(client, Option.none());
            yield* seam
              .watch(threadId)
              .pipe(Stream.runForEach(applyFrame(client)), Effect.ignore);
          }

          yield* Effect.sleep(POLL);
        }).pipe(Effect.forever);

      const startFeeds = Effect.gen(function* () {
        const seam = yield* seamNow;

        feeds.push(
          yield* seam.events.pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                events.push(event);

                const child = aliases.learn(event);

                if (Option.isSome(child)) {
                  feeds.push(
                    yield* follow(seam, child.value).pipe(Effect.forkScoped)
                  );
                }
              })
            ),
            Effect.forkScoped
          )
        );

        for (const threadId of aliases.threads()) {
          feeds.push(yield* follow(seam, threadId).pipe(Effect.forkScoped));
        }

        for (const device of devices.values()) {
          feeds.push(
            yield* followDevice(seam, device.threadId, device.view).pipe(
              Effect.forkScoped
            )
          );
        }

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

      const normalized = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const client = views.get(threadId);

          if (client === undefined) {
            return Option.none<Json>();
          }

          return Option.map(yield* Ref.get(client), (state) =>
            normalizeView(state.view)
          );
        });

      /** The thread an alias names, once the harness reported it. */
      const threadOf = (where: string, alias: string | undefined) =>
        eventually(
          options.timeout,
          where,
          Effect.sync(() =>
            Option.match(aliases.idOf(alias ?? PARENT_ALIAS), {
              onNone: () =>
                Result.fail(`no thread is known as ${alias ?? PARENT_ALIAS}`),
              onSome: (found) => Result.succeed(found),
            })
          )
        );

      const ensure = (where: string, line: InputLine) =>
        Effect.flatMap(seamNow, (seam) =>
          seam
            .ensureThread({
              threadId: THREAD_ID,
              projectId: PROJECT_ID,
              model: FAUX_MODEL,
              thinkingLevel: "off",
              cwd: process.cwd(),
              instructions: Option.none(),
              runtimeMode: line.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            })
            .pipe(Effect.mapError(fromSeam(where)))
        );

      const configureStep = Effect.fn("Conformance.configure")(function* (
        where: string,
        line: InputLine
      ) {
        const seam = yield* seamNow;
        const expected = line.expect?.error;

        const result = yield* Effect.result(
          seam.configure(THREAD_ID, {
            model: Option.none(),
            thinkingLevel: Option.none(),
            cwd: Option.none(),
            runtimeMode: Option.fromUndefinedOr(line.runtimeMode),
          })
        );

        if (Result.isFailure(result)) {
          return expected === result.failure.reason
            ? yield* Effect.void
            : yield* new ScenarioFailure({
                message: `${where}: configure failed with ${result.failure.reason}: ${result.failure.message}`,
              });
        }

        return expected === undefined
          ? yield* Effect.void
          : yield* new ScenarioFailure({
              message: `${where}: configure succeeded, expected ${expected}`,
            });
      });

      const submitStep = Effect.fn("Conformance.submit")(function* (
        where: string,
        line: InputLine
      ) {
        const seam = yield* seamNow;
        const expect = line.expect ?? {};
        const threadId = yield* threadOf(where, line.thread);

        const result = yield* Effect.result(
          seam.submit(threadId, turnInput(line))
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
        const threadId = yield* threadOf(where, line.thread);
        const submissionId = submissions.get(line.requestId ?? "");

        if (submissionId === undefined) {
          return yield* new ScenarioFailure({
            message: `${where}: no submission for ${line.requestId ?? "(none)"}`,
          });
        }

        const result = yield* seam
          .withdraw(threadId, submissionId)
          .pipe(Effect.mapError(fromSeam(where)));

        const expected = line.expect?.withdrawn;

        if (expected !== undefined && expected !== result.withdrawn) {
          return yield* new ScenarioFailure({
            message: `${where}: withdrawn was ${result.withdrawn}`,
          });
        }

        return yield* Effect.void;
      });

      // The records this run answered, by `<thread>:<id>`: a client view can lag the answer's
      // commit, so the next respond must not take a record it already answered for a pending one.
      const answered = new Set<string>();

      /** The client a line reads or acts through: a named device, or the thread's own client. */
      const clientFor = (where: string, line: InputLine) =>
        Effect.gen(function* () {
          const threadId = yield* threadOf(where, line.thread);

          if (line.device === undefined) {
            return { threadId, client: yield* clientOf(threadId) };
          }

          const device = devices.get(deviceKey(line.thread, line.device));

          if (device === undefined) {
            return yield* new ScenarioFailure({
              message: `${where}: no device ${line.device} is open on ${line.thread ?? PARENT_ALIAS}`,
            });
          }

          return { threadId, client: device.view };
        });

      /** The oldest pending approval this run has not answered in a client's view, waited for. */
      const pendingIn = (
        where: string,
        threadId: ThreadId,
        client: Ref.Ref<Option.Option<ThreadViewState>>
      ) =>
        Effect.gen(function* () {
          const found = yield* eventually(
            options.timeout,
            where,
            Effect.map(Ref.get(client), (state) =>
              Option.match(
                Option.flatMap(state, (view) =>
                  Option.fromUndefinedOr(
                    pendingApprovalIds(view.view).find(
                      (id) => !answered.has(`${threadId}:${id}`)
                    )
                  )
                ),
                {
                  onNone: () =>
                    Result.fail("no pending approval in the client's view"),
                  onSome: (id) => Result.succeed(id),
                }
              )
            )
          );

          return yield* decodeApprovalId(found).pipe(
            Effect.mapError(
              () => new ScenarioFailure({ message: `${where}: no approval id` })
            )
          );
        });

      const lookedAt = (where: string, line: InputLine) =>
        Effect.gen(function* () {
          const seen = looked.get(deviceKey(line.thread, line.device ?? ""));

          if (seen === undefined) {
            return yield* new ScenarioFailure({
              message: `${where}: device ${line.device ?? "(none)"} looked at no record`,
            });
          }

          return yield* decodeApprovalId(seen).pipe(
            Effect.mapError(
              () => new ScenarioFailure({ message: `${where}: no approval id` })
            )
          );
        });

      const respondStep = Effect.fn("Conformance.respond")(function* (
        where: string,
        line: InputLine
      ) {
        const seam = yield* seamNow;
        const { threadId, client } = yield* clientFor(where, line);

        const approvalId =
          line.stale === true
            ? yield* lookedAt(where, line)
            : yield* pendingIn(where, threadId, client);

        const result = yield* Effect.result(
          seam.respond(threadId, approvalId, answerOf(line))
        );

        // A refused answer leaves the record pending for the next respond.
        if (Result.isSuccess(result)) {
          answered.add(`${threadId}:${approvalId}`);
        }

        const expected = line.expect?.error;

        if (Result.isFailure(result)) {
          return expected === result.failure.reason
            ? yield* Effect.void
            : yield* new ScenarioFailure({
                message: `${where}: respond failed with ${result.failure.reason}: ${result.failure.message}`,
              });
        }

        return expected === undefined
          ? yield* Effect.void
          : yield* new ScenarioFailure({
              message: `${where}: respond succeeded, expected ${expected}`,
            });
      });

      const openDeviceStep = Effect.fn("Conformance.openDevice")(function* (
        where: string,
        line: InputLine
      ) {
        const seam = yield* seamNow;
        const threadId = yield* threadOf(where, line.thread);
        const key = deviceKey(line.thread, line.device ?? "device");

        if (devices.has(key)) {
          return yield* new ScenarioFailure({
            message: `${where}: device ${key} is already open`,
          });
        }

        const view = yield* Ref.make(Option.none<ThreadViewState>());

        devices.set(key, { threadId, view });
        feeds.push(
          yield* followDevice(seam, threadId, view).pipe(Effect.forkScoped)
        );

        return yield* Effect.sleep(SUBSCRIBE_SETTLE);
      });

      const lookStep = Effect.fn("Conformance.look")(function* (
        where: string,
        line: InputLine
      ) {
        const { threadId, client } = yield* clientFor(where, line);
        const approvalId = yield* pendingIn(where, threadId, client);

        looked.set(deviceKey(line.thread, line.device ?? ""), approvalId);
      });

      // Each thread's oldest pending record, then every answer at once.
      const respondRaceStep = Effect.fn("Conformance.respondRace")(function* (
        where: string,
        line: InputLine
      ) {
        const seam = yield* seamNow;

        const targets = yield* Effect.forEach(line.threads ?? [], (alias) =>
          Effect.gen(function* () {
            const threadId = yield* threadOf(where, alias);
            const client = yield* clientOf(threadId);

            return {
              threadId,
              approvalId: yield* pendingIn(where, threadId, client),
            };
          })
        );

        for (const { threadId, approvalId } of targets) {
          answered.add(`${threadId}:${approvalId}`);
        }

        yield* Effect.forEach(
          targets,
          ({ threadId, approvalId }) =>
            seam
              .respond(threadId, approvalId, answerOf(line))
              .pipe(Effect.mapError(fromSeam(where))),
          { concurrency: "unbounded", discard: true }
        );
      });

      const stopStep =
        (clearQueue: boolean, subagents: "keep" | "stop") =>
        (where: string, line: InputLine) =>
          Effect.gen(function* () {
            const seam = yield* seamNow;
            const threadId = yield* threadOf(where, line.thread);

            yield* seam
              .stop(threadId, { clearQueue, subagents })
              .pipe(Effect.mapError(fromSeam(where)));
          });

      const modeStep = Effect.fn("Conformance.mode")(function* (
        where: string,
        line: InputLine
      ) {
        const seam = yield* seamNow;
        const threadId = yield* threadOf(where, line.thread);

        const result = yield* Effect.result(
          seam.configure(threadId, {
            model: Option.none(),
            thinkingLevel: Option.none(),
            cwd: Option.none(),
            runtimeMode: Option.some(line.mode ?? "full-access"),
          })
        );

        const expected = line.expect?.error;

        if (Result.isFailure(result)) {
          return expected === result.failure.reason
            ? yield* Effect.void
            : yield* new ScenarioFailure({
                message: `${where}: mode failed with ${result.failure.reason}: ${result.failure.message}`,
              });
        }

        return expected === undefined
          ? yield* Effect.void
          : yield* new ScenarioFailure({
              message: `${where}: mode succeeded, expected ${expected}`,
            });
      });

      const inputSteps: Record<
        InputLine["step"],
        (
          where: string,
          line: InputLine
        ) => Effect.Effect<void, ScenarioFailure, Scope.Scope>
      > = {
        ensure: (where, line) =>
          Effect.map(ensure(where, line), () => {
            progress.ensured = true;
          }),
        ensure_race: (where, line) =>
          Effect.gen(function* () {
            const [a, b] = yield* Effect.all(
              [ensure(where, line), ensure(where, line)],
              { concurrency: 2 }
            );

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
        subscribe: () =>
          Effect.gen(function* () {
            const seam = yield* seamNow;
            const client = yield* clientOf(THREAD_ID);

            progress.subscribed = true;

            yield* Stream.unwrap(
              Effect.as(seam.whenEnsured(THREAD_ID), seam.watch(THREAD_ID))
            ).pipe(
              Stream.runForEach(applyFrame(client)),
              Effect.ignore,
              Effect.forkScoped
            );
            yield* Effect.sleep(SUBSCRIBE_SETTLE);
          }),
        configure: configureStep,
        message: submitStep,
        steer: submitStep,
        follow_up: submitStep,
        stop: stopStep(false, "keep"),
        stop_clear: stopStep(true, "keep"),
        stop_all: stopStep(false, "stop"),
        withdraw: withdrawStep,
        respond: respondStep,
        respond_race: respondRaceStep,
        mode: modeStep,
        compact: (where) =>
          Effect.flatMap(seamNow, (seam) =>
            seam
              .compact(THREAD_ID, Option.none())
              .pipe(Effect.mapError(fromSeam(where)))
          ),
        restart: () => restart,
        open_device: openDeviceStep,
        look: lookStep,
      };

      const findEvent = (expected: Json) =>
        Effect.sync(() => {
          const wanted = resolveAliases(expected, aliases);

          const found = events.findIndex(
            (event, at) =>
              at >= progress.cursor && jsonContains(wanted, encodeEvent(event))
          );

          if (found === -1) {
            return Result.fail(
              `no such event after position ${progress.cursor}; seen ${JSON.stringify(events.slice(progress.cursor).map((event) => event._tag))}`
            );
          }

          progress.cursor = found + 1;

          return Result.succeedNone;
        });

      const countEvents = (expected: Json, count: number) =>
        Effect.sync(() => {
          const wanted = resolveAliases(expected, aliases);

          const counted = events.filter((event) =>
            jsonContains(wanted, encodeEvent(event))
          ).length;

          return holds(
            counted === count
              ? Option.none()
              : Option.some(`counted ${counted}`)
          );
        });

      const viewAt = (
        alias: string | undefined,
        device: string | undefined,
        path: ReadonlyArray<string | number>,
        equals: Json,
        match: "equals" | "includes"
      ) =>
        Effect.gen(function* () {
          const threadId = aliases.idOf(alias ?? PARENT_ALIAS);

          if (Option.isNone(threadId)) {
            return Result.fail(
              `no thread is known as ${alias ?? PARENT_ALIAS}`
            );
          }

          const named =
            device === undefined
              ? undefined
              : devices.get(deviceKey(alias, device));

          if (device !== undefined && named === undefined) {
            return Result.fail(`no device ${device} is open`);
          }

          const view =
            named === undefined
              ? yield* normalized(threadId.value)
              : Option.map(yield* Ref.get(named.view), (state) =>
                  normalizeDeviceView(state.view)
                );

          if (Option.isNone(view)) {
            return Result.fail("the client has no snapshot");
          }

          const value = valueAt(view.value, path);

          const wanted = resolveAliases(equals, aliases);

          const found = Option.exists(value, (at) =>
            match === "includes"
              ? Array.isArray(at) &&
                at.some((element: Json) => jsonEquals(element, wanted))
              : jsonEquals(at, wanted)
          );

          if (found) {
            return Result.succeedNone;
          }

          return Result.fail(
            `found ${JSON.stringify(Option.getOrNull(value))} in ${JSON.stringify(view.value)}`
          );
        });

      /** What the `index`th request of a thread offered and asked, against a line's wants. */
      const requestAt = (
        alias: string | undefined,
        index: number,
        wants: {
          readonly includesTools?: ReadonlyArray<string>;
          readonly excludesTools?: ReadonlyArray<string>;
          readonly firstInput?: string;
        }
      ) =>
        Effect.sync(() => {
          const threadId = aliases.idOf(alias ?? PARENT_ALIAS);

          if (Option.isNone(threadId)) {
            return Result.fail(
              `no thread is known as ${alias ?? PARENT_ALIAS}`
            );
          }

          const request = script.requestsOf(threadId.value).at(index);

          if (request === undefined) {
            return Result.fail(`no request ${index} was made`);
          }

          const missing = (wants.includesTools ?? []).filter(
            (name) => !request.tools.includes(name)
          );

          const extra = (wants.excludesTools ?? []).filter((name) =>
            request.tools.includes(name)
          );

          const input = resolveAliases(wants.firstInput ?? null, aliases);

          if (
            missing.length > 0 ||
            extra.length > 0 ||
            (wants.firstInput !== undefined && input !== request.firstInput)
          ) {
            return Result.fail(
              `request ${index} offered ${JSON.stringify(request.tools)} and began ${JSON.stringify(request.firstInput)}`
            );
          }

          return Result.succeedNone;
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
                viewAt(
                  found.thread,
                  found.device,
                  found.path,
                  found.equals,
                  found.match ?? "equals"
                )
              ),
            expect_request: (found) =>
              eventually(
                options.timeout,
                where,
                requestAt(found.thread, found.index, found)
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

      const aliasOf = (threadId: ThreadId) =>
        Option.getOrElse(aliases.aliasOf(threadId), () => "unknown");

      // Each thread's events in the order they came, the scenario's own first, so a golden does
      // not depend on how two threads' work interleaved.
      const order = aliases.threads();

      const ranked = events
        .map((event, at) => ({
          event,
          at,
          rank: order.indexOf(event.threadId),
        }))
        .toSorted((a, b) => a.rank - b.rank || a.at - b.at);

      const children: { [alias: string]: Json } = {};

      for (const threadId of order.slice(1)) {
        children[aliasOf(threadId)] = Option.getOrNull(
          yield* normalized(threadId)
        );
      }

      const record = {
        events: ranked.flatMap(({ event }) =>
          Option.toArray(maskEvent(event, aliasOf))
        ),
        view: Option.getOrNull(yield* normalized(THREAD_ID)),
      };

      return {
        scenario: scenario.name,
        failure: Result.match(result, {
          onFailure: (failure) => Option.some(failure.message),
          onSuccess: () => Option.none<string>(),
        }),
        // Texts name a child by alias: each harness mints child ids its own way.
        record: maskThreadIds(
          order.length > 1 ? { ...record, children } : record,
          aliases
        ),
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
