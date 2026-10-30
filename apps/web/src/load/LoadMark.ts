// The page's own account of a load (plan D46, notes/edges.md section 3 "Client report"). Once the
// shell's list shows its project thread (or says there is none) and one more frame has run, so Foldkit's first
// update loop turn has painted, the page records `performance.mark("cairn:interactive")` and posts
// one report to `POST /api/load-report`, which the brain writes as a `load.report` log line. The
// report is posted with `fetch(..., {keepalive: true})` rather than `navigator.sendBeacon`: the
// guard requires the exact Origin on every POST, which `fetch` always sends and a beacon need not.
// A page that never becomes interactive within 30 s reports nothing.

import { Duration, Effect, Schema } from "effect";

import { openedEarly } from "./EarlySocket.ts";

/** The mark's name, which `judges/load.ts` reads with `performance.getEntriesByName`. */
export const INTERACTIVE_MARK = "cairn:interactive";

/** Where the report goes. */
export const LOAD_REPORT_PATH = "/api/load-report";

/**
 * The shell list's project thread, or its word for having none: either means the thread list has
 * rendered. The desktop column holds them on a phone too, hidden (`next/shell/View.ts`).
 */
export const READY_SELECTOR = [
  '[data-testid="shell-project-thread"]',
  '[data-testid="shell-no-project-thread"]',
  '[data-testid="shell-no-projects"]',
].join(", ");

/** How long the page may take before it gives up on reporting. */
const GIVE_UP_AFTER = Duration.seconds(30);

/** What the page reports, as `LoadRoute` decodes it. */
export interface LoadReportBody {
  readonly interactiveMs: number;
  readonly requestsBeforeInteractive: number;
  readonly standalone: boolean;
}

const nextFrame = Effect.callback<number>((resume) => {
  const handle = requestAnimationFrame((time) => {
    resume(Effect.succeed(time));
  });

  return Effect.sync(() => {
    cancelAnimationFrame(handle);
  });
});

const isReady = () => document.querySelector(READY_SELECTOR) !== null;

/**
 * Requests made before `at` (milliseconds since navigation start): the document, every resource
 * the page started fetching, and the socket when it was opened early.
 */
export const requestsBefore = (
  resourceStarts: ReadonlyArray<number>,
  at: number,
  socketOpened: boolean
): number =>
  1 +
  resourceStarts.filter((start) => start <= at).length +
  (socketOpened ? 1 : 0);

const isStandalone = () =>
  ("standalone" in navigator && navigator.standalone === true) ||
  matchMedia("(display-mode: standalone)").matches;

/** The load report could not be sent; the page carries on without it. */
class LoadReportNotSent extends Schema.TaggedError<LoadReportNotSent>()(
  "LoadReportNotSent",
  { cause: Schema.Defect() }
) {}

const post = (body: LoadReportBody) =>
  Effect.tryPromise({
    try: async () =>
      await fetch(LOAD_REPORT_PATH, {
        method: "POST",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    catch: (cause) => new LoadReportNotSent({ cause }),
  }).pipe(Effect.ignore);

/** Waits until the page is interactive, marks it, and reports the load. Run once per page. */
export const markInteractive = Effect.gen(function* () {
  yield* nextFrame.pipe(Effect.repeat({ until: isReady }));

  // One more frame: the frame that showed the rows has been painted.
  yield* nextFrame;

  const mark = yield* Effect.sync(() => performance.mark(INTERACTIVE_MARK));

  const starts = yield* Effect.sync(() =>
    performance.getEntriesByType("resource").map((entry) => entry.startTime)
  );

  yield* post({
    interactiveMs: mark.startTime,
    requestsBeforeInteractive: requestsBefore(
      starts,
      mark.startTime,
      openedEarly()
    ),
    standalone: isStandalone(),
  });
}).pipe(Effect.timeoutOption(GIVE_UP_AFTER), Effect.asVoid);
