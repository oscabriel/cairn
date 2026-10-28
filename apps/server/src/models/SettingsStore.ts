// The server-owned settings (`settings.get`, `settings.update`), kept in `cairn.sqlite`'s
// `settings` table so every device sees the same values: one row per setting, its value as the
// setting's encoded JSON. A row that no longer decodes (a setting whose shape changed) reads as the
// default and is logged; the next update writes it again.

import { DEFAULT_ROLE_TABLE } from "@cairn/protocol/Roles";
import type { SettingsPatch } from "@cairn/protocol/Settings";
import { ServerSettings } from "@cairn/protocol/Settings";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

/** The settings table could not be read or written. Nothing changed; retry. */
export class SettingsStoreError extends Schema.TaggedError<SettingsStoreError>()(
  "SettingsStoreError",
  {
    message: Schema.String,
    operation: Schema.Literals(["SettingsStore.get", "SettingsStore.update"]),
    cause: Schema.Defect(),
  }
) {}

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

const codecs = {
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
      yield* Schema.encodeEffect(codecs.autoSettleDays)(
        settings.autoSettleDays
      ),
    ],
    [
      "titleModel",
      yield* Schema.encodeEffect(codecs.titleModel)(settings.titleModel),
    ],
    [
      "bridgeEnabled",
      yield* Schema.encodeEffect(codecs.bridgeEnabled)(settings.bridgeEnabled),
    ],
    [
      "bridgeGenerationCap",
      yield* Schema.encodeEffect(codecs.bridgeGenerationCap)(
        settings.bridgeGenerationCap
      ),
    ],
    [
      "roleBindings",
      yield* Schema.encodeEffect(codecs.roleBindings)(settings.roleBindings),
    ],
    [
      "defaultBudget",
      yield* Schema.encodeEffect(codecs.defaultBudget)(settings.defaultBudget),
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
    /** Applies the patch's present keys in one transaction and returns the result. */
    update(
      patch: SettingsPatch
    ): Effect.Effect<ServerSettings, SettingsStoreError>;
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
            codecs.autoSettleDays,
            defaults.autoSettleDays
          ),
          titleModel: yield* value(
            "titleModel",
            codecs.titleModel,
            defaults.titleModel
          ),
          bridgeEnabled: yield* value(
            "bridgeEnabled",
            codecs.bridgeEnabled,
            defaults.bridgeEnabled
          ),
          bridgeGenerationCap: yield* value(
            "bridgeGenerationCap",
            codecs.bridgeGenerationCap,
            defaults.bridgeGenerationCap
          ),
          roleBindings: yield* value(
            "roleBindings",
            codecs.roleBindings,
            defaults.roleBindings
          ),
          defaultBudget: yield* value(
            "defaultBudget",
            codecs.defaultBudget,
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

      const update = Effect.fn("SettingsStore.update")(
        function* (patch: SettingsPatch) {
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
        Effect.mapError(
          (cause) =>
            new SettingsStoreError({
              message:
                "SettingsStore.update could not write the settings table. Nothing changed; retry.",
              operation: "SettingsStore.update",
              cause,
            })
        )
      );

      return SettingsStore.of({ get, update });
    })
  );
}
