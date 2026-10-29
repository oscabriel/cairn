// `reach.list` (ADR 0038, docs/phase-2/notes/reach.md R3): one thread's artifacts and portals, or
// every thread's, as the work panel and the artifact and portal entries show them. Artifacts come
// from `Artifacts.list`; portals are read here from the `portals` table (migration 0011) as they
// stand, every state but `removed`, so the list answers before and after the portal tools land.

import type { ThreadId } from "@cairn/protocol/Ids";
import { PortalRow } from "@cairn/protocol/Reach";
import type { ReachList } from "@cairn/protocol/Reach";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Artifacts, ArtifactsError } from "./Artifacts.ts";

const StoredPortal = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  port: Schema.NullOr(Schema.Int),
  command: Schema.String,
  cwd: Schema.String,
  state: Schema.String,
  arms: Schema.String,
  ttl_hours: Schema.Int,
  opened_at: Schema.Int,
  expires_at: Schema.Int,
  stopped_at: Schema.NullOr(Schema.Int),
  stop_reason: Schema.NullOr(Schema.String),
});

const decodeStoredPortals = Schema.decodeUnknownEffect(
  Schema.Array(StoredPortal)
);

const decodePortal = Schema.decodeUnknownEffect(Schema.toType(PortalRow));

const at = (millis: number) => DateTime.makeUnsafe(millis);

/** Answers `reach.list`. */
export class ReachLister extends Context.Service<
  ReachLister,
  {
    /** Artifacts and portals, newest first: one thread's, or every thread's. */
    list(
      threadId: Option.Option<ThreadId>
    ): Effect.Effect<ReachList, ArtifactsError>;
  }
>()("cairn/server/reach/ReachList/ReachLister") {
  /** Over the ambient `Artifacts` and `SqlClient`. */
  static readonly layerNoDeps = Layer.effect(
    ReachLister,
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      const sql = yield* SqlClient.SqlClient;

      const readPortals = (threadId: Option.Option<ThreadId>) =>
        Option.match(threadId, {
          onNone: () => sql`
            SELECT * FROM portals WHERE state <> 'removed'
            ORDER BY opened_at DESC, id
          `,
          onSome: (thread) => sql`
            SELECT * FROM portals WHERE state <> 'removed' AND thread_id = ${thread}
            ORDER BY opened_at DESC, id
          `,
        });

      const portals = Effect.fn("ReachLister.portals")(
        function* (threadId: Option.Option<ThreadId>) {
          const stored = yield* decodeStoredPortals(
            yield* readPortals(threadId)
          );

          return yield* Effect.forEach(stored, (row) =>
            decodePortal({
              id: row.id,
              threadId: row.thread_id,
              name: row.name,
              url: row.url,
              port: Option.fromNullOr(row.port),
              command: row.command,
              cwd: row.cwd,
              state: row.state,
              arms: row.arms,
              ttlHours: row.ttl_hours,
              openedAt: at(row.opened_at),
              expiresAt: at(row.expires_at),
              stoppedAt: Option.map(Option.fromNullOr(row.stopped_at), at),
              stopReason: Option.fromNullOr(row.stop_reason),
            })
          );
        },
        Effect.mapError(
          (cause) =>
            new ArtifactsError({
              message: `reach.list could not read the portals table: ${cause.message}. Retry; check the brain's log if it repeats.`,
              operation: "reach.list",
              reason: "store",
              cause,
            })
        )
      );

      const list = Effect.fn("ReachLister.list")(function* (
        threadId: Option.Option<ThreadId>
      ) {
        return {
          artifacts: yield* artifacts.list(threadId),
          portals: yield* portals(threadId),
        };
      });

      return ReachLister.of({ list });
    })
  );
}
