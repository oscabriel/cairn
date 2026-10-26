// Claude's plan windows and the Claude Code login, from two sources: the usage probe (`ClaudeSdk.probe`,
// a child that sends no prompt) and every `rate_limit_event` a turn reports. Windows merge by id, so a
// sparse event leaves the windows it does not name as they were. The service also provides the real
// `ClaudeAccount` (the login the probe read) and resizes `ClaudeSlots` from the weekly window.
//
// Ported from cairn-v1 apps/server/src/{ClaudeUsage.ts, Usage.ts} at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0 (Cairn's own code): the normalization (fraction versus
// percent, epoch seconds versus ISO), the login rules, "unknown, never zero", and the probe cadence.
// Window ids, labels, `windowDurationMins`, the overage-included naming rule and the `monthly_spend`
// window are ported from pingdotgg/t3code apps/server/src/provider/claudeUsageLimits.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Changed: Effect Schema decoding of the probe's answer
// (a shape change reads as unknown), times as epoch milliseconds from `Clock`, single flight as a
// shared `Deferred`, the slot policy, and the wire projection onto `@cairn/protocol`'s `ProviderUsage`.
//
// MIT License
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import type { PlanWindow, ProviderUsage } from "@cairn/protocol/Usage";
import {
  Clock,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Result,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";

import { Claude } from "./Claude.ts";
import type { ClaudeLogin } from "./ClaudeAccount.ts";
import { ClaudeAccount } from "./ClaudeAccount.ts";
import type { RateLimitInfo } from "./ClaudeEvents.ts";
import { childEnv } from "./ClaudeGuards.ts";
import { PROVIDER_ID } from "./ClaudeModels.ts";
import type { RawProbe } from "./ClaudeSdk.ts";
import { ClaudeSdk } from "./ClaudeSdk.ts";
import { ClaudeSettings } from "./ClaudeSettings.ts";
import { ClaudeSlots, DEFAULT_SLOTS } from "./ClaudeSlots.ts";
import { ClaudeSummary } from "./ClaudeSummary.ts";

/** How long one probe may take, start to close. v1 measured about 450 ms. */
export const PROBE_TIMEOUT = Duration.seconds(10);

/** A watcher arriving this long after the last probe started starts a new one. */
export const STALE_PROBE = Duration.seconds(60);

/** The probe's period while a client watches or a Claude turn ran within it. */
export const PROBE_EVERY = Duration.minutes(5);

/** While no probe could read the login, the first retry waits this long, doubling up to `PROBE_EVERY`. */
export const RETRY_UNKNOWN_LOGIN = Duration.seconds(10);

/** Above this weekly use (percent), fewer children may generate at once. */
export const WEEKLY_SLOT_THRESHOLD = 80;

/** The generation permits while the weekly window is above the threshold. */
export const REDUCED_SLOTS = 2;

/** The account-wide weekly window the slot policy reads. */
const WEEKLY_WINDOW_ID = "seven_day";

// --- Windows ---

/** What a window measures. */
export type UsageWindowKind = "session" | "weekly" | "monthly";

/** One plan window as the bridge knows it. Percent is 0 to 100; times are epoch milliseconds. */
export interface UsageWindow {
  /** A stable key: `five_hour`, `seven_day`, `seven_day_<model>` or `monthly_spend`. */
  readonly id: string;
  readonly kind: UsageWindowKind;
  readonly label: string;
  readonly windowDurationMins: Option.Option<number>;
  readonly usedPercent: number;
  readonly resetsAt: Option.Option<number>;
  /** When the reading that set this window was taken. */
  readonly observedAt: number;
  /** True once Claude refused a request because this window is spent. */
  readonly exhausted: boolean;
}

const SESSION_MINS = 5 * 60;

const WEEK_MINS = 7 * 24 * 60;

const ACCOUNT_WINDOWS: ReadonlyMap<
  string,
  {
    readonly kind: UsageWindowKind;
    readonly label: string;
    readonly mins: number;
  }
> = new Map([
  ["five_hour", { kind: "session", label: "Session", mins: SESSION_MINS }],
  ["seven_day", { kind: "weekly", label: "Weekly", mins: WEEK_MINS }],
]);

/**
 * The event names the overage-included bucket by type, while the probe names it by the model's
 * display name; the probe records the name and the event mapper reuses it.
 */
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";

/** The display name of the overage-included model bucket, as the last probe saw it. */
export interface ScopedNames {
  readonly overageIncluded: Option.Option<string>;
}

/** No probe has named a bucket yet. */
export const NO_SCOPED_NAMES: ScopedNames = { overageIncluded: Option.none() };

/** A utilization as 0 to 100 from a known unit, clamped. */
export const usedPercent = (
  value: number,
  unit: "fraction" | "percent"
): number => {
  const percent = unit === "fraction" ? value * 100 : value;

  return Math.min(100, Math.max(0, percent));
};

/**
 * A reset time in epoch milliseconds from an epoch number: seconds unless it is too large to be (the
 * magnitude rule; seconds stay below 1e12 until the year 33658).
 */
export const resetsAtFromEpoch = (value: number): Option.Option<number> =>
  Number.isFinite(value) && value > 0
    ? Option.some(Math.round(value < 1e12 ? value * 1000 : value))
    : Option.none();

/** A reset time in epoch milliseconds from an ISO 8601 string. */
export const resetsAtFromIso = (
  value: string | null | undefined
): Option.Option<number> =>
  Option.fromNullishOr(value).pipe(
    Option.filter((text) => text.trim().length > 0),
    Option.flatMap((text) => DateTime.make(text)),
    Option.map(DateTime.toEpochMillis)
  );

const scopedWindowId = (displayName: string) =>
  `seven_day_${displayName.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_")}`;

const accountWindow = (
  id: string,
  percent: number,
  resetsAt: Option.Option<number>,
  observedAt: number
): Option.Option<UsageWindow> =>
  Option.map(Option.fromNullishOr(ACCOUNT_WINDOWS.get(id)), (known) => ({
    id,
    kind: known.kind,
    label: known.label,
    windowDurationMins: Option.some(known.mins),
    usedPercent: percent,
    resetsAt,
    observedAt,
    exhausted: false,
  }));

const scopedWindow = (
  displayName: string,
  percent: number,
  resetsAt: Option.Option<number>,
  observedAt: number
): UsageWindow => ({
  id: scopedWindowId(displayName),
  kind: "weekly",
  label: `Weekly · ${displayName}`,
  windowDurationMins: Option.some(WEEK_MINS),
  usedPercent: percent,
  resetsAt,
  observedAt,
  exhausted: false,
});

/** Merges windows by id: an update replaces the window it names and leaves the others, in first-seen order. */
export const mergeWindows = (
  current: ReadonlyArray<UsageWindow>,
  update: ReadonlyArray<UsageWindow>
): ReadonlyArray<UsageWindow> => {
  const byId = new Map(current.map((window) => [window.id, window] as const));

  for (const window of update) {
    byId.set(window.id, window);
  }

  return [...byId.values()];
};

// --- The probe's answer ---

const Utilization = Schema.optional(Schema.NullOr(Schema.Finite));

const ResetsAt = Schema.optional(Schema.NullOr(Schema.String));

const ProbeWindow = Schema.optional(
  Schema.NullOr(
    Schema.Struct({ utilization: Utilization, resets_at: ResetsAt })
  )
);

const ProbeUsage = Schema.Struct({
  subscription_type: Schema.optional(Schema.NullOr(Schema.String)),
  rate_limits_available: Schema.Boolean,
  rate_limits: Schema.NullOr(
    Schema.Struct({
      five_hour: ProbeWindow,
      seven_day: ProbeWindow,
      model_scoped: Schema.optional(
        Schema.Array(
          Schema.Struct({
            display_name: Schema.String,
            utilization: Utilization,
            resets_at: ResetsAt,
          })
        )
      ),
      extra_usage: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            is_enabled: Schema.Boolean,
            monthly_limit: Schema.optional(Schema.NullOr(Schema.Finite)),
            used_credits: Schema.optional(Schema.NullOr(Schema.Finite)),
            utilization: Schema.optional(Schema.NullOr(Schema.Finite)),
          })
        )
      ),
      // Untyped in the pinned SDK; decoded on its own below so a change drops only the spend row.
      spend: Schema.optional(Schema.Unknown),
    })
  ),
});

type ProbeLimits = NonNullable<(typeof ProbeUsage.Type)["rate_limits"]>;

const SpendMoney = Schema.Struct({
  amount_minor: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  currency: Schema.String,
  exponent: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});

const SpendBudget = Schema.Struct({
  enabled: Schema.Boolean,
  used: SpendMoney,
  limit: SpendMoney,
});

const ProbeAccount = Schema.Struct({
  subscriptionType: Schema.optional(Schema.String),
  tokenSource: Schema.optional(Schema.String),
  apiKeySource: Schema.optional(Schema.String),
  apiProvider: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
});

const decodeProbeUsage = Schema.decodeUnknownOption(ProbeUsage);

const decodeSpendBudget = Schema.decodeUnknownOption(SpendBudget);

const decodeProbeAccount = Schema.decodeUnknownOption(ProbeAccount);

/** A decoded number that is present (the schemas already refuse non-finite ones). */
const isFiniteNumber = (value: number | null | undefined): value is number =>
  Predicate.isNumber(value) && Number.isFinite(value);

const percentOfAmounts = (
  used: number | null | undefined,
  limit: number | null | undefined
): Option.Option<number> =>
  isFiniteNumber(used) && isFiniteNumber(limit) && used >= 0 && limit > 0
    ? Option.some(usedPercent((used / limit) * 100, "percent"))
    : Option.none();

/** The monthly spend as a percent of its limit: the spend budget first, then extra usage. */
const spendPercent = (limits: ProbeLimits): Option.Option<number> => {
  const fromBudget = Option.flatMap(decodeSpendBudget(limits.spend), (spend) =>
    spend.enabled &&
    spend.used.currency.trim().length > 0 &&
    spend.used.currency.trim() === spend.limit.currency.trim() &&
    spend.used.exponent === spend.limit.exponent
      ? percentOfAmounts(spend.used.amount_minor, spend.limit.amount_minor)
      : Option.none()
  );

  return Option.orElse(fromBudget, () =>
    Option.flatMap(Option.fromNullishOr(limits.extra_usage), (extra) =>
      extra.is_enabled
        ? Option.orElse(
            percentOfAmounts(extra.used_credits, extra.monthly_limit),
            () =>
              Option.map(
                Option.filter(
                  Option.fromNullishOr(extra.utilization),
                  (value) => value >= 0
                ),
                (value) => usedPercent(value, "percent")
              )
          )
        : Option.none()
    )
  );
};

/** Which login the `claude` binary has, as the probe read it. */
export type UsageLogin =
  | { readonly kind: "firstParty"; readonly plan: Option.Option<string> }
  | { readonly kind: "none" }
  | { readonly kind: "thirdParty"; readonly apiProvider: string }
  | { readonly kind: "unknown"; readonly reason: string };

/** The login as `ClaudeAccount` reports it: only a definite answer refuses turns. */
export const accountLogin = (login: UsageLogin): ClaudeLogin => {
  if (login.kind === "firstParty") {
    return "loggedIn";
  }

  return login.kind === "unknown" ? "unknown" : "loggedOut";
};

/**
 * The login in the probe's account. Threads need a first-party Anthropic login: `apiProvider`
 * `firstParty` (or absent, from a CLI that predates it) with some token. Silence is not disproof.
 */
export const loginOf = ({ account }: RawProbe): UsageLogin => {
  if (account === null || account === undefined) {
    return {
      kind: "unknown",
      reason: "the probe's init answer had no account",
    };
  }

  return Option.match(decodeProbeAccount(account), {
    onNone: (): UsageLogin => ({
      kind: "unknown",
      reason: "the probe's account had an unknown shape",
    }),
    onSome: (found): UsageLogin => {
      if (
        found.apiProvider !== undefined &&
        found.apiProvider !== "firstParty"
      ) {
        return { kind: "thirdParty", apiProvider: found.apiProvider };
      }

      if (found.tokenSource === "none") {
        return { kind: "none" };
      }

      if (
        found.tokenSource === undefined &&
        found.email === undefined &&
        found.subscriptionType === undefined
      ) {
        return {
          kind: "unknown",
          reason: "the probe's account names no login",
        };
      }

      return {
        kind: "firstParty",
        plan: Option.fromNullishOr(found.subscriptionType),
      };
    },
  });
};

/** What the plan windows read as. `unknown` is a value, never zero. */
export type UsageState = "ok" | "limited" | "unavailable" | "unknown";

/** Everything the bridge knows about Claude's plan and login. */
export interface ClaudeUsageReading {
  readonly login: UsageLogin;
  /** The child's API key source as the probe's account reported it; `none` on a subscription login. */
  readonly apiKeySource: Option.Option<string>;
  readonly state: UsageState;
  /** Why the state is unknown or unavailable. */
  readonly reason: Option.Option<string>;
  /** The subscription: `pro`, `max`, `team`, `enterprise`. */
  readonly plan: Option.Option<string>;
  readonly windows: ReadonlyArray<UsageWindow>;
  /** When a probe last answered. */
  readonly checkedAt: Option.Option<number>;
}

/** Before any probe. */
export const INITIAL_READING: ClaudeUsageReading = {
  login: { kind: "unknown", reason: "no probe has read the login yet" },
  apiKeySource: Option.none(),
  state: "unknown",
  reason: Option.some("not read yet"),
  plan: Option.none(),
  windows: [],
  checkedAt: Option.none(),
};

/** One probe's answer, read. */
export interface ProbeReading {
  readonly login: UsageLogin;
  readonly apiKeySource: Option.Option<string>;
  readonly state: UsageState;
  readonly reason: Option.Option<string>;
  readonly plan: Option.Option<string>;
  readonly windows: ReadonlyArray<UsageWindow>;
  readonly names: ScopedNames;
}

const stateOf = (windows: ReadonlyArray<UsageWindow>): UsageState =>
  windows.some((window) => window.usedPercent >= 100 || window.exhausted)
    ? "limited"
    : "ok";

/** The windows of a probe's `rate_limits`, and the overage-included bucket's display name. */
interface ProbeWindows {
  readonly windows: ReadonlyArray<UsageWindow>;
  /** The overage-included bucket's display name, when the probe listed one. */
  readonly overageIncluded: Option.Option<string>;
}

const probeWindows = (
  limits: ProbeLimits,
  observedAt: number
): ProbeWindows => {
  const windows: Array<UsageWindow> = [];

  for (const [id, window] of [
    ["five_hour", limits.five_hour],
    ["seven_day", limits.seven_day],
  ] as const) {
    const utilization = window?.utilization;

    if (isFiniteNumber(utilization)) {
      windows.push(
        ...Option.toArray(
          accountWindow(
            id,
            usedPercent(utilization, "percent"),
            resetsAtFromIso(window?.resets_at),
            observedAt
          )
        )
      );
    }
  }

  // The CLI filters `model_scoped` to the overage-included allowlist (one model today), so the first
  // entry that drew a row is the one the event's `seven_day_overage_included` refers to.
  let overageIncluded = Option.none<string>();

  for (const entry of limits.model_scoped ?? []) {
    if (isFiniteNumber(entry.utilization)) {
      windows.push(
        scopedWindow(
          entry.display_name,
          usedPercent(entry.utilization, "percent"),
          resetsAtFromIso(entry.resets_at),
          observedAt
        )
      );

      if (Option.isNone(overageIncluded)) {
        overageIncluded = Option.some(entry.display_name);
      }
    }
  }

  for (const percent of Option.toArray(spendPercent(limits))) {
    windows.push({
      id: "monthly_spend",
      kind: "monthly",
      label: "Monthly spend",
      windowDurationMins: Option.none(),
      usedPercent: percent,
      resetsAt: Option.none(),
      observedAt,
      exhausted: false,
    });
  }

  return { windows, overageIncluded };
};

/** The probe's raw answer, read. A shape it does not know is unknown, never an empty or zero reading. */
export const readProbe = (raw: RawProbe, observedAt: number): ProbeReading => {
  const fromAccount = loginOf(raw);

  const apiKeySource = Option.flatMap(
    decodeProbeAccount(raw.account),
    (found) => Option.fromNullishOr(found.apiKeySource)
  );

  const decoded = Option.flatMap(raw.usage, decodeProbeUsage);

  // Plan windows are a claude.ai subscription's, so an answer that has them proves a first-party login.
  const login: UsageLogin =
    fromAccount.kind === "unknown" &&
    Option.isSome(decoded) &&
    decoded.value.rate_limits_available
      ? {
          kind: "firstParty",
          plan: Option.fromNullishOr(decoded.value.subscription_type),
        }
      : fromAccount;

  const accountPlan =
    login.kind === "firstParty" ? login.plan : Option.none<string>();

  const base = {
    login,
    apiKeySource,
    plan: accountPlan,
    windows: [],
    names: NO_SCOPED_NAMES,
  };

  const unknown = (reason: string, plan = accountPlan): ProbeReading => ({
    ...base,
    plan,
    state: "unknown",
    reason: Option.some(reason),
  });

  if (login.kind === "none") {
    return {
      ...base,
      state: "unavailable",
      reason: Option.some("the claude CLI is not logged in"),
    };
  }

  if (login.kind === "thirdParty") {
    return {
      ...base,
      state: "unavailable",
      reason: Option.some(
        `the claude CLI uses ${login.apiProvider}, which has no plan windows`
      ),
    };
  }

  if (Option.isNone(raw.usage)) {
    return unknown(
      `usage request failed: ${Option.getOrElse(raw.usageError, () => "no answer")}`
    );
  }

  if (Option.isNone(decoded)) {
    return unknown("usage response shape changed");
  }

  const usage = decoded.value;

  const plan = Option.orElse(
    Option.fromNullishOr(usage.subscription_type),
    () => accountPlan
  );

  // A claude.ai subscription has plan windows; an answer that names one and still says none is a
  // CLI that has not read its profile yet, so the windows already known stand.
  if (
    !usage.rate_limits_available &&
    Predicate.isString(usage.subscription_type)
  ) {
    return unknown(
      `the CLI reported no plan rate limits for a ${usage.subscription_type} subscription`,
      plan
    );
  }

  if (!usage.rate_limits_available) {
    return {
      ...base,
      plan,
      state: "unavailable",
      reason: Option.some("this login has no plan rate limits"),
    };
  }

  if (usage.rate_limits === null) {
    return unknown("the CLI has not fetched the plan's windows", plan);
  }

  const { windows, overageIncluded } = probeWindows(
    usage.rate_limits,
    observedAt
  );

  if (windows.length === 0) {
    return {
      ...unknown("the usage response had no windows", plan),
      names: { overageIncluded },
    };
  }

  return {
    ...base,
    plan,
    state: stateOf(windows),
    reason: Option.none(),
    windows,
    names: { overageIncluded },
  };
};

/** The windows one `rate_limit_event` reports: at most the one it names. Utilization is a fraction. */
export const eventWindows = (
  info: RateLimitInfo,
  names: ScopedNames,
  observedAt: number
): ReadonlyArray<UsageWindow> => {
  const { rateLimitType: type, utilization } = info;

  if (type === undefined || utilization === undefined) {
    return [];
  }

  const percent = usedPercent(utilization, "fraction");

  const resetsAt = Option.flatMap(
    Option.fromNullishOr(info.resetsAt),
    resetsAtFromEpoch
  );

  const window =
    type === OVERAGE_INCLUDED_EVENT_TYPE
      ? Option.map(names.overageIncluded, (name) =>
          scopedWindow(name, percent, resetsAt, observedAt)
        )
      : accountWindow(type, percent, resetsAt, observedAt);

  return Option.toArray(
    Option.map(window, (made) => ({
      ...made,
      exhausted: info.status === "rejected",
    }))
  );
};

/**
 * A probe reading applied to what is known. An unknown reading keeps windows already known (they show
 * as stale); a reading with windows merges them by id; unavailable replaces everything. A probe that
 * could not tell the login keeps the login known before.
 */
export const applyReading = (
  current: ClaudeUsageReading,
  reading: ProbeReading,
  checkedAt: number
): ClaudeUsageReading => {
  const login =
    reading.login.kind === "unknown" ? current.login : reading.login;

  const apiKeySource = Option.orElse(
    reading.apiKeySource,
    () => current.apiKeySource
  );

  const plan = Option.orElse(reading.plan, () => current.plan);

  if (reading.state === "unknown" && current.windows.length > 0) {
    return { ...current, login, apiKeySource, plan };
  }

  if (reading.state === "ok" || reading.state === "limited") {
    const windows = mergeWindows(current.windows, reading.windows);

    return {
      login,
      apiKeySource,
      state: stateOf(windows),
      reason: Option.none(),
      plan,
      windows,
      checkedAt: Option.some(checkedAt),
    };
  }

  return {
    login,
    apiKeySource,
    state: reading.state,
    reason: reading.reason,
    plan,
    windows: [],
    checkedAt: Option.some(checkedAt),
  };
};

/** A probe that answered nothing: the login and the windows are unknown. */
const failedProbe = (reason: string): ProbeReading => ({
  login: { kind: "unknown", reason },
  apiKeySource: Option.none(),
  state: "unknown",
  reason: Option.some(`probe failed: ${reason}`),
  plan: Option.none(),
  windows: [],
  names: NO_SCOPED_NAMES,
});

/** A `rate_limit_event` applied. A rejection marks the state limited until a later reading says otherwise. */
export const applyEvent = (
  current: ClaudeUsageReading,
  info: RateLimitInfo,
  names: ScopedNames,
  observedAt: number
): ClaudeUsageReading => {
  const update = eventWindows(info, names, observedAt);
  const rejected = info.status === "rejected";

  if (update.length === 0 && !rejected) {
    return current;
  }

  const known =
    current.state === "ok" || current.state === "limited"
      ? current.windows
      : [];

  const windows = mergeWindows(known, update);
  const limited = rejected || stateOf(windows) === "limited";

  if (windows.length === 0 && !limited) {
    return current;
  }

  return {
    ...current,
    state: limited ? "limited" : "ok",
    reason: Option.none(),
    windows,
  };
};

/** The reading as the wire's `ProviderUsage`: a fraction per window, resets and checks as `DateTime`. */
export const toProviderUsage = (
  reading: ClaudeUsageReading
): ProviderUsage => ({
  provider: PROVIDER_ID,
  windows: reading.windows.map((window): PlanWindow => ({
    id: window.id,
    label: window.label,
    used: Option.some(window.usedPercent / 100),
    resetsAt: Option.map(window.resetsAt, (at) => DateTime.makeUnsafe(at)),
    exhausted: window.exhausted || window.usedPercent >= 100,
  })),
  checkedAt: Option.map(reading.checkedAt, (at) => DateTime.makeUnsafe(at)),
});

/**
 * The generation permits the plan allows now: `REDUCED_SLOTS` above `WEEKLY_SLOT_THRESHOLD` percent of
 * the weekly window, else `DEFAULT_SLOTS`; none (leave them) while the weekly window is unknown.
 */
export const slotsFor = (reading: ClaudeUsageReading): Option.Option<number> =>
  Option.map(
    Option.fromNullishOr(
      reading.windows.find((window) => window.id === WEEKLY_WINDOW_ID)
    ),
    (weekly) =>
      weekly.usedPercent > WEEKLY_SLOT_THRESHOLD ? REDUCED_SLOTS : DEFAULT_SLOTS
  );

const windowsText = (windows: ReadonlyArray<UsageWindow>) =>
  windows
    .map((window) => `${window.id}=${Math.round(window.usedPercent)}`)
    .join(" ");

// --- The service ---

/** Claude's plan windows and login. */
export class ClaudeUsage extends Context.Service<
  ClaudeUsage,
  {
    /** What is known now. */
    readonly current: Effect.Effect<ClaudeUsageReading>;
    /** The current reading, then each change. Counts as a watcher while it runs. */
    readonly changes: Stream.Stream<ClaudeUsageReading>;
    /** The current usage on the wire (`usage.subscribe`), then each change. Counts as a watcher. */
    readonly watch: Stream.Stream<ReadonlyArray<ProviderUsage>>;
    /** Merges a turn's `rate_limit_event`; a rejection starts one probe. */
    observe(info: RateLimitInfo): Effect.Effect<void>;
    /** Probes now, or joins the probe already running, and waits until it is applied. */
    readonly probe: Effect.Effect<void>;
  }
>()("cairn/bridge/ClaudeUsage") {
  /**
   * The usage service and the real `ClaudeAccount`. Probes at boot (again while the login stays
   * unknown), when a watcher arrives and the last probe is stale, every `PROBE_EVERY` while a client
   * watches or a Claude turn ran within it, and once after a rejection; never on an idle timer.
   * Resizes `ClaudeSlots` from the weekly window.
   */
  static readonly layerNoDeps = Layer.effectContext(
    Effect.gen(function* () {
      const sdk = yield* ClaudeSdk;
      const slots = yield* ClaudeSlots;
      const settings = yield* ClaudeSettings;
      const scope = yield* Effect.scope;

      const ref = yield* SubscriptionRef.make(INITIAL_READING);
      const names = yield* Ref.make(NO_SCOPED_NAMES);
      const inFlight = yield* Ref.make(Option.none<Deferred.Deferred<true>>());
      const lastStartedAt = yield* Ref.make(Option.none<number>());
      const lastTurnAt = yield* Ref.make(Option.none<number>());
      const watchers = yield* Ref.make(0);

      const probeOptions = {
        cwd: settings.fallbackCwd,
        // Not quiet: with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC the windows never come back.
        env: childEnv(settings.env, false),
        executable: settings.executable,
      };

      const runProbe = Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;

        yield* Ref.set(lastStartedAt, Option.some(started));

        const answer = yield* sdk
          .probe(probeOptions)
          .pipe(Effect.timeoutOption(PROBE_TIMEOUT), Effect.result);

        const ended = yield* Clock.currentTimeMillis;

        const reading = Result.match(answer, {
          onFailure: (error) => failedProbe(error.message),
          onSuccess: (found) =>
            Option.match(found, {
              onNone: () =>
                failedProbe(
                  `timed out after ${Duration.toMillis(PROBE_TIMEOUT)} ms`
                ),
              onSome: (raw) => readProbe(raw, ended),
            }),
        });

        if (reading.state === "ok" || reading.state === "limited") {
          yield* Ref.set(names, reading.names);
        }

        const next = yield* SubscriptionRef.updateAndGet(ref, (current) =>
          applyReading(current, reading, ended)
        );

        yield* Effect.logInfo("claude usage probe").pipe(
          Effect.annotateLogs({
            ms: ended - started,
            login: next.login.kind,
            state: next.state,
            reason: Option.getOrElse(reading.reason, () => ""),
            windows: windowsText(next.windows),
          })
        );
      });

      const probe = Effect.gen(function* () {
        const fresh = yield* Deferred.make<true>();

        const join = (
          current: Option.Option<Deferred.Deferred<true>>
        ): readonly [
          readonly [Deferred.Deferred<true>, boolean],
          Option.Option<Deferred.Deferred<true>>,
        ] =>
          Option.isSome(current)
            ? [[current.value, false], current]
            : [[fresh, true], Option.some(fresh)];

        const [flight, mine] = yield* Ref.modify(inFlight, join);

        if (mine) {
          // In the layer's scope, so a caller that stops waiting never cancels a probe others joined.
          yield* Effect.forkIn(
            runProbe.pipe(
              Effect.ensuring(
                Effect.andThen(
                  Ref.set(inFlight, Option.none()),
                  Deferred.succeed(fresh, true)
                )
              )
            ),
            scope
          );
        }

        yield* Deferred.await(flight);
      });

      const probeInBackground = Effect.asVoid(Effect.forkIn(probe, scope));

      const sinceLastProbe = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const started = yield* Ref.get(lastStartedAt);

        return Option.match(started, {
          onNone: () => Number.POSITIVE_INFINITY,
          onSome: (at) => now - at,
        });
      });

      const busy = Effect.gen(function* () {
        const watching = yield* Ref.get(watchers);
        const generating = yield* slots.generating;
        const now = yield* Clock.currentTimeMillis;
        const turnAt = yield* Ref.get(lastTurnAt);

        return (
          watching > 0 ||
          generating.length > 0 ||
          Option.exists(
            turnAt,
            (at) => now - at <= Duration.toMillis(PROBE_EVERY)
          )
        );
      });

      // Boot: probe, and keep asking with a growing pause while no probe could read the login.
      yield* Effect.forkIn(
        Effect.gen(function* () {
          let pause = RETRY_UNKNOWN_LOGIN;

          yield* probe;

          while ((yield* SubscriptionRef.get(ref)).login.kind === "unknown") {
            yield* Effect.sleep(pause);
            yield* probe;
            pause = Duration.min(Duration.times(pause, 2), PROBE_EVERY);
          }
        }),
        scope
      );

      // The tick: only while someone watches or Claude turns run.
      yield* Effect.forkIn(
        Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(PROBE_EVERY);

            if (yield* busy) {
              yield* probe;
            }
          })
        ),
        scope
      );

      // The slot policy: follow the weekly window; a shrink lets running generations finish.
      yield* Effect.forkIn(
        Stream.runForEach(SubscriptionRef.changes(ref), (reading) =>
          Option.match(slotsFor(reading), {
            onNone: () => Effect.void,
            onSome: (target) =>
              Effect.gen(function* () {
                const size = yield* slots.size;

                if (size !== target) {
                  yield* slots.resize(target);
                  yield* Effect.logInfo("claude slots resized").pipe(
                    Effect.annotateLogs({ from: size, to: target })
                  );
                }
              }),
          })
        ),
        scope
      );

      const observe = Effect.fn("ClaudeUsage.observe")(function* (
        info: RateLimitInfo
      ) {
        const now = yield* Clock.currentTimeMillis;
        const known = yield* Ref.get(names);

        yield* Ref.set(lastTurnAt, Option.some(now));

        const before = yield* SubscriptionRef.get(ref);

        yield* SubscriptionRef.update(ref, (current) =>
          applyEvent(current, info, known, now)
        );

        // Once per rejection: the probe reads the windows around the spent one and when it resets.
        if (info.status === "rejected" && before.state !== "limited") {
          yield* probeInBackground;
        }
      });

      const changes = Stream.unwrap(
        Effect.as(
          Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Ref.update(watchers, (n) => n + 1);

              if ((yield* sinceLastProbe) > Duration.toMillis(STALE_PROBE)) {
                yield* probeInBackground;
              }
            }),
            () => Ref.update(watchers, (n) => n - 1)
          ),
          SubscriptionRef.changes(ref)
        )
      );

      const usage = ClaudeUsage.of({
        current: SubscriptionRef.get(ref),
        changes,
        watch: Stream.map(changes, (reading) => [toProviderUsage(reading)]),
        observe,
        probe,
      });

      const account = ClaudeAccount.of({
        login: Effect.map(SubscriptionRef.get(ref), (reading) =>
          accountLogin(reading.login)
        ),
      });

      return Context.make(ClaudeUsage, usage).pipe(
        Context.add(ClaudeAccount, account)
      );
    })
  );

  /** Feeds every plan-window reading the bridge's children report into `ClaudeUsage`. */
  static readonly feed = Layer.effectDiscard(
    Effect.gen(function* () {
      const claude = yield* Claude;
      const usage = yield* ClaudeUsage;

      yield* Effect.forkScoped(
        Stream.runForEach(claude.rateLimits, (info) => usage.observe(info))
      );
    })
  );

  /**
   * The whole bridge over a `ClaudeSdk`: `Claude` with the real login, one-shot summaries, the usage
   * service and its feed, sharing one `ClaudeSlots`.
   */
  static readonly layerBridgeNoDeps = ClaudeUsage.feed.pipe(
    Layer.provideMerge(Claude.layerNoDeps),
    Layer.provideMerge(
      Layer.mergeAll(ClaudeUsage.layerNoDeps, ClaudeSummary.layerNoDeps)
    ),
    Layer.provideMerge(ClaudeSlots.layer)
  );

  /** The whole bridge on the real Agent SDK: what a composition root provides. */
  static readonly layerBridge = ClaudeUsage.layerBridgeNoDeps.pipe(
    Layer.provideMerge(ClaudeSdk.layer)
  );
}
