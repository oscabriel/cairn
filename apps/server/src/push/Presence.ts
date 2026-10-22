// What each open page shows, as its own reports say: every 15 seconds and on every visibility
// change, a page sends `presence.report` with its device id, whether it is visible and the thread on
// screen. Reports live in memory only: a restart forgets them, and the worst that costs is one push
// for a thread the user was looking at. A thread counts as watched while a report younger than 30
// seconds says a visible page shows it.
import type { ThreadId } from "@cairn/protocol/Ids";
import type { PresenceReport } from "@cairn/protocol/Push";
import { Clock, Context, Duration, Effect, Layer, Option, Ref } from "effect";

/** How long a report counts; twice the page's reporting interval. */
export const PRESENCE_WINDOW = Duration.seconds(30);

interface Seen {
  readonly visible: boolean;
  readonly threadId: Option.Option<ThreadId>;
  readonly at: number;
}

/** The latest presence report of every device. */
export class Presence extends Context.Service<
  Presence,
  {
    /** Records a device's report, replacing its previous one. */
    report(report: PresenceReport): Effect.Effect<void>;
    /** True while a visible page reported showing `threadId` within `PRESENCE_WINDOW`. */
    isWatched(threadId: ThreadId): Effect.Effect<boolean>;
  }
>()("cairn/server/push/Presence") {
  /** Reports in memory, timed by `Clock`. */
  static readonly layer = Layer.effect(
    Presence,
    Effect.gen(function* () {
      const reports = yield* Ref.make(new Map<string, Seen>());
      const window = Duration.toMillis(PRESENCE_WINDOW);

      const report = Effect.fn("Presence.report")(function* (
        input: PresenceReport
      ) {
        const now = yield* Clock.currentTimeMillis;

        yield* Ref.update(reports, (current) => {
          const next = new Map<string, Seen>();

          for (const [device, seen] of current) {
            if (now - seen.at < window) {
              next.set(device, seen);
            }
          }

          next.set(input.deviceId, {
            visible: input.visible,
            threadId: input.threadId,
            at: now,
          });

          return next;
        });
      });

      const isWatched = Effect.fn("Presence.isWatched")(function* (
        threadId: ThreadId
      ) {
        const now = yield* Clock.currentTimeMillis;
        const current = yield* Ref.get(reports);

        for (const seen of current.values()) {
          if (
            seen.visible &&
            now - seen.at < window &&
            Option.contains(seen.threadId, threadId)
          ) {
            return true;
          }
        }

        return false;
      });

      return Presence.of({ report, isWatched });
    })
  );
}
