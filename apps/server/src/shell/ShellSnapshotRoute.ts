// `GET /api/shell`: the shell snapshot over plain HTTP, so a page can paint the sidebar before its
// socket is up and then subscribe with `afterSequence` set to the snapshot's sequence. The guard
// (Host, identity, Origin, `Sec-Fetch-Site`) runs before this route as global middleware.
import { ShellSnapshot as ShellSnapshotSchema } from "@cairn/protocol/Shell";
import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { ShellSnapshot } from "./ShellSnapshot.ts";

const snapshotJson = HttpServerResponse.schemaJson(
  Schema.toCodecJson(ShellSnapshotSchema)
);

const noStore = { "cache-control": "no-store" };

const failure = (status: 500 | 503, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { code, message, retryable: status === 503 },
    { status, headers: noStore }
  );

/** Answers the current shell snapshot as JSON, never cached. */
export const ShellSnapshotRoute = HttpRouter.add(
  "GET",
  "/api/shell",
  Effect.gen(function* () {
    const snapshots = yield* ShellSnapshot;
    const snapshot = yield* snapshots.load;

    return yield* snapshotJson(snapshot, { headers: noStore });
  }).pipe(
    Effect.catchTags({
      ShellStoreError: (cause) =>
        Effect.logWarning("GET /api/shell failed", {
          operation: cause.operation,
        }).pipe(
          Effect.as(
            failure(
              503,
              "unavailable",
              "The shell could not be read. Nothing changed; reload in a moment."
            )
          )
        ),
      HttpBodyError: () =>
        Effect.succeed(
          failure(
            500,
            "internal",
            "The shell could not be encoded. Report this with the time it happened."
          )
        ),
    })
  )
);
