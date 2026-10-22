// Ported from cairn-v1 apps/server/test/usage.test.ts at 1a5cd4a56e84bfb187940428d144b584d2e084b0
// (Cairn's own code): normalization, the probe's decoder, merge by id, unknown never zero, the login
// rules and the probe cadence. Added: t3code's `monthly_spend` window and `windowDurationMins`, the
// wire projection, single flight and the timeout on `TestClock`, and the slot policy (J6 units and the
// resize judge).
import { ProviderUsage } from "@cairn/protocol/Usage";
import { normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import {
  DateTime,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import { Claude } from "./Claude.ts";
import { ClaudeAccount, loginAllowsTurns } from "./ClaudeAccount.ts";
import type { RateLimitInfo } from "./ClaudeEvents.ts";
import { QUIET_ENV } from "./ClaudeGuards.ts";
import { claudeModels, DEFAULT_LONG_CONTEXT } from "./ClaudeModels.ts";
import { initEvent, SCRIPT_SESSION, textTurn } from "./ClaudeScriptKit.ts";
import type { FakeProbe, FakeScript, RawProbe } from "./ClaudeSdk.ts";
import { ClaudeProbeError, ClaudeSdk, ClaudeSdkScripts } from "./ClaudeSdk.ts";
import { ClaudeSettings } from "./ClaudeSettings.ts";
import { ClaudeSlots, DEFAULT_SLOTS } from "./ClaudeSlots.ts";
import type { ClaudeUsageReading, UsageWindow } from "./ClaudeUsage.ts";
import {
  accountLogin,
  applyEvent,
  applyReading,
  ClaudeUsage,
  eventWindows,
  INITIAL_READING,
  loginOf,
  mergeWindows,
  NO_SCOPED_NAMES,
  readProbe,
  REDUCED_SLOTS,
  resetsAtFromEpoch,
  resetsAtFromIso,
  slotsFor,
  toProviderUsage,
  usedPercent,
} from "./ClaudeUsage.ts";

const T = 1_792_100_000_000;

const account = {
  email: "someone@example.com",
  subscriptionType: "max",
  tokenSource: "claude.ai",
  apiKeySource: "none",
  apiProvider: "firstParty",
};

/** The probe's usage answer around `rateLimits`: a Max plan with plan limits unless told otherwise. */
const probeUsage = (
  rateLimits: Schema.Json,
  fields: {
    readonly subscriptionType?: string | null;
    readonly available?: boolean;
  } = {}
) => ({
  session: { total_cost_usd: 0 },
  subscription_type:
    fields.subscriptionType === undefined ? "max" : fields.subscriptionType,
  rate_limits_available: fields.available ?? true,
  rate_limits: rateLimits,
});

const fullLimits = {
  five_hour: { utilization: 6, resets_at: "2026-10-18T20:30:00.000Z" },
  seven_day: { utilization: 59, resets_at: "2026-10-23T08:00:00+00:00" },
  seven_day_opus: null,
  model_scoped: [
    {
      display_name: "Fable",
      utilization: 12.5,
      resets_at: "2026-10-23T08:00:00Z",
    },
  ],
};

const raw = (accountValue: Schema.Json, usage: Schema.Json): RawProbe => ({
  account: accountValue,
  usage: Option.some(usage),
  usageError: Option.none(),
});

const iso = (text: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(text));

const info = (
  fields: Partial<RateLimitInfo> & { readonly status: string }
): RateLimitInfo => fields;

const summary = (windows: ReadonlyArray<UsageWindow>) =>
  windows.map((window) => [
    window.id,
    window.label,
    window.kind,
    Option.getOrNull(window.windowDurationMins),
    Math.round(window.usedPercent * 10) / 10,
    Option.getOrNull(window.resetsAt),
  ]);

describe("normalization", () => {
  it("reads event utilization as a fraction and probe utilization as a percent, clamped", () => {
    expect([
      usedPercent(0.06, "fraction"),
      usedPercent(1, "fraction"),
      usedPercent(1, "percent"),
      usedPercent(59, "percent"),
      usedPercent(1.4, "fraction"),
      usedPercent(-3, "percent"),
    ]).toStrictEqual([6, 100, 1, 59, 100, 0]);
  });

  it("reads resets as epoch seconds, epoch milliseconds by magnitude, or ISO 8601", () => {
    expect([
      resetsAtFromEpoch(1_792_111_800),
      resetsAtFromEpoch(1_792_111_800_000),
      resetsAtFromEpoch(0),
      resetsAtFromIso("2026-10-18T20:30:00.000Z"),
      resetsAtFromIso("2026-10-23T08:00:00+00:00"),
      resetsAtFromIso(null),
      resetsAtFromIso(""),
      resetsAtFromIso("not a date"),
    ]).toStrictEqual([
      Option.some(1_792_111_800_000),
      Option.some(1_792_111_800_000),
      Option.none(),
      Option.some(iso("2026-10-18T20:30:00.000Z")),
      Option.some(iso("2026-10-23T08:00:00Z")),
      Option.none(),
      Option.none(),
      Option.none(),
    ]);
  });
});

describe("rate_limit_event windows", () => {
  it("map the event's own window with t3code's ids, labels and durations", () => {
    const windows = eventWindows(
      info({
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.06,
        resetsAt: 1_792_111_800,
      }),
      NO_SCOPED_NAMES,
      T
    );

    expect([...summary(windows), windows[0]?.observedAt]).toStrictEqual([
      ["five_hour", "Session", "session", 300, 6, 1_792_111_800_000],
      T,
    ]);
  });

  it("name the overage-included bucket only once a probe has", () => {
    const event = info({
      status: "allowed_warning",
      rateLimitType: "seven_day_overage_included",
      utilization: 0.8,
      resetsAt: 1_792_476_000,
    });

    expect([
      eventWindows(event, NO_SCOPED_NAMES, T),
      summary(
        eventWindows(event, { overageIncluded: Option.some("Fable") }, T)
      ),
    ]).toStrictEqual([
      [],
      [
        [
          "seven_day_fable",
          "Weekly · Fable",
          "weekly",
          10_080,
          80,
          1_792_476_000_000,
        ],
      ],
    ]);
  });

  it("drop a window they cannot name or that has no utilization, and mark a rejected one exhausted", () => {
    expect([
      eventWindows(
        info({ status: "allowed", rateLimitType: "overage", utilization: 0.5 }),
        NO_SCOPED_NAMES,
        T
      ),
      eventWindows(
        info({ status: "allowed", rateLimitType: "five_hour" }),
        NO_SCOPED_NAMES,
        T
      ),
      eventWindows(
        info({
          status: "rejected",
          rateLimitType: "five_hour",
          utilization: 1,
        }),
        NO_SCOPED_NAMES,
        T
      ).map((window) => window.exhausted),
    ]).toStrictEqual([[], [], [true]]);
  });

  it("merge by id, keeping the windows an update does not name", () => {
    const [session, weekly] = readProbe(
      raw(account, probeUsage(fullLimits)),
      T
    ).windows;

    const later = eventWindows(
      info({
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.09,
      }),
      NO_SCOPED_NAMES,
      T + 1
    );

    const merged = mergeWindows(
      [session, weekly].flatMap((window) =>
        Option.toArray(Option.fromNullishOr(window))
      ),
      later
    );

    expect(
      merged.map((window) => [window.id, Math.round(window.usedPercent)])
    ).toStrictEqual([
      ["five_hour", 9],
      ["seven_day", 59],
    ]);
  });
});

describe("the probe's answer", () => {
  it("reads every window, the plan and the model-scoped bucket's name", () => {
    const reading = readProbe(raw(account, probeUsage(fullLimits)), T);

    expect([
      reading.login,
      reading.apiKeySource,
      reading.state,
      reading.plan,
      reading.names,
      summary(reading.windows),
    ]).toStrictEqual([
      { kind: "firstParty", plan: Option.some("max") },
      Option.some("none"),
      "ok",
      Option.some("max"),
      { overageIncluded: Option.some("Fable") },
      [
        [
          "five_hour",
          "Session",
          "session",
          300,
          6,
          iso("2026-10-18T20:30:00Z"),
        ],
        [
          "seven_day",
          "Weekly",
          "weekly",
          10_080,
          59,
          iso("2026-10-23T08:00:00Z"),
        ],
        [
          "seven_day_fable",
          "Weekly · Fable",
          "weekly",
          10_080,
          12.5,
          iso("2026-10-23T08:00:00Z"),
        ],
      ],
    ]);
  });

  it("gives unknown, never 0 percent, for null windows", () => {
    const nulls = readProbe(raw(account, probeUsage(null)), T);

    const nullUtilization = readProbe(
      raw(
        account,
        probeUsage({
          five_hour: { utilization: null, resets_at: null },
          seven_day: null,
        })
      ),
      T
    );

    expect([
      nulls.state,
      nulls.windows,
      nullUtilization.state,
      nullUtilization.windows,
      Option.isSome(nullUtilization.reason),
    ]).toStrictEqual(["unknown", [], "unknown", [], true]);
  });

  it("gives unknown on a changed shape, and still reads the login", () => {
    const changed = readProbe(
      raw(
        account,
        probeUsage({ five_hour: { utilization: "6%", resets_at: 5 } })
      ),
      T
    );

    const renamed = readProbe(raw(account, { session: {}, limits: [] }), T);

    expect([
      changed.state,
      changed.reason,
      changed.windows,
      renamed.state,
      renamed.reason,
      renamed.login.kind,
    ]).toStrictEqual([
      "unknown",
      Option.some("usage response shape changed"),
      [],
      "unknown",
      Option.some("usage response shape changed"),
      "firstParty",
    ]);
  });

  it("gives unknown when the usage request failed", () => {
    const failed = readProbe(
      {
        account,
        usage: Option.none(),
        usageError: Option.some("boom"),
      },
      T
    );

    expect([failed.state, failed.reason]).toStrictEqual([
      "unknown",
      Option.some("usage request failed: boom"),
    ]);
  });

  it("gives unavailable for an API-key login, a third-party login and no login", () => {
    const apiKey = readProbe(
      raw(
        account,
        probeUsage(null, { available: false, subscriptionType: null })
      ),
      T
    );

    const bedrock = readProbe(
      raw({ apiProvider: "bedrock" }, probeUsage(null, { available: false })),
      T
    );

    const out = readProbe(
      raw(
        { tokenSource: "none", apiKeySource: "none" },
        probeUsage(null, { available: false })
      ),
      T
    );

    expect([
      apiKey.state,
      bedrock.login,
      bedrock.state,
      out.login,
      out.state,
      out.reason,
    ]).toStrictEqual([
      "unavailable",
      { kind: "thirdParty", apiProvider: "bedrock" },
      "unavailable",
      { kind: "none" },
      "unavailable",
      Option.some("the claude CLI is not logged in"),
    ]);
  });

  it("keeps known windows when a subscription's answer says it has no plan limits", () => {
    const known = applyReading(
      INITIAL_READING,
      readProbe(raw(account, probeUsage(fullLimits)), T),
      T
    );

    const early = readProbe(
      raw(account, probeUsage(null, { available: false })),
      T + 1000
    );

    const after = applyReading(known, early, T + 1000);

    expect([early.state, after.state, after.windows.length > 0]).toStrictEqual([
      "unknown",
      known.state,
      true,
    ]);
  });

  it("marks a full window limited", () => {
    const full = readProbe(
      raw(
        account,
        probeUsage({
          five_hour: { utilization: 100, resets_at: null },
          seven_day: { utilization: 80, resets_at: null },
        })
      ),
      T
    );

    expect(full.state).toBe("limited");
  });

  it("reads the login from the account, and takes plan windows as proof when the account is silent", () => {
    expect([
      loginOf(raw(null, null)).kind,
      loginOf(raw({ tokenSource: 5 }, null)).kind,
      loginOf(raw({}, null)).kind,
      loginOf(raw({ apiProvider: "vertex" }, null)),
      loginOf(raw({ email: "a@b", tokenSource: "claude.ai" }, null)),
      readProbe(raw({}, probeUsage(fullLimits)), T).login,
      readProbe(raw({}, probeUsage(null, { available: false })), T).login.kind,
    ]).toStrictEqual([
      "unknown",
      "unknown",
      "unknown",
      { kind: "thirdParty", apiProvider: "vertex" },
      { kind: "firstParty", plan: Option.none() },
      { kind: "firstParty", plan: Option.some("max") },
      "unknown",
    ]);
  });

  it("lets turns through on an unknown login and refuses only a definite answer", () => {
    const logins = [
      { kind: "unknown", reason: "probe timed out" },
      { kind: "firstParty", plan: Option.some("max") },
      { kind: "none" },
      { kind: "thirdParty", apiProvider: "bedrock" },
    ] as const;

    expect(
      logins.map((login) => [
        accountLogin(login),
        loginAllowsTurns(accountLogin(login)),
      ])
    ).toStrictEqual([
      ["unknown", true],
      ["loggedIn", true],
      ["loggedOut", false],
      ["loggedOut", false],
    ]);
  });
});

const spendOf = (extra: {
  readonly spend?: Schema.Json;
  readonly extra_usage?: Schema.Json;
}) =>
  readProbe(
    raw(
      account,
      probeUsage({
        ...fullLimits,
        spend: extra.spend ?? null,
        extra_usage: extra.extra_usage ?? null,
      })
    ),
    T
  )
    .windows.filter((window) => window.id === "monthly_spend")
    .map((window) => [
      window.label,
      window.kind,
      Option.getOrNull(window.windowDurationMins),
      window.usedPercent,
    ]);

const money = (amount: number, currency = "USD", exponent = 2) => ({
  amount_minor: amount,
  currency,
  exponent,
});

describe("the monthly spend window", () => {
  it("comes from the spend budget when it is enabled and its units match", () => {
    expect(
      spendOf({
        spend: { enabled: true, used: money(2500), limit: money(10_000) },
      })
    ).toStrictEqual([["Monthly spend", "monthly", null, 25]]);
  });

  it("falls back to extra usage when the budget's units differ or it is off", () => {
    const extra = {
      is_enabled: true,
      monthly_limit: 200,
      used_credits: 50,
      utilization: 99,
    };

    expect([
      spendOf({
        spend: {
          enabled: true,
          used: money(2500, "EUR"),
          limit: money(10_000),
        },
        extra_usage: extra,
      }),
      spendOf({
        spend: { enabled: false, used: money(1), limit: money(2) },
        extra_usage: { ...extra, monthly_limit: null },
      }),
    ]).toStrictEqual([
      [["Monthly spend", "monthly", null, 25]],
      [["Monthly spend", "monthly", null, 99]],
    ]);
  });

  it("is absent when neither is enabled, and a changed spend shape drops only that row", () => {
    expect([
      spendOf({ extra_usage: { is_enabled: false, utilization: 40 } }),
      spendOf({ spend: { enabled: "yes" } }),
      readProbe(
        raw(account, probeUsage({ ...fullLimits, spend: { enabled: "yes" } })),
        T
      ).windows.length,
    ]).toStrictEqual([[], [], 3]);
  });
});

describe("the wire projection", () => {
  it("sends fractions, resets and the check time, and encodes as the protocol's ProviderUsage", () => {
    const reading: ClaudeUsageReading = {
      ...INITIAL_READING,
      state: "ok",
      windows: readProbe(raw(account, probeUsage(fullLimits)), T).windows,
      checkedAt: Option.some(T),
    };

    const wire = toProviderUsage(reading);
    const encoded = Schema.encodeSync(ProviderUsage)(wire);

    expect([
      encoded.provider,
      encoded.windows.map((window) => [
        window.id,
        window.used,
        window.exhausted,
      ]),
      Option.map(
        Option.flatMap(
          Option.fromNullishOr(wire.windows[0]),
          (window) => window.resetsAt
        ),
        DateTime.formatIso
      ),
      Option.map(wire.checkedAt, DateTime.formatIso),
    ]).toStrictEqual([
      "claude-bridge",
      [
        ["five_hour", 0.06, false],
        ["seven_day", 0.59, false],
        ["seven_day_fable", 0.125, false],
      ],
      Option.some("2026-10-18T20:30:00.000Z"),
      Option.some(DateTime.formatIso(DateTime.makeUnsafe(T))),
    ]);
  });

  it("marks a rejected window exhausted", () => {
    const limited = applyEvent(
      { ...INITIAL_READING, state: "ok" },
      info({ status: "rejected", rateLimitType: "seven_day", utilization: 1 }),
      NO_SCOPED_NAMES,
      T
    );

    expect([
      limited.state,
      toProviderUsage(limited).windows.map((window) => window.exhausted),
    ]).toStrictEqual(["limited", [true]]);
  });
});

// --- The service, on TestClock ---

const answer = (usage: Schema.Json = probeUsage(fullLimits)): FakeProbe =>
  Effect.succeed(raw(account, usage));

const usageLayer = (probes: ReadonlyArray<FakeProbe>) =>
  ClaudeUsage.layerNoDeps.pipe(
    Layer.provideMerge(Layer.mergeAll(ClaudeSdk.layerTest, ClaudeSlots.layer)),
    Layer.provideMerge(
      Layer.effect(ClaudeSdkScripts, ClaudeSdkScripts.make([], probes))
    )
  );

const probeCount = Effect.gen(function* () {
  const fake = yield* ClaudeSdkScripts;

  return (yield* Ref.get(fake.probed)).length;
});

/** Runs other fibers until `done` holds; every fiber here is pure Effect, so this is deterministic. */
const until = (
  done: Effect.Effect<boolean, never, ClaudeSdkScripts | ClaudeUsage>
) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 1000; turn += 1) {
      if (yield* done) {
        return true;
      }

      yield* Effect.yieldNow;
    }

    return yield* Effect.die(new Error("condition never held"));
  });

const current = Effect.gen(function* () {
  const usage = yield* ClaudeUsage;

  return yield* usage.current;
});

const booted = until(
  Effect.map(current, (reading) => Option.isSome(reading.checkedAt))
);

describe("the usage service", () => {
  it.effect(
    "probes at boot, holds the windows, merges an event by id, and provides the login",
    () =>
      Effect.gen(function* () {
        const usage = yield* ClaudeUsage;
        const accountService = yield* ClaudeAccount;

        yield* booted;
        yield* TestClock.adjust("1 second");
        yield* usage.observe(
          info({
            status: "allowed",
            rateLimitType: "seven_day_overage_included",
            utilization: 0.2,
            resetsAt: 1_792_476_000,
          })
        );

        const after = yield* usage.current;
        const fake = yield* ClaudeSdkScripts;
        const [options] = yield* Ref.get(fake.probed);

        expect([
          after.state,
          after.plan,
          after.windows.map((window) => [
            window.id,
            window.usedPercent,
            window.observedAt,
          ]),
          yield* accountService.login,
          options?.env[QUIET_ENV],
        ]).toStrictEqual([
          "ok",
          Option.some("max"),
          [
            ["five_hour", 6, 0],
            ["seven_day", 59, 0],
            ["seven_day_fable", 20, 1000],
          ],
          "loggedIn",
          undefined,
        ]);
      }).pipe(Effect.provide(usageLayer([answer()])))
  );

  it.effect(
    "runs one probe at a time: a caller joins the probe in flight",
    () =>
      Effect.gen(function* () {
        const usage = yield* ClaudeUsage;

        yield* until(Effect.map(probeCount, (n) => n === 1));

        const joiners = yield* Effect.forkChild(
          Effect.all([usage.probe, usage.probe], { concurrency: "unbounded" })
        );

        yield* TestClock.adjust("1 second");
        yield* Fiber.join(joiners);

        const afterJoin = yield* probeCount;

        yield* usage.probe.pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* until(Effect.map(probeCount, (n) => n === 2));

        expect([afterJoin, yield* probeCount]).toStrictEqual([1, 2]);
      }).pipe(
        Effect.provide(
          usageLayer([
            Effect.as(
              Effect.sleep("1 second"),
              raw(account, probeUsage(fullLimits))
            ),
          ])
        )
      )
  );

  it.effect(
    "times a probe out after 10 s, reports unknown with a reason, and asks again 10 s later",
    () =>
      Effect.gen(function* () {
        const usage = yield* ClaudeUsage;

        yield* until(Effect.map(probeCount, (n) => n === 1));
        yield* TestClock.adjust("10 seconds");
        yield* booted;

        const timedOut = yield* usage.current;

        yield* TestClock.adjust("10 seconds");
        yield* until(Effect.map(probeCount, (n) => n === 2));
        yield* booted;
        yield* until(
          Effect.map(current, (reading) => reading.login.kind !== "unknown")
        );

        const recovered = yield* usage.current;

        expect([
          timedOut.state,
          timedOut.reason,
          timedOut.login.kind,
          recovered.login.kind,
          recovered.windows.length,
        ]).toStrictEqual([
          "unknown",
          Option.some("probe failed: timed out after 10000 ms"),
          "unknown",
          "firstParty",
          3,
        ]);
      }).pipe(Effect.provide(usageLayer([Effect.never, answer()])))
  );

  it.effect(
    "keeps known windows when a later probe fails, and keeps the login through it",
    () =>
      Effect.gen(function* () {
        const usage = yield* ClaudeUsage;

        yield* booted;
        yield* usage.probe;

        const after = yield* usage.current;

        expect([
          after.state,
          after.windows.length,
          after.login.kind,
          yield* probeCount,
        ]).toStrictEqual(["ok", 3, "firstParty", 2]);
      }).pipe(
        Effect.provide(
          usageLayer([
            answer(),
            Effect.fail(new ClaudeProbeError({ message: "spawn failed" })),
          ])
        )
      )
  );

  it.effect("marks a rejection limited and probes once for it", () =>
    Effect.gen(function* () {
      const usage = yield* ClaudeUsage;

      yield* booted;

      const rejected = info({
        status: "rejected",
        rateLimitType: "five_hour",
        utilization: 1,
        resetsAt: 1_792_111_800,
      });

      yield* usage.observe(rejected);

      const limited = yield* usage.current;

      yield* usage.observe(rejected);
      yield* until(Effect.map(probeCount, (n) => n === 2));
      yield* until(Effect.map(current, (reading) => reading.state === "ok"));

      const probes = yield* probeCount;

      expect([limited.state, probes]).toStrictEqual(["limited", 2]);
    }).pipe(
      Effect.provide(
        usageLayer([
          answer(),
          // After the rejection the session reads 6 percent again.
          answer(),
        ])
      )
    )
  );

  it.effect(
    "probes on the 5 minute tick only while a client watches or a turn ran, and on a stale watcher",
    () =>
      Effect.gen(function* () {
        const usage = yield* ClaudeUsage;

        yield* booted;

        // Idle and unwatched: two ticks pass with no probe.
        yield* TestClock.adjust("10 minutes");

        const idle = yield* probeCount;

        // A watcher arriving more than 60 s after the last probe starts one, and the tick probes.
        const watching = yield* Effect.forkChild(Stream.runDrain(usage.watch));

        yield* until(Effect.map(probeCount, (n) => n === 2));
        yield* TestClock.adjust("5 minutes");
        yield* until(Effect.map(probeCount, (n) => n === 3));
        yield* Fiber.interrupt(watching);

        // Unwatched again: no probe on the next tick.
        yield* TestClock.adjust("5 minutes");

        const unwatched = yield* probeCount;

        // A turn's rate_limit_event: the next tick probes.
        yield* usage.observe(
          info({
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.1,
          })
        );
        yield* TestClock.adjust("5 minutes");
        yield* until(Effect.map(probeCount, (n) => n === 4));

        // Five quiet minutes after that turn: the tick is idle again.
        yield* TestClock.adjust("5 minutes");

        expect([idle, unwatched, yield* probeCount]).toStrictEqual([1, 3, 4]);
      }).pipe(Effect.provide(usageLayer([answer()])))
  );

  it.effect("streams the wire usage, current value first", () =>
    Effect.gen(function* () {
      const usage = yield* ClaudeUsage;

      yield* booted;

      const first = yield* Stream.runHead(usage.watch);

      expect(
        Option.map(first, (providers) =>
          providers.map((provider) => [
            provider.provider,
            provider.windows.length,
          ])
        )
      ).toStrictEqual(Option.some([["claude-bridge", 3]]));
    }).pipe(Effect.provide(usageLayer([answer()])))
  );

  it.effect("reports not logged in from a probe that found no login", () =>
    Effect.gen(function* () {
      const accountService = yield* ClaudeAccount;

      yield* booted;

      expect([
        yield* accountService.login,
        (yield* (yield* ClaudeUsage).current).reason,
      ]).toStrictEqual([
        "loggedOut",
        Option.some("the claude CLI is not logged in"),
      ]);
    }).pipe(
      Effect.provide(
        usageLayer([
          Effect.succeed(
            raw(
              { tokenSource: "none", apiKeySource: "none" },
              probeUsage(null, { available: false, subscriptionType: null })
            )
          ),
        ])
      )
    )
  );
});

const weekly = (percent: number): ClaudeUsageReading => ({
  ...INITIAL_READING,
  state: "ok",
  windows: eventWindows(
    info({
      status: "allowed",
      rateLimitType: "seven_day",
      utilization: percent / 100,
    }),
    NO_SCOPED_NAMES,
    T
  ),
});

describe("the slot policy", () => {
  it("allows two generations above 80 percent weekly, four at or below, and leaves them while unknown", () => {
    expect([
      slotsFor(weekly(81)),
      slotsFor(weekly(80)),
      slotsFor(weekly(10)),
      slotsFor(INITIAL_READING),
    ]).toStrictEqual([
      Option.some(REDUCED_SLOTS),
      Option.some(DEFAULT_SLOTS),
      Option.some(DEFAULT_SLOTS),
      Option.none(),
    ]);
  });

  it.effect(
    "shrinks ClaudeSlots to 2 when the weekly window crosses 80 percent, without cancelling a running generation",
    () =>
      Effect.gen(function* () {
        const usage = yield* ClaudeUsage;
        const slots = yield* ClaudeSlots;

        yield* booted;

        // Four generations hold every permit; each runs for 30 s of test time, then releases.
        const generation = (sessionId: string) =>
          Effect.gen(function* () {
            yield* slots.acquire(sessionId);
            yield* Effect.sleep("30 seconds");
            yield* slots.release(sessionId);

            return sessionId;
          });

        const running = yield* Effect.forEach(["a", "b", "c", "d"], (id) =>
          Effect.forkChild(generation(id))
        );

        yield* until(
          Effect.map(slots.generating, (holders) => holders.length === 4)
        );

        yield* usage.observe(
          info({
            status: "allowed_warning",
            rateLimitType: "seven_day",
            utilization: 0.85,
          })
        );
        yield* until(Effect.map(slots.size, (size) => size === REDUCED_SLOTS));

        // A fifth generation waits while the four finish.
        const waiting = yield* Effect.forkChild(generation("e"));

        yield* until(Effect.map(slots.waiting, (ids) => ids.includes("e")));

        const holdersAfterShrink = yield* slots.generating;

        yield* TestClock.adjust("30 seconds");

        const exits = yield* Effect.forEach(running, (fiber) =>
          Fiber.await(fiber)
        );

        yield* until(
          Effect.map(slots.generating, (holders) => holders.includes("e"))
        );
        yield* TestClock.adjust("30 seconds");

        const fifth = yield* Fiber.join(waiting);

        // The window falls back: four permits again.
        yield* usage.observe(
          info({
            status: "allowed",
            rateLimitType: "seven_day",
            utilization: 0.5,
          })
        );
        yield* until(Effect.map(slots.size, (size) => size === DEFAULT_SLOTS));

        expect([
          holdersAfterShrink,
          exits.map((exit) => Exit.isSuccess(exit)),
          fifth,
          yield* slots.size,
        ]).toStrictEqual([
          ["a", "b", "c", "d"],
          [true, true, true, true],
          "e",
          DEFAULT_SLOTS,
        ]);
      }).pipe(
        Effect.provide(
          usageLayer([
            answer(
              probeUsage({
                five_hour: { utilization: 6, resets_at: null },
                seven_day: { utilization: 40, resets_at: null },
              })
            ),
          ])
        )
      )
  );
});

describe("the probe's environment", () => {
  it.effect(
    "removes CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC and every credential override",
    () =>
      Effect.gen(function* () {
        yield* booted;

        const fake = yield* ClaudeSdkScripts;
        const [options] = yield* Ref.get(fake.probed);
        const env = options?.env ?? {};

        expect([
          env[QUIET_ENV],
          env.ANTHROPIC_API_KEY,
          env.CAIRN_HOST,
          env.PATH,
        ]).toStrictEqual([undefined, undefined, undefined, "/usr/bin"]);
      }).pipe(
        Effect.provide(usageLayer([answer()])),
        Effect.provideService(ClaudeSettings, {
          ...ClaudeSettings.defaultValue(),
          env: {
            PATH: "/usr/bin",
            [QUIET_ENV]: "1",
            ANTHROPIC_API_KEY: "sk-ant-api03-test",
            CAIRN_HOST: "x",
          },
        })
      )
  );
});

/** A turn that reports a plan-window reading, then answers. */
const turnWithReading: FakeScript = (io) =>
  Effect.gen(function* () {
    yield* io.nextPrompt;
    yield* io.emit(
      initEvent(SCRIPT_SESSION),
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 0.5,
          resetsAt: 1_792_111_800,
        },
      },
      ...textTurn("m1", "u1", "hi")
    );

    return yield* Effect.never;
  });

describe("the whole bridge", () => {
  const model = Option.getOrThrow(
    Option.fromNullishOr(
      claudeModels(DEFAULT_LONG_CONTEXT).find(
        (found) => found.id === "claude-haiku-5-5"
      )
    )
  );

  it.effect(
    "feeds a turn's rate_limit_event into the usage, and gives the provider the probe's login",
    () =>
      Effect.gen(function* () {
        const claude = yield* Claude;
        const usage = yield* ClaudeUsage;

        yield* booted;

        const stream = claude.provider.streamSimple(
          model,
          normalizeContext({
            messages: [{ role: "user", content: "hi", timestamp: 1 }],
          }),
          { sessionId: "conv-1" }
        );

        const reply = yield* Effect.promise(async () => await stream.result());

        yield* until(
          Effect.map(usage.current, (reading) =>
            reading.windows.some(
              (window) => window.id === "five_hour" && window.usedPercent === 50
            )
          )
        );

        const login = yield* ClaudeAccount;

        expect([reply.stopReason, yield* login.login]).toStrictEqual([
          "stop",
          "loggedIn",
        ]);
      }).pipe(
        Effect.provide(
          ClaudeUsage.layerBridgeNoDeps.pipe(
            Layer.provideMerge(ClaudeSdk.layerTest),
            Layer.provideMerge(
              Layer.effect(
                ClaudeSdkScripts,
                ClaudeSdkScripts.make([turnWithReading], [answer()])
              )
            )
          )
        )
      )
  );
});
