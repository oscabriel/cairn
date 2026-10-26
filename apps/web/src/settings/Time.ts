// Text the settings page, the usage meter and the parked banner print: a reset time and the used
// share of a plan window, in the device's locale and the user's clock.

import { DateTime, Option } from "effect";

import type { ClientSettings } from "./ClientSettings.ts";

type TimestampFormat = ClientSettings["timestampFormat"];

/** The `hour12` option per format; the locale's own clock sets none. */
const HOUR_12: Readonly<Record<TimestampFormat, Option.Option<boolean>>> = {
  locale: Option.none(),
  "12-hour": Option.some(true),
  "24-hour": Option.some(false),
};

/** A day and time such as "Thu 3:00 PM", in the device's time zone. */
export const formatDayTime = (
  at: DateTime.Utc,
  format: TimestampFormat = "locale"
): string =>
  DateTime.formatLocal(at, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    ...Option.match(HOUR_12[format], {
      onNone: () => ({}),
      onSome: (hour12) => ({ hour12 }),
    }),
  });

/** A used fraction as a whole percentage, or "unknown" when the probe could not tell. */
export const formatUsed = (used: Option.Option<number>): string =>
  Option.match(used, {
    onNone: () => "unknown",
    onSome: (fraction) => `${Math.round(fraction * 100)}%`,
  });
