// The Executor tool suite on the fake Executor: the approval sandwich (accept in one call, decline,
// expiry, a rerun after `started`, a ledger failure on a program's later pause), a session lost to
// an Executor restart, `input-required` cancelled, the boot sweep, one refresh shared by concurrent
// calls, a sign-in after the grant was revoked, a sign-in beside a call or a second sign-in, a
// sign-in or callback whose OAuth requests stall, a call whose `done` mark fails after it ran, and
// the status after Executor goes down or answers a server error. Ported in part from cairn-v1,
// apps/server/test/executor.test.ts at 1a5cd4a.

import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Option, Result } from "effect";

import { ApprovalLedgerError } from "../brain/CairnDocs.ts";
import { ExecutorGrant, ExecutorGrantError } from "./ExecutorGrant.ts";
import { ExecutorLink } from "./ExecutorLink.ts";
import { INTERRUPTED, REFUSED, RERUN_AFTER_START } from "./ExecutorReply.ts";
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
  payload: Option.none(),
  acceptedBy: Option.some("full-access" as const),
});

/** Runs `body` against a fresh fake Executor and a link to it. */
const withFake = <A, E>(
  body: (fake: FakeExecutorHandle) => Effect.Effect<A, E, ExecutorLink>,
  options: {
    readonly pingInterval?: Duration.Duration;
    readonly setup?: (fake: FakeExecutorHandle) => void;
    readonly link?: Parameters<typeof fakeLink>[1];
  } = {}
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* startFakeExecutor;

      options.setup?.(fake);

      const link = fakeLink(
        fake,
        options.pingInterval === undefined
          ? (options.link ?? {})
          : { ...options.link, pingInterval: options.pingInterval }
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
          acceptedBy: Option.none(),
        });

        assert.isTrue(outcome.isError);
        assert.include(outcome.text, "declined, so nothing was sent");
        assert.strictEqual(Option.getOrThrow(record()).status, "declined");
        assert.strictEqual(fake.state.log.length, 0);
        assert.isNull(Option.getOrThrow(record()).run);
      })
    )
  );

  it.live(
    "accepts a program's nested approvals under its one approval, with its code on the record",
    () =>
      withFake((fake) =>
        Effect.gen(function* () {
          const { ledger, record } = memoryLedger({
            prior: Option.none(),
            answer: "accepted",
          });

          const code = "await tools.spike.mark({ id: 'x' })";

          const outcome = yield* gatedCall(ledger, {
            kind: "execute",
            request: { code },
            summary: "program",
            payload: Option.some({ type: "program", code }),
            acceptedBy: Option.none(),
          });

          assert.isFalse(outcome.isError, outcome.text);
          assert.deepStrictEqual(fake.marks, ["from-program"]);
          assert.strictEqual(
            JSON.stringify(fake.calls("resume")[0]?.args.response),
            JSON.stringify({ action: "accept" })
          );

          const kept = Option.getOrThrow(record());

          assert.deepStrictEqual(kept.payload, { type: "program", code });
          assert.deepStrictEqual(kept.decidedBy, { kind: "user" });
          assert.strictEqual(kept.run, "done");
        })
      )
  );

  it.live(
    "reports a ledger failure on a program's later pause as may have run, not refused",
    () =>
      withFake(
        (fake) =>
          Effect.gen(function* () {
            const { ledger } = firstAttempt();
            let notes = 0;

            const outcome = yield* gatedCall(
              {
                ...ledger,
                noteExecutorRequest: (requestId) => {
                  notes += 1;

                  return notes === 2
                    ? Effect.fail(
                        new ApprovalLedgerError({
                          message: "Recording approval call-1 failed: closed.",
                          approvalId: ledger.approvalId,
                          reason: "store_failed",
                        })
                      )
                    : ledger.noteExecutorRequest(requestId);
                },
              },
              {
                kind: "execute",
                request: { code: "twice()" },
                summary: "program",
                payload: Option.none(),
                acceptedBy: Option.some("full-access"),
              }
            );

            assert.isTrue(outcome.isError);
            assert.include(outcome.text, INTERRUPTED);
            assert.notInclude(outcome.text, REFUSED);
            assert.deepStrictEqual(fake.marks, ["from-program"]);
          }),
        {
          setup: (fake) => {
            fake.state.programPauses = 2;
          },
        }
      )
  );

  it.live(
    "keeps the call's own outcome when recording done fails after it ran",
    () =>
      withFake((fake) =>
        Effect.gen(function* () {
          const { ledger } = firstAttempt();

          const outcome = yield* gatedCall(
            {
              ...ledger,
              finish: Effect.fail(
                new ApprovalLedgerError({
                  message: "Recording approval call-1 failed: closed.",
                  approvalId: ledger.approvalId,
                  reason: "store_failed",
                })
              ),
            },
            callRequest("tools.spike.mark", { id: "ran" })
          );

          assert.isFalse(outcome.isError, outcome.text);
          assert.deepStrictEqual(Option.getOrNull(outcome.value), {
            marked: "ran",
            count: 1,
          });
          assert.deepStrictEqual(fake.marks, ["ran"]);
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
              Effect.timeout(Duration.seconds(3))
            );

            assert.isTrue(outcome.isError);
            assert.include(outcome.text, "may have run");
            assert.strictEqual(fake.calls("call").length, 1);
          }),
        { pingInterval: Duration.millis(50) }
      )
  );

  it.live(
    "resends every concurrent call Executor refused after a restart",
    () =>
      withFake((fake) =>
        Effect.gen(function* () {
          const link = yield* ExecutorLink;

          yield* link.call("search", { query: "warm" });
          fake.restart();

          const replies = yield* Effect.all(
            [
              link.call("search", { query: "one" }),
              link.call("search", { query: "two" }),
              link.call("skills", {}),
            ],
            { concurrency: "unbounded" }
          );

          assert.strictEqual(replies.length, 3);
          assert.strictEqual(fake.calls("search").length, 3);
          assert.strictEqual(fake.calls("skills").length, 1);
        })
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

  it.live(
    "asks for sign-in when the approving session expired, though a refresh still issues tokens",
    () =>
      withFake((fake) =>
        Effect.gen(function* () {
          const link = yield* ExecutorLink;

          yield* link.call("skills", {});
          fake.endSessions();
          fake.restart();

          const refused = yield* link.call("skills", {}).pipe(Effect.result);

          assert.strictEqual(
            Result.isFailure(refused) ? refused.failure.reason : "",
            "sign_in_required"
          );
          assert.isFalse(
            Result.isFailure(refused) && refused.failure.sent,
            "a refused grant sent nothing"
          );
          // The transport refreshed once and was refused again: not "unreachable".
          assert.strictEqual(fake.state.refreshes, 1);
          assert.strictEqual((yield* link.status).state, "needs-sign-in");

          const consent = fake.consent(yield* link.signIn);

          yield* link.callback({
            state: Option.some(consent.state),
            code: Option.some(consent.code),
            iss: Option.none(),
            error: Option.none(),
            errorDescription: Option.none(),
          });

          const reply = yield* link.call("skills", {});

          assert.isTrue(Option.isSome(reply.structured));
          assert.strictEqual((yield* link.status).state, "connected");
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

/** The memory grant store, refusing every save: a disk that is full or read-only. */
const refusingSaves = (memory: Layer.Layer<ExecutorGrant>) =>
  Layer.effect(
    ExecutorGrant,
    ExecutorGrant.useSync((stored) =>
      ExecutorGrant.of({
        ...stored,
        save: () =>
          Effect.fail(
            new ExecutorGrantError({
              message: "The grant store refused the write.",
              operation: "save",
            })
          ),
      })
    )
  ).pipe(Layer.provide(memory));

describe("the link under a failing Executor or store", () => {
  it.live(
    "a connect that hangs fails every waiting call within the connect budget",
    () =>
      withFake(
        () =>
          Effect.gen(function* () {
            const link = yield* ExecutorLink;

            const [first, second] = yield* Effect.all(
              [
                Effect.flip(link.call("search", { query: "mark" })),
                Effect.flip(link.call("search", { query: "mark" })),
              ],
              { concurrency: "unbounded" }
            ).pipe(Effect.timeout(Duration.seconds(3)));

            assert.strictEqual(first.reason, "unreachable");
            assert.strictEqual(second.reason, "unreachable");
            assert.isFalse(first.sent);
          }),
        {
          setup: (fake) => {
            fake.state.hangInitialize = true;
          },
          link: { connectTimeout: Duration.millis(300) },
        }
      )
  );

  it.live(
    "a refresh the store cannot save is still the one the next refresh uses",
    () =>
      withFake(
        (fake) =>
          Effect.gen(function* () {
            const link = yield* ExecutorLink;

            fake.expireAccess();
            yield* link.call("search", { query: "mark" });
            fake.expireAccess();
            yield* link.call("search", { query: "mark" });

            assert.strictEqual(fake.state.refreshes, 2);
            assert.strictEqual(fake.state.invalidGrants, 0);
          }),
        { link: { grantStore: refusingSaves } }
      )
  );
});

/** Polls `done` every 10 ms until it holds, for up to five seconds. */
const eventually = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 500 && !done(); tries += 1) {
      yield* Effect.sleep("10 millis");
    }

    assert.isTrue(done(), "the condition never held");
  });

/** Consents on `page` as the user's browser would, then answers Cairn's callback. */
const consentAndCallBack = (fake: FakeExecutorHandle, page: string) =>
  Effect.gen(function* () {
    const link = yield* ExecutorLink;
    const { code, state } = fake.consent(page);

    return yield* link
      .callback({
        state: Option.some(state),
        code: Option.some(code),
        iss: Option.none(),
        error: Option.none(),
        errorDescription: Option.none(),
      })
      .pipe(Effect.result);
  });

/** A link whose grant was revoked and whose sessions Executor forgot: it needs sign-in. */
const revoked = (fake: FakeExecutorHandle) =>
  Effect.gen(function* () {
    const link = yield* ExecutorLink;

    yield* link.call("skills", {});
    fake.revoke();
    fake.restart();
    yield* link.call("skills", {}).pipe(Effect.flip);
    assert.strictEqual((yield* link.status).state, "needs-sign-in");
  });

describe("a sign-in beside other flows", () => {
  it.live(
    "keeps the consent page's client when a call needs sign-in during it",
    () =>
      withFake((fake) =>
        Effect.gen(function* () {
          const link = yield* ExecutorLink;

          yield* revoked(fake);

          // The sign-in's registration and any other flow's are held, so the other's lands last.
          fake.state.holdRegisters = 2;

          const signingIn = yield* Effect.forkChild(link.signIn);

          yield* eventually(() => fake.state.registersHeld === 1);

          const calling = yield* Effect.forkChild(
            link.call("skills", {}).pipe(Effect.result)
          );

          yield* Effect.sleep("300 millis");
          fake.releaseRegister();

          const page = yield* Fiber.join(signingIn);

          fake.releaseRegister();
          yield* Fiber.join(calling);

          const answered = yield* consentAndCallBack(fake, page);

          assert.isTrue(
            Result.isSuccess(answered),
            Result.isFailure(answered) ? answered.failure.message : ""
          );
          assert.strictEqual((yield* link.status).state, "connected");
        })
      )
  );

  it.live(
    "a sign-in whose discovery stalls gives up and lets calls through",
    () =>
      withFake(
        (fake) =>
          Effect.gen(function* () {
            const link = yield* ExecutorLink;

            yield* revoked(fake);
            fake.state.hangDiscovery = true;

            const signingIn = yield* Effect.forkChild(
              link.signIn.pipe(Effect.flip)
            );

            yield* Effect.sleep("100 millis");

            // The call waits on the lock the sign-in holds, then gets its own connect budget.
            const [failedSignIn, failedCall] = yield* Effect.all(
              [Fiber.join(signingIn), Effect.flip(link.call("skills", {}))],
              { concurrency: "unbounded" }
            ).pipe(Effect.timeout(Duration.seconds(3)));

            assert.strictEqual(failedSignIn.reason, "failed");
            assert.isFalse(failedCall.sent);

            // With discovery answering again, a new sign-in still works.
            fake.state.hangDiscovery = false;
            fake.dropStalled();

            const answered = yield* consentAndCallBack(
              fake,
              yield* link.signIn
            );

            assert.isTrue(
              Result.isSuccess(answered),
              Result.isFailure(answered) ? answered.failure.message : ""
            );
          }),
        {
          link: {
            signInTimeout: Duration.millis(400),
            connectTimeout: Duration.millis(400),
          },
        }
      )
  );

  it.live(
    "a callback whose code exchange stalls gives up and leaves the link asking for sign-in",
    () =>
      withFake(
        (fake) =>
          Effect.gen(function* () {
            const link = yield* ExecutorLink;

            yield* revoked(fake);

            const page = yield* link.signIn;

            fake.state.hangToken = true;

            const answered = yield* consentAndCallBack(fake, page).pipe(
              Effect.timeout(Duration.seconds(3))
            );

            assert.isTrue(Result.isFailure(answered));
            assert.strictEqual((yield* link.status).state, "needs-sign-in");

            const failedCall = yield* Effect.flip(link.call("skills", {})).pipe(
              Effect.timeout(Duration.seconds(3))
            );

            assert.isFalse(failedCall.sent);
          }),
        {
          link: {
            signInTimeout: Duration.millis(400),
            connectTimeout: Duration.millis(400),
          },
        }
      )
  );

  it.live("answers a second sign-in with the consent page of the first", () =>
    withFake((fake) =>
      Effect.gen(function* () {
        const link = yield* ExecutorLink;

        yield* revoked(fake);

        const pages = yield* Effect.all([link.signIn, link.signIn], {
          concurrency: "unbounded",
        });

        // Every page handed out completes its callback.
        for (const page of new Set(pages)) {
          const answered = yield* consentAndCallBack(fake, page);

          assert.isTrue(
            Result.isSuccess(answered),
            Result.isFailure(answered) ? answered.failure.message : ""
          );
        }

        assert.strictEqual((yield* link.status).state, "connected");
      })
    )
  );
});

describe("the link's status", () => {
  it.live("leaves connected when a call fails because Executor went down", () =>
    withFake((fake) =>
      Effect.gen(function* () {
        const link = yield* ExecutorLink;

        yield* link.call("skills", {});
        assert.strictEqual((yield* link.status).state, "connected");

        fake.stop();

        const failed = yield* link.call("skills", {}).pipe(Effect.flip);

        assert.strictEqual(failed.reason, "transport");
        assert.notStrictEqual((yield* link.status).state, "connected");
      })
    )
  );

  it.live(
    "stays connected when Executor answers a call with a server error",
    () =>
      withFake((fake) =>
        Effect.gen(function* () {
          const link = yield* ExecutorLink;

          yield* link.call("skills", {});
          fake.state.failCallOnce = 500;

          const failed = yield* link.call("skills", {}).pipe(Effect.flip);

          assert.strictEqual(failed.reason, "transport");
          assert.strictEqual((yield* link.status).state, "connected");
        })
      )
  );
});

describe("a token endpoint hiccup", () => {
  it.live(
    "reads as unreachable, not as a sign-in, and the next call refreshes",
    () =>
      withFake((fake) =>
        Effect.gen(function* () {
          const link = yield* ExecutorLink;

          yield* link.call("search", { query: "mark" });
          fake.expireAccess();
          fake.state.failTokenOnce = 502;

          const failed = yield* Effect.flip(
            link.call("search", { query: "mark" })
          );

          const status = yield* link.status;

          yield* link.call("search", { query: "mark" });

          assert.notStrictEqual(failed.reason, "sign_in_required");
          assert.notStrictEqual(status.state, "needs-sign-in");
          assert.strictEqual(fake.state.invalidGrants, 0);
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
          sweeper.declineEach([
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
