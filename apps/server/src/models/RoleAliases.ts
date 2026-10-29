// Drawn from github.com/humanlayer/fold, packages/fold-core/src/Session/Profiles.ts and
// Subagents/SubagentEngine.ts (`resolveModelBinding`) at 4bd8c58c4c644ad43df573c156ecdf8bddedd04d.
// Kept: a role names a binding in one table, bindings resolve to a concrete model before anything
// is recorded, and coverage is checked up front. Changed: the table is Cairn's server setting with
// ordered fallbacks tried at dispatch only, a candidate is passed over for a missing credential, an
// unknown model, a spent plan window or a failing provider, and a child never re-resolves on resume
// (ADR 0035).
//
// MIT License. Copyright (c) 2026 HumanLayer
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// Role aliases: what `@worker`, `@scout`, `@judge` and `@verifier` run on. A brief, a workflow
// script or a recipe holds the role's name; the commit that creates the child calls `resolve` and
// writes the concrete model into the child's `pi.agent` and its dispatch record, so changing the
// table later changes new children only. `check` runs the same walk without side effects for the
// brief card and `roles.check`; `roles` lists the table for the `roles` tool.
//
// Resolution reads the world as it is at the call: the role table (with a launch's overrides over
// it), pi's catalog, which models have a usable credential, `ModelHealth`, and the Claude plan's
// windows. Nothing is cached between calls, so a resolution never answers from a table the user has
// since changed. The pure half (`parseRoleSpec`, `resolveIn`, `checkIn`) takes that world as a
// value, so tests and judges drive it without a brain.

import type { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import type {
  ResolvedRole,
  RoleBinding,
  RoleCheck,
  RoleOverrides,
  RoleTable,
} from "@cairn/protocol/Roles";
import {
  BUILT_IN_ROLES,
  RoleCheck as RoleCheckSchema,
  RoleName,
  RoleSpec,
  SkippedModel,
} from "@cairn/protocol/Roles";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Context, Data, Effect, Layer, Option, Result, Schema } from "effect";

import { ModelSource } from "../brain/ModelSource.ts";
import { BridgeProvider } from "./BridgeProvider.ts";
import { familyOf, sameFamily } from "./ModelFamily.ts";
import { ModelHealth } from "./ModelHealth.ts";
import type { HealthState } from "./ModelHealth.ts";
import { ModelPrice, priceLabel, priceOf } from "./ModelPrice.ts";
import { clampThinking, PiModelSource } from "./PiModelSource.ts";
import { isAliasRef, SettingsStore } from "./SettingsStore.ts";

/** The thinking levels a spec may end in (`@worker:high`, `opencode-go/gpt-6-luna:low`). */
const LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const isThinkingLevel = (word: string): word is ThinkingLevel =>
  LEVELS.has(word);

/** The worker role, whose family a judge or verifier should not share. */
export const WORKER_ROLE = RoleName.make("@worker");

/** Roles that judge or verify the worker's output and are warned when they share its family. */
const CHECKING_ROLES: ReadonlySet<string> = new Set(["@judge", "@verifier"]);

/** The Claude bridge's provider id; its plan windows can be spent before any request fails. */
const BRIDGE_PROVIDER = "claude-bridge";

/** A spec parsed: a role with an optional level, or a literal model with an optional level. */
export type ParsedSpec = Data.TaggedEnum<{
  Role: {
    readonly spec: RoleSpec;
    readonly role: RoleName;
    readonly level: Option.Option<ThinkingLevel>;
  };
  Literal: {
    readonly spec: RoleSpec;
    readonly model: ModelRef;
    readonly level: Option.Option<ThinkingLevel>;
  };
}>;

/** Builds and matches `ParsedSpec` values. */
export const ParsedSpec = Data.taggedEnum<ParsedSpec>();

const decodeSpec = Schema.decodeOption(RoleSpec);

const decodeRoleName = Schema.decodeOption(RoleName);

/**
 * Parses what a tool, script or brief passes where a model goes: `@worker`, `@worker:high`, or a
 * literal `provider/modelId[:level]`. A trailing `:level` is always read as the thinking level, so
 * a model id that itself ends in `:high` cannot be named literally. None for anything else.
 */
export const parseRoleSpec = (text: string): Option.Option<ParsedSpec> =>
  Option.flatMap(decodeSpec(text.trim()), (spec) => {
    const colon = spec.lastIndexOf(":");
    const tail = colon === -1 ? "" : spec.slice(colon + 1);

    const [head, level] = isThinkingLevel(tail)
      ? [spec.slice(0, colon), Option.some(tail)]
      : [spec, Option.none<ThinkingLevel>()];

    if (head.startsWith("@")) {
      return Option.map(decodeRoleName(head), (role) =>
        ParsedSpec.Role({ spec, role, level })
      );
    }

    const slash = head.indexOf("/");
    const provider = head.slice(0, slash);
    const modelId = head.slice(slash + 1);

    return slash <= 0 || modelId === ""
      ? Option.none()
      : Option.some(
          ParsedSpec.Literal({ spec, model: { provider, modelId }, level })
        );
  });

/**
 * Everything one resolution reads, taken at the call: the role table, pi's catalog, whether a
 * model's credential is usable, each provider's health, and whether a plan window in front of a
 * model is spent.
 */
export interface RoleWorld {
  readonly table: RoleTable;
  /** The model's catalog entry; none when pi's catalog does not list it. */
  readonly catalog: (model: ModelRef) => Option.Option<Model<Api>>;
  /** Whether the model is offered with a usable credential (the picker's `available`). */
  readonly available: (model: ModelRef) => boolean;
  readonly health: (provider: string) => HealthState;
  /** Whether a plan window in front of the model is spent (the Claude plan's, today). */
  readonly planLimited: (model: ModelRef) => boolean;
}

/** Why a spec did not resolve: the reasons a brief card blocks Go on. */
export type Unresolved = Extract<
  RoleCheck["resolution"],
  { readonly _tag: "Unresolved" }
>;

/** The two outcomes of a spec's check, with their constructors and guards. */
const Resolution = RoleCheckSchema.fields.resolution.pipe(
  Schema.toTaggedUnion("_tag")
);

const unresolved = (
  reason: Unresolved["reason"],
  skipped: ReadonlyArray<SkippedModel> = []
): Unresolved => Resolution.cases.Unresolved.make({ reason, skipped });

const bindingOfJson = (binding: RoleOverrides[RoleName]): RoleBinding => ({
  model: binding.model,
  thinkingLevel: Option.fromNullOr(binding.thinkingLevel),
  fallbacks: binding.fallbacks,
  note: Option.fromNullOr(binding.note),
});

/** The binding a role resolves through: the launch's override when it names the role, else the table's. */
const bindingOf = (
  world: RoleWorld,
  role: RoleName,
  overrides: Option.Option<RoleOverrides>
): Option.Option<RoleBinding> =>
  Option.orElse(
    Option.flatMap(overrides, (given) =>
      Option.map(
        Option.fromUndefinedOr(
          Object.hasOwn(given, role) ? given[role] : undefined
        ),
        bindingOfJson
      )
    ),
    () =>
      Option.fromUndefinedOr(
        Object.hasOwn(world.table, role) ? world.table[role] : undefined
      )
  );

/** Why `model` cannot take a child now, or none when it can. */
const skipReasonOf = (
  world: RoleWorld,
  model: ModelRef
): Option.Option<SkippedModel["reason"]> => {
  if (isAliasRef(model) || Option.isNone(world.catalog(model))) {
    return Option.some("unknown_model");
  }

  if (!world.available(model)) {
    return Option.some("missing_credential");
  }

  const health = world.health(model.provider);

  if (health === "failing") {
    return Option.some("failing");
  }

  return health === "limited" || world.planLimited(model)
    ? Option.some("limited")
    : Option.none();
};

const resolvedOn = (
  world: RoleWorld,
  input: {
    readonly spec: RoleSpec;
    readonly role: Option.Option<RoleName>;
    readonly model: ModelRef;
    readonly level: Option.Option<ThinkingLevel>;
    readonly via: ResolvedRole["via"];
    readonly skipped: ReadonlyArray<SkippedModel>;
  }
): ResolvedRole => {
  const entry = world.catalog(input.model);

  const thinkingLevel = Option.map(input.level, (wanted) =>
    Option.match(entry, {
      onNone: () => wanted,
      onSome: (found) => clampThinking(found, wanted),
    })
  );

  return {
    spec: input.spec,
    role: Option.getOrNull(input.role),
    model: { provider: input.model.provider, modelId: input.model.modelId },
    thinkingLevel: Option.getOrNull(thinkingLevel),
    via: input.via,
    skipped: input.skipped,
    family: familyOf(input.model),
    priced: ModelPrice.$is("Priced")(priceOf(input.model, world.catalog)),
  };
};

/**
 * Resolves `text` against `world`: a role walks its binding's model, then its fallbacks, and takes
 * the first that is in the catalog, has a usable credential, and is neither failing nor limited; a
 * literal model must pass the same test itself. The spec's `:level` wins over the binding's, and
 * either is held to the levels the model takes. Fails with the reason a brief card blocks Go on.
 */
export const resolveIn = (
  world: RoleWorld,
  text: string,
  overrides: Option.Option<RoleOverrides> = Option.none()
): Result.Result<ResolvedRole, Unresolved> => {
  const parsed = parseRoleSpec(text);

  if (Option.isNone(parsed)) {
    return Result.fail(unresolved("invalid_spec"));
  }

  return ParsedSpec.$match(parsed.value, {
    Literal: ({ spec, model, level }) =>
      Option.match(skipReasonOf(world, model), {
        onNone: () =>
          Result.succeed(
            resolvedOn(world, {
              spec,
              role: Option.none(),
              model,
              level,
              via: "literal",
              skipped: [],
            })
          ),
        onSome: (reason) =>
          Result.fail(unresolved("no_ready_model", [{ model, reason }])),
      }),
    Role: ({ spec, role, level }) => {
      const binding = bindingOf(world, role, overrides);

      if (Option.isNone(binding)) {
        return Result.fail(unresolved("unbound_role"));
      }

      const { model, fallbacks, thinkingLevel } = binding.value;
      const wanted = Option.orElse(level, () => thinkingLevel);
      const skipped: Array<SkippedModel> = [];

      for (const [index, candidate] of [model, ...fallbacks].entries()) {
        const reason = skipReasonOf(world, candidate);

        if (Option.isNone(reason)) {
          return Result.succeed(
            resolvedOn(world, {
              spec,
              role: Option.some(role),
              model: candidate,
              level: wanted,
              via: index === 0 ? "primary" : "fallback",
              skipped,
            })
          );
        }

        skipped.push({ model: candidate, reason: reason.value });
      }

      return Result.fail(unresolved("no_ready_model", skipped));
    },
  });
};

/**
 * Each spec's preview for the brief card, without side effects: resolved or why Go is blocked, and
 * whether a `@judge` or `@verifier` shares the family of what `@worker` resolves to now.
 */
export const checkIn = (
  world: RoleWorld,
  specs: ReadonlyArray<string>,
  overrides: Option.Option<RoleOverrides> = Option.none()
): ReadonlyArray<RoleCheck> => {
  const worker = Result.getSuccess(resolveIn(world, WORKER_ROLE, overrides));

  return specs.map((text): RoleCheck => {
    const result = resolveIn(world, text, overrides);

    const sameFamilyAsWorker = Result.match(result, {
      onFailure: () => false,
      onSuccess: (resolved) =>
        resolved.role !== null &&
        CHECKING_ROLES.has(resolved.role) &&
        Option.match(worker, {
          onNone: () => false,
          onSome: (working) => sameFamily(working.model, resolved.model),
        }),
    });

    return {
      spec: text.trim() === "" ? "(empty)" : text.trim(),
      resolution: Result.match(result, {
        onFailure: (failure): RoleCheck["resolution"] => failure,
        onSuccess: (resolved): RoleCheck["resolution"] =>
          Resolution.cases.Resolved.make({ resolved }),
      }),
      sameFamilyAsWorker,
    };
  });
};

/** One role or spec as the `roles` tool lists it. */
export interface RoleRow {
  readonly check: RoleCheck;
  /** The resolved model's list price, as `priceLabel` words it; none when unresolved. */
  readonly price: Option.Option<string>;
}

/** Where a role sorts in the listing: built-ins in their order, then the rest. */
const rankOf = (role: string) => {
  const index = BUILT_IN_ROLES.indexOf(role);

  return index === -1 ? BUILT_IN_ROLES.length : index;
};

/** The resolved half of a check; none when it did not resolve. */
const resolvedOf = (check: RoleCheck): Option.Option<ResolvedRole> =>
  Resolution.match(check.resolution, {
    Resolved: ({ resolved }) => Option.some(resolved),
    Unresolved: () => Option.none(),
  });

/**
 * Each of `specs` resolved now, or with none every role in the table, built-ins first, each with
 * its resolved model's list price.
 */
export const rolesIn = (
  world: RoleWorld,
  specs: Option.Option<ReadonlyArray<string>> = Option.none()
): ReadonlyArray<RoleRow> => {
  const named = Option.getOrElse(specs, () =>
    Object.keys(world.table).toSorted(
      (a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b)
    )
  );

  return checkIn(world, named).map((check) => ({
    check,
    price: Option.map(resolvedOf(check), (found) =>
      priceLabel(priceOf(found.model, world.catalog))
    ),
  }));
};

const modelText = (model: ModelRef) => `${model.provider}/${model.modelId}`;

const SKIP_WORDS: Record<SkippedModel["reason"], string> = {
  missing_credential: "no usable credential",
  unknown_model: "not in the catalog",
  limited: "its plan limit is reached",
  failing: "its provider is failing",
};

const skippedText = (skipped: ReadonlyArray<SkippedModel>) =>
  skipped
    .map(({ model, reason }) => `${modelText(model)} (${SKIP_WORDS[reason]})`)
    .join(", ");

const UNRESOLVED_WORDS: Record<Unresolved["reason"], string> = {
  invalid_spec: "it is neither a role (@name) nor provider/modelId",
  unbound_role: "no role by that name is bound",
  no_ready_model: "no model it names is ready",
};

/** One line per role for the `roles` tool: name, model and level, readiness, price, warnings. */
export const rolesText = (rows: ReadonlyArray<RoleRow>): string => {
  const lines = rows.map(({ check, price }) => {
    const { spec, resolution } = check;

    if (Resolution.guards.Unresolved(resolution)) {
      const why =
        resolution.reason === "no_ready_model"
          ? `not ready: ${skippedText(resolution.skipped)}`
          : UNRESOLVED_WORDS[resolution.reason];

      return `${spec}: ${why}`;
    }

    const { resolved } = resolution;

    const level =
      resolved.thinkingLevel === null ? "" : ` at ${resolved.thinkingLevel}`;

    const via =
      resolved.via === "fallback"
        ? `, fallback after ${skippedText(resolved.skipped)}`
        : "";

    const family = check.sameFamilyAsWorker
      ? `, same family as ${WORKER_ROLE}`
      : "";

    return `${spec}: ${modelText(resolved.model)}${level}, ready${via}; ${Option.getOrElse(price, () => "no price listed")}${family}`;
  });

  return [
    ...lines,
    "",
    "Where a tool takes a model, pass a role (@worker), a role with a level (@worker:high), or provider/modelId[:level].",
  ].join("\n");
};

/** A spec could not be resolved; the message lists what can be passed instead. */
export class RoleError extends Schema.TaggedError<RoleError>()("RoleError", {
  message: Schema.String,
  spec: Schema.String,
  reason: Schema.Literals(["unbound_role", "invalid_spec", "no_ready_model"]),
  skipped: Schema.Array(SkippedModel),
}) {}

/** The text of a `RoleError` for `text`: why, what was passed over, and the specs that resolve now. */
const roleErrorOf = (
  world: RoleWorld,
  text: string,
  failure: Unresolved
): RoleError => {
  const ready = rolesIn(world)
    .filter((row) => Resolution.guards.Resolved(row.check.resolution))
    .map((row) => row.check.spec);

  const passed =
    failure.skipped.length === 0
      ? ""
      : ` Passed over: ${skippedText(failure.skipped)}.`;

  const valid =
    ready.length === 0
      ? "No role resolves now; name a ready model as provider/modelId."
      : `Roles that resolve now: ${ready.join(", ")}; or name a model as provider/modelId[:level].`;

  return new RoleError({
    message: `RoleAliases.resolve could not resolve "${text}": ${UNRESOLVED_WORDS[failure.reason]}.${passed} ${valid}`,
    spec: text,
    reason: failure.reason,
    skipped: failure.skipped,
  });
};

/** The role table, the catalog or the provider list could not be read. Nothing was resolved; retry. */
export class RoleAliasesUnavailable extends Schema.TaggedError<RoleAliasesUnavailable>()(
  "RoleAliasesUnavailable",
  {
    message: Schema.String,
    operation: Schema.Literals([
      "RoleAliases.resolve",
      "RoleAliases.check",
      "RoleAliases.rows",
    ]),
    cause: Schema.Defect(),
  }
) {}

/** The failure of a read `operation` needed. */
const unavailable =
  (operation: RoleAliasesUnavailable["operation"]) =>
  (cause: { readonly message: string }) =>
    new RoleAliasesUnavailable({
      message: `${operation} could not read the role table, the catalog or the providers: ${cause.message}. Nothing was resolved; retry.`,
      operation,
      cause,
    });

/** Whether a Claude plan window that applies to `modelId` is spent. */
const windowSpentFor = (
  windows: ReadonlyArray<{
    readonly id: string;
    readonly usedPercent: number;
    readonly exhausted: boolean;
  }>,
  modelId: string
): boolean =>
  windows.some((window) => {
    const spent = window.exhausted || window.usedPercent >= 100;

    // `monthly_spend` is extra usage past the plan; spending it does not stop the plan's windows.
    if (!spent || window.id === "monthly_spend") {
      return false;
    }

    const scoped = /^seven_day_(?<model>.+)$/u.exec(window.id);

    return (
      scoped === null ||
      modelId
        .toLowerCase()
        .replaceAll("-", "_")
        .includes(scoped.groups?.model ?? "")
    );
  });

/**
 * Role resolution over the brain's settings, catalog, provider health and plan windows. Each call
 * reads them afresh, so a resolution always sees the table as it is at that moment.
 */
export class RoleAliases extends Context.Service<
  RoleAliases,
  {
    /**
     * Resolves a spec for the commit that creates a child. Fails with `RoleError` (whose message
     * lists the specs that resolve now) when the spec is invalid, unbound or has no ready model.
     */
    resolve(
      spec: string,
      overrides: Option.Option<RoleOverrides>
    ): Effect.Effect<ResolvedRole, RoleError | RoleAliasesUnavailable>;
    /** Each spec's preview for the brief card and `roles.check`; writes nothing. */
    check(
      specs: ReadonlyArray<string>,
      overrides: Option.Option<RoleOverrides>
    ): Effect.Effect<ReadonlyArray<RoleCheck>, RoleAliasesUnavailable>;
    /** Each of `specs` resolved now, or with none every role in the table, for the `roles` tool. */
    rows(
      specs: Option.Option<ReadonlyArray<string>>
    ): Effect.Effect<ReadonlyArray<RoleRow>, RoleAliasesUnavailable>;
  }
>()("cairn/server/models/RoleAliases") {
  /**
   * Over `SettingsStore`, `PiModelSource`, the brain's `ModelSource` and `ModelHealth`. Reads the
   * Claude plan's windows from `BridgeProvider` when one is provided; without it only
   * `ModelHealth` marks the bridge limited.
   */
  static readonly layerNoDeps = Layer.effect(
    RoleAliases,
    Effect.gen(function* () {
      const settings = yield* SettingsStore;
      const catalog = yield* PiModelSource;
      const source = yield* ModelSource;
      const health = yield* ModelHealth;
      const bridge = yield* Effect.serviceOption(BridgeProvider);

      const claudeUsage = Option.flatMap(bridge, (provided) => provided.usage);

      const world = Effect.gen(function* () {
        const current = yield* settings.get;

        const listed = yield* catalog.catalog({
          bridgeEnabled: current.bridgeEnabled,
        });

        const states = new Map(
          (yield* health.all).map((report) => [report.provider, report.state])
        );

        const windows = yield* Option.match(claudeUsage, {
          onNone: () => Effect.succeed([]),
          onSome: (usage) =>
            Effect.map(usage.current, (reading) => reading.windows),
        });

        const available = new Set(
          listed.models
            .filter((model) => model.available)
            .map((model) => `${model.provider}/${model.modelId}`)
        );

        const models = source.models();

        const found: RoleWorld = {
          table: current.roleBindings,
          catalog: (model) =>
            Option.fromUndefinedOr(
              models.getModel(model.provider, model.modelId)
            ),
          available: (model) => available.has(modelText(model)),
          health: (provider) => states.get(provider) ?? "unknown",
          planLimited: (model) =>
            model.provider === BRIDGE_PROVIDER &&
            windowSpentFor(windows, model.modelId),
        };

        return found;
      });

      const resolve = Effect.fn("RoleAliases.resolve")(function* (
        spec: string,
        overrides: Option.Option<RoleOverrides>
      ) {
        const now = yield* world.pipe(
          Effect.mapError(unavailable("RoleAliases.resolve"))
        );

        const result = resolveIn(now, spec, overrides);

        if (Result.isFailure(result)) {
          return yield* roleErrorOf(now, spec, result.failure);
        }

        return result.success;
      });

      const check = Effect.fn("RoleAliases.check")(
        function* (
          specs: ReadonlyArray<string>,
          overrides: Option.Option<RoleOverrides>
        ) {
          const now = yield* world;

          return checkIn(now, specs, overrides);
        },
        Effect.mapError(unavailable("RoleAliases.check"))
      );

      const rows = Effect.fn("RoleAliases.rows")(
        function* (specs: Option.Option<ReadonlyArray<string>>) {
          const now = yield* world;

          return rolesIn(now, specs);
        },
        Effect.mapError(unavailable("RoleAliases.rows"))
      );

      return RoleAliases.of({ resolve, check, rows });
    })
  );
}
