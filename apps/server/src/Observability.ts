// Logging and telemetry for the brain. Logs go to stdout (the journal under systemd), one JSON object
// per line in production and judges, pretty in dev. When `CAIRN_EVENTS_LOG` names a file, every
// line is appended there too, so a judge driving a transient unit can read `listening`, `closing`
// and `closed` without the journal. OTLP export is wired but stays a no-op until the standard
// `OTEL_EXPORTER_OTLP_*` variables are set (plan D52, coding standard S58).
import { appendFileSync } from "node:fs";

import { Config, Effect, Layer, Logger, Option, References } from "effect";
import { FetchHttpClient } from "effect/http";
import { Otlp, OtlpSerialization } from "effect/observability";

/** How lines are written to stdout. */
export type LogFormat = "json" | "pretty";

const logLevel = Config.LogLevel("CAIRN_LOG_LEVEL").pipe(
  Config.withDefault("Info" as const)
);

const eventsLogPath = Config.option(Config.String("CAIRN_EVENTS_LOG"));

const consoleLogger = (format: LogFormat) =>
  format === "json" ? Logger.consoleJson : Logger.consolePretty();

// One synchronous append per line: nothing is lost to a batch when a judge kills the process.
const eventsFileLogger = (file: string) =>
  Logger.map(Logger.formatJson, (line) => {
    appendFileSync(file, `${line}\n`);
  });

const loggers = (format: LogFormat) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const level = yield* logLevel;
      const events = yield* eventsLogPath;
      const minimum = Layer.succeed(References.MinimumLogLevel, level);

      if (Option.isNone(events)) {
        return Layer.merge(
          Logger.layer([consoleLogger(format)], { mergeWithExisting: false }),
          minimum
        );
      }

      return Layer.merge(
        Logger.layer([consoleLogger(format), eventsFileLogger(events.value)], {
          mergeWithExisting: false,
        }),
        minimum
      );
    })
  );

const telemetry = Otlp.layerFromConfig({
  resource: { serviceName: "cairn-brain" },
  loggerMergeWithExisting: true,
}).pipe(
  Layer.provide(OtlpSerialization.layerJson),
  Layer.provide(FetchHttpClient.layer)
);

/**
 * The logging and telemetry layer an entry point provides under everything else. Needs
 * `FileSystem` only when `CAIRN_EVENTS_LOG` is set; fails on an unreadable `CAIRN_LOG_LEVEL`.
 */
export const observabilityLayer = (format: LogFormat) =>
  telemetry.pipe(Layer.provideMerge(loggers(format)));
