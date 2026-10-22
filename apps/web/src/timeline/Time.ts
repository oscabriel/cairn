// Timestamps and durations for the transcript, from epoch milliseconds (S8: no `Date`). The clock
// face follows t3code's `formatDayAwareTimestamp` (github.com/pingdotgg/t3code,
// apps/web/src/timestampFormat.ts:160 at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92) without its
// day awareness: the hover shows the time, the tooltip the full date.
const TIME = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const FULL = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/** "3:42 PM". */
export const formatClock = (epochMs: number): string => TIME.format(epochMs);

/** "Wed, Oct 21, 2026, 3:42:10 PM". */
export const formatFull = (epochMs: number): string => FULL.format(epochMs);
