// The Executor tool suite on the fake Executor: the approval sandwich (accept in one call, decline,
// expiry, a rerun after `started`), a session lost to an Executor restart, `input-required`
// cancelled, the boot sweep, one refresh shared by concurrent calls, and a sign-in after the grant
// was revoked. Ported in part from cairn-v1, apps/server/test/executor.test.ts at 1a5cd4a.
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Option, Result } from "effect";

import { ExecutorLink } from "./ExecutorLink.ts";
import { RERUN_AFTER_START } from "./ExecutorReply.ts";
import type { JsonObject } from "./ExecutorReply.ts";
import { ExecutorSweep } from "./ExecutorSweep.ts";
import { fakeLink, firstAttempt, memoryLedger } from "./ExecutorTestKit.ts";
import { startFakeExecutor } from "./FakeExecutor.ts";
import type { FakeExecutorHandle } from "./FakeExecutor.ts";
import { gatedCall } from "./GatedCall.ts";

const callRequest = (path: string, input: JsonObject) => ({
  kind: "call" as const,
  request: { calls: [{ path, input }] },
  summary: path,
  autoAccept: true,
});

/** Runs `body` against a fresh fake Executor and a link to it. */
const withFake = <A, E>(
  body: (fake: FakeExecutorHandle) => Effect.Effect<A, E, ExecutorLink>,
  options: {
    readonly pingInterval?: Duration.Duration;
    readonly setup?: (fake: FakeExecutorHandle) => void;
  } = {}
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* startFakeExecutor;

      options.setup?.(fake);

      const link = fakeLink(
        fake,
        options.pingInterval === undefined
          ? {}
          : { pingInterval: options.pingInterval }
      );

      return yield* body(fake).pipe(Effect.provide(link));
    })
  );

describe("the gated call", () => {
  it.live("accepts Executor's approval in the same call and records it", () =>
    withFake((fake) =>
      Effect.gen(function* () {
        const { ledger, record } = firstAttempt();

        const outcome = yield* gatedCall(
          ledger,
          callRequest("tools.spike.mark", { id: "a" })
        );

        assert.isFalse(outcome.isError, outcome.text);
        assert.deepStrictEqual(Option.getOrNull(outcome.value), {
          marked: "a",
          count: 1,
        });
        assert.deepStrictEqual(fake.marks, ["a"]);
        assert.strictEqual(fake.calls("call").length, 1);
        assert.strictEqual(fake.calls("resume").length, 1);

        const kept = Option.getOrThrow(record());

        assert.strictEqual(kept.status, "accepted");
        assert.strictEqual(kept.run, "done");
        assert.strictEqual(kept.executorRequestId, "apr_1");
      })
    )
  );

  it.live("sends nothing when Cairn's approval is declined", () =>
    withFake((fake) =>
      Effect.gen(function* () {
        const { ledger, record } = memoryLedger({
          prior: Option.none(),
          answer: "declined",
        });

        const outcome = yield* gatedCall(ledger, {
          ...callRequest("tools.spike.mark", { id: "b" }),
          autoAccept: false,
        });

        assert.isTrue(outcome.isError);
        assert.include(outcome.text, "declined, so nothing was sent");
        assert.strictEqual(fake.state.log.length, 0);
        assert.isNull(Option.getOrThrow(record()).run);
      })
    )
  );

  it.live("declines a program's nested approval outside full access", () =>
    withFake((fake) =>
      Effect.gen(function* () {
        const { ledger } = memoryLedger({
          prior: Option.none(),
          answer: "accepted",
        });

        const outcome = yield* gatedCall(ledger, {
          kind: "execute",
          request: { code: "await tools.spike.mark({ id: 'x' })" },
          summary: "program",
          autoAccept: false,
        });

        assert.isTrue(outcome.isError);
        assert.include(outcome.text, "declined it");
        assert.deepStrictEqual(fake.marks, []);
        assert.strictEqual(
          JSON.stringify(fake.calls("resume")[0]?.args.response),
          JSON.stringify({ action: "decline" })
        );
      })
    )
  );

  it.live("reports an expired Executor request as not run", () =>
    withFake(
      (fake) =>
        Effect.gen(function* () {
          const outcome = yield* gatedCall(
            firstAttempt().ledger,
            callRequest("tools.spike.mark", { id: "late" })
          );

          assert.isTrue(outcome.isError);
          assert.include(outcome.text, "did not run");
          assert.deepStrictEqual(fake.marks, []);
        }),
      {
        setup: (fake) => {
          fake.state.ttlMs = -1;
        },
      }
    )
  );

  it.live("never resends a rerun that finds the started mark", () =>
    withFake((fake) =>
      Effect.gen(function* () {
        const { ledger, record } = memoryLedger({
          prior: Option.some("started"),
          answer: "accepted",
        });

        const outcome = yield* gatedCall(
          ledger,
          callRequest("tools.spike.mark", { id: "again" })
        );

        assert.isTrue(outcome.isError);
        assert.strictEqual(outcome.text, RERUN_AFTER_START);
        assert.strictEqual(fake.state.log.length, 0);
        assert.strictEqual(Option.getOrThrow(record()).run, "done");
      })
    )
  );

  it.live("cancels an input-required form with a clear error", () =>
    withFake((fake) =>
      Effect.gen(function* () {
        const outcome = yield* gatedCall(
          firstAttempt().ledger,
          callRequest("tools.spike.form", {})
        );

        assert.isTrue(outcome.isError);
        assert.include(outcome.text, "can't answer tool input forms yet");
        assert.strictEqual(
          JSON.stringify(fake.calls("resume")[0]?.args.response),
          JSON.stringify({ action: "cancel" })
        );
        assert.strictEqual(fake.pending.size, 0);
      })
    )
  );
});

describe("the link", () => {
  it.live(
    "opens a new session after an Executor restart and resends once",
    () =>
      withFake((fake) =>
        Effect.gen(function* () {
          const link = yield* ExecutorLink;

          yield* link.call("search", { query: "mark" });
          fake.restart();

          const reply = yield* link.call("search", { query: "mark" });

          assert.isTrue(Option.isSome(reply.structured));
          assert.strictEqual(fake.state.sessionsOpened, 2);
          assert.strictEqual(fake.calls("search").length, 2);
          assert.strictEqual((yield* link.status).state, "connected");
        })
      )
  );

  it.live(
    "fails a call in flight as may-have-run when a restart loses its session",
    () =>
      withFake(
        (fake) =>
          Effect.gen(function* () {
            const running = yield* gatedCall(
              firstAttempt().ledger,
              callRequest("tools.spike.hang", {})
            ).pipe(Effect.forkChild);

            yield* Effect.sleep(Duration.millis(100));
            fake.restart();

            const outcome = yield* Fiber.join(running).pipe(
              Effect.timeout(Duration.seconds(5))
            );

            assert.isTrue(outcome.isError);
            assert.include(outcome.text, "may have run");
            assert.strictEqual(fake.calls("call").length, 1);
          }),
        { pingInterval: Duration.millis(50) }
      )
  );

  it.live("shares one refresh between concurrent calls", () =>
    withFake((fake) =>
      Effect.gen(function* () {
        const link = yield* ExecutorLink;

        yield* link.call("skills", {});
        fake.expireAccess();

        const replies = yield* Effect.all(
          [link.call("search", {}), link.call("skills", {})],
          { concurrency: "unbounded" }
        );

        assert.strictEqual(replies.length, 2);
        assert.strictEqual(fake.state.refreshes, 1);
        assert.strictEqual(fake.state.invalidGrants, 0);
      })
    )
  );

  it.live("asks for sign-in when the grant is revoked, then signs in", () =>
    withFake((fake) =>
      Effect.gen(function* () {
        const link = yield* ExecutorLink;

        yield* link.call("skills", {});
        fake.revoke();
        fake.restart();

        const refused = yield* link.call("skills", {}).pipe(Effect.result);

        assert.isTrue(Result.isFailure(refused));
        assert.strictEqual(
          Result.isFailure(refused) ? refused.failure.reason : "",
          "sign_in_required"
        );
        assert.strictEqual((yield* link.status).state, "needs-sign-in");

        const consentPage = yield* link.signIn;
        const { code, state } = fake.consent(consentPage);

        const forged = yield* link
          .callback({
            state: Option.some("not-ours"),
            code: Option.some(code),
            iss: Option.none(),
            error: Option.none(),
            errorDescription: Option.none(),
          })
          .pipe(Effect.flip);

        assert.strictEqual(forged.reason, "unknown_state");

        // The forged answer used up the one sign-in in flight: start again.
        const again = fake.consent(yield* link.signIn);

        yield* link.callback({
          state: Option.some(again.state),
          code: Option.some(again.code),
          iss: Option.none(),
          error: Option.none(),
          errorDescription: Option.none(),
        });

        assert.notStrictEqual(state, again.state);
        assert.strictEqual((yield* link.status).state, "connected");

        const reply = yield* link.call("skills", {});

        assert.isTrue(Option.isSome(reply.structured));
      })
    )
  );
});

describe("the boot sweep", () => {
  it.live("declines every unfinished Executor request it is given", () =>
    withFake((fake) =>
      Effect.gen(function* () {
        const link = yield* ExecutorLink;

        // A call the brain recorded, then lost before it answered Executor.
        yield* link.call("call", {
          calls: [{ path: "tools.spike.mark", input: { id: "orphan" } }],
        });

        assert.strictEqual(fake.pending.size, 1);

        const report = yield* ExecutorSweep.use((sweeper) =>
          sweeper.sweep([
            { conversationId: 1, approvalId: "call-1", requestId: "apr_1" },
          ])
        ).pipe(Effect.provide(ExecutorSweep.layerNoDeps));

        assert.deepStrictEqual(report, { found: 1, declined: 1, deferred: 0 });
        assert.strictEqual(fake.pending.size, 0);

        // A late accept on the same grant finds nothing to run.
        yield* link.call("resume", {
          requestId: "apr_1",
          response: { action: "accept" },
        });

        assert.deepStrictEqual(fake.marks, []);
      })
    )
  );
});
