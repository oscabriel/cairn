// The server-owned settings (`settings.get`, `settings.update`), kept in `cairn.sqlite`'s
// `settings` table so every device sees the same values: one row per setting, its value as the
// setting's encoded JSON. A row that no longer decodes (a setting whose shape changed) reads as the
// default and is logged; the next update writes it again.
//
// The role table (ADR 0035) is seeded once: the first store over a database writes the default
// table, so the user's table is what the database holds from then on and a later change to the
// defaults never moves it. Its built-in roles always exist (a stored table missing one reads with
// the default binding for it), and an update that drops a built-in or binds a role to another role
// is refused with `SettingsInvalid`, changing nothing.

import type { ModelRef } from "@cairn/protocol/Models";
import type { RoleBinding, RoleTable } from "@cairn/protocol/Roles";
import {
  BUILT_IN_ROLES,
  DEFAULT_ROLE_TABLE,
  RoleName,
} from "@cairn/protocol/Roles";
import type { SettingsPatch } from "@cairn/protocol/Settings";
import { ServerSettings } from "@cairn/protocol/Settings";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql";

import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";

/** The settings table could not be read or written. Nothing changed; retry. */
export class SettingsStoreError extends Schema.TaggedError<SettingsStoreError>()(
  "SettingsStoreError",
  {
    message: Schema.String,
    operation: Schema.Literals(["SettingsStore.get", "SettingsStore.update"]),
    cause: Schema.Defect(),
  }
) {}

/** A patch would break a setting's rules. Nothing changed; fix the named setting and send again. */
export class SettingsInvalid extends Schema.TaggedError<SettingsInvalid>()(
  "SettingsInvalid",
  {
    message: Schema.String,
    field: Schema.Literals(["roleBindings"]),
  }
) {}

/**
 * Whether a model reference names a role instead of a model: a binding may never point at one. Only
 * the provider slot is read, because real model ids start with `@` too (every
 * `cloudflare-workers-ai` model is `@cf/...`).
 */
export const isAliasRef = (model: ModelRef): boolean =>
  model.provider.startsWith("@");

/** What a role table breaks, if anything: a missing built-in role, or a binding naming a role. */
export interface RoleTableProblem {
  readonly role: string;
  readonly problem: "missing_built_in" | "alias_binding";
}

/** Every rule the stored table must keep: the built-ins exist, and no binding names a role. */
export const roleTableProblems = (
  table: RoleTable
): ReadonlyArray<RoleTableProblem> => {
  const missing = BUILT_IN_ROLES.filter(
    (role) => !Object.hasOwn(table, role)
  ).map((role): RoleTableProblem => ({ role, problem: "missing_built_in" }));

  const aliased = Object.entries(table)
    .filter(([, binding]) =>
      [binding.model, ...binding.fallbacks].some(isAliasRef)
    )
    .map(([role]): RoleTableProblem => ({ role, problem: "alias_binding" }));

  return [...missing, ...aliased];
};

/** `table` with every built-in role it lacks taken from `defaults`. */
export const withBuiltIns = (
  table: RoleTable,
  defaults: RoleTable
): RoleTable => {
  const filled: Record<RoleName, RoleBinding> = { ...table };

  for (const [role, binding] of Object.entries(defaults)) {
    if (BUILT_IN_ROLES.includes(role) && !Object.hasOwn(filled, role)) {
      filled[RoleName.make(role)] = binding;
    }
  }

  return filled;
};

/** An update's storage failure, as the store reports it. */
const updateFailed = (cause: SqlError.SqlError | Schema.SchemaError) =>
  Effect.fail(
    new SettingsStoreError({
      message:
        "SettingsStore.update could not write the settings table. Nothing changed; retry.",
      operation: "SettingsStore.update",
      cause,
    })
  );

/** The settings a fresh brain starts with. */
export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  autoSettleDays: 3,
  titleModel: Option.none(),
  bridgeEnabled: true,
  bridgeGenerationCap: 4,
  roleBindings: DEFAULT_ROLE_TABLE,
  defaultBudget: DEFAULT_BUDGET,
};

const { fields } = ServerSettings;

/** Each setting's stored JSON codec, as the `settings` table holds it. */
export const ServerSettingsCodecs = {
  autoSettleDays: Schema.fromJsonString(fields.autoSettleDays),
  titleModel: Schema.fromJsonString(fields.titleModel),
  bridgeEnabled: Schema.fromJsonString(fields.bridgeEnabled),
  bridgeGenerationCap: Schema.fromJsonString(fields.bridgeGenerationCap),
  roleBindings: Schema.fromJsonString(fields.roleBindings),
  defaultBudget: Schema.fromJsonString(fields.defaultBudget),
};

const Row = Schema.Struct({ key: Schema.String, value_json: Schema.String });

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

/** One stored value, or `fallback` when it is absent or no longer decodes. */
const readValue = <A>(
  key: string,
  codec: Schema.Codec<A, string>,
  stored: Option.Option<string>,
  fallback: A
): Effect.Effect<A> =>
  Option.match(stored, {
    onNone: () => Effect.succeed(fallback),
    onSome: (json) =>
      Schema.decodeEffect(codec)(json).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.logWarning("stored setting no longer decodes").pipe(
            Effect.annotateLogs({ event: "setting_reset", key }),
            Effect.as(fallback)
          )
        )
      ),
  });

/** Every setting as its row: key and encoded JSON. */
const encodeRows = Effect.fnUntraced(function* (settings: ServerSettings) {
  const rows: ReadonlyArray<readonly [string, string]> = [
    [
      "autoSettleDays",
      yield* Schema.encodeEffect(ServerSettingsCodecs.autoSettleDays)(
        settings.autoSettleDays
      ),
    ],
    [
      "titleModel",
      yield* Schema.encodeEffect(ServerSettingsCodecs.titleModel)(
        settings.titleModel
      ),
    ],
    [
      "bridgeEnabled",
      yield* Schema.encodeEffect(ServerSettingsCodecs.bridgeEnabled)(
        settings.bridgeEnabled
      ),
    ],
    [
      "bridgeGenerationCap",
      yield* Schema.encodeEffect(ServerSettingsCodecs.bridgeGenerationCap)(
        settings.bridgeGenerationCap
      ),
    ],
    [
      "roleBindings",
      yield* Schema.encodeEffect(ServerSettingsCodecs.roleBindings)(
        settings.roleBindings
      ),
    ],
    [
      "defaultBudget",
      yield* Schema.encodeEffect(ServerSettingsCodecs.defaultBudget)(
        settings.defaultBudget
      ),
    ],
  ];

  return rows;
});

/** The patch's present values over `current`. */
export const applySettingsPatch = (
  current: ServerSettings,
  patch: SettingsPatch
): ServerSettings => ({
  autoSettleDays: Option.getOrElse(
    patch.autoSettleDays,
    () => current.autoSettleDays
  ),
  titleModel: Option.getOrElse(patch.titleModel, () => current.titleModel),
  bridgeEnabled: Option.getOrElse(
    patch.bridgeEnabled,
    () => current.bridgeEnabled
  ),
  bridgeGenerationCap: Option.getOrElse(
    patch.bridgeGenerationCap,
    () => current.bridgeGenerationCap
  ),
  roleBindings: Option.getOrElse(
    patch.roleBindings,
    () => current.roleBindings
  ),
  defaultBudget: Option.getOrElse(
    patch.defaultBudget,
    () => current.defaultBudget
  ),
});

/** The server-owned settings in `cairn.sqlite`. */
export class SettingsStore extends Context.Service<
  SettingsStore,
  {
    /** The current settings, defaults filling any that were never set. */
    readonly get: Effect.Effect<ServerSettings, SettingsStoreError>;
    /**
     * Applies the patch's present keys in one transaction and returns the result. Fails with
     * `SettingsInvalid` when the role table drops a built-in role or binds a role to a role.
     */
    update(
      patch: SettingsPatch
    ): Effect.Effect<ServerSettings, SettingsStoreError | SettingsInvalid>;
  }
>()("cairn/server/models/SettingsStore") {
  /** Reads and writes `settings` through the ambient `SqlClient`. */
  static readonly layerNoDeps = Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const read = Effect.gen(function* () {
        const rows = yield* sql`SELECT key, value_json FROM settings`.pipe(
          Effect.flatMap(decodeRows)
        );

        const stored = new Map(rows.map((row) => [row.key, row.value_json]));

        const value = <A>(
          key: keyof ServerSettings,
          codec: Schema.Codec<A, string>,
          fallback: A
        ) =>
          readValue(
            key,
            codec,
            Option.fromNullishOr(stored.get(key)),
            fallback
          );

        const defaults = DEFAULT_SERVER_SETTINGS;

        const settings: ServerSettings = {
          autoSettleDays: yield* value(
            "autoSettleDays",
            ServerSettingsCodecs.autoSettleDays,
            defaults.autoSettleDays
          ),
          titleModel: yield* value(
            "titleModel",
            ServerSettingsCodecs.titleModel,
            defaults.titleModel
          ),
          bridgeEnabled: yield* value(
            "bridgeEnabled",
            ServerSettingsCodecs.bridgeEnabled,
            defaults.bridgeEnabled
          ),
          bridgeGenerationCap: yield* value(
            "bridgeGenerationCap",
            ServerSettingsCodecs.bridgeGenerationCap,
            defaults.bridgeGenerationCap
          ),
          roleBindings: withBuiltIns(
            yield* value(
              "roleBindings",
              ServerSettingsCodecs.roleBindings,
              defaults.roleBindings
            ),
            DEFAULT_ROLE_TABLE
          ),
          defaultBudget: yield* value(
            "defaultBudget",
            ServerSettingsCodecs.defaultBudget,
            defaults.defaultBudget
          ),
        };

        return settings;
      });

      const get = read.pipe(
        Effect.mapError(
          (cause) =>
            new SettingsStoreError({
              message:
                "SettingsStore.get could not read the settings table. Nothing changed; retry.",
              operation: "SettingsStore.get",
              cause,
            })
        ),
        Effect.withSpan("SettingsStore.get")
      );

      // Seed the role table once, so the defaults in code never move a table the user has.
      yield* Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        const json = yield* Schema.encodeEffect(
          ServerSettingsCodecs.roleBindings
        )(DEFAULT_ROLE_TABLE);

        yield* sql`
          INSERT INTO settings (key, value_json, updated_at)
          VALUES ('roleBindings', ${json}, ${now})
          ON CONFLICT (key) DO NOTHING
        `;
      }).pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.logWarning("role table not seeded").pipe(
              Effect.annotateLogs({
                event: "role_table_seed_failed",
                cause: cause.message,
              })
            ),
          SchemaError: (cause) =>
            Effect.die(
              `The default role table does not encode: ${cause.message}. Fix DEFAULT_ROLE_TABLE.`
            ),
        })
      );

      const update = Effect.fn("SettingsStore.update")(
        function* (patch: SettingsPatch) {
          for (const table of Option.toArray(patch.roleBindings)) {
            const problems = roleTableProblems(table);

            if (problems.length > 0) {
              return yield* new SettingsInvalid({
                message: `SettingsStore.update refused the role table: ${problems
                  .map(({ role, problem }) =>
                    problem === "missing_built_in"
                      ? `${role} is a built-in role and cannot be removed`
                      : `${role} is bound to another role; bind it to a model (provider/modelId)`
                  )
                  .join("; ")}. Nothing changed; fix the table and save again.`,
                field: "roleBindings",
              });
            }
          }

          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const next = applySettingsPatch(yield* read, patch);
              const now = yield* Clock.currentTimeMillis;

              for (const [key, json] of yield* encodeRows(next)) {
                yield* sql`
                  INSERT INTO settings (key, value_json, updated_at)
                  VALUES (${key}, ${json}, ${now})
                  ON CONFLICT (key) DO UPDATE SET
                    value_json = excluded.value_json,
                    updated_at = excluded.updated_at
                `;
              }

              return next;
            })
          );
        },
        Effect.catchTags({ SqlError: updateFailed, SchemaError: updateFailed })
      );

      return SettingsStore.of({ get, update });
    })
  );

  /** Over a fresh migrated in-memory `cairn.sqlite`, for tests and judges that build a brain. */
  static readonly layerTest = SettingsStore.layerNoDeps.pipe(
    Layer.provide(Database.layerTest(migrations))
  );
}
