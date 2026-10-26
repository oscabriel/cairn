// The client's shell: every project and thread row, held as the last snapshot plus the stream items
// applied after it (client-logic's `ShellReducer`). It starts from the boot data the server inlines
// in index.html when there is any, so the first paint needs no round trip, and is kept current by
// `shell.subscribe`, which resumes after the client's cursor on every reconnect.

import { shellCursor } from "@cairn/client-logic/ShellReducer";
import { ShellSnapshot } from "@cairn/protocol/Shell";
import type { ShellStreamItem } from "@cairn/protocol/Shell";
import { Effect, Option, Predicate, Schema } from "effect";

import type { CairnClient } from "../connection/Connection.ts";

/**
 * What the server inlines as JSON in `<script id="cairn-boot" type="application/json">`, or `null`
 * when it inlines nothing (the dev server and a server that could not read its store).
 */
export const BootData = Schema.Struct({
  shell: ShellSnapshot,
});

export type BootData = typeof BootData.Type;

/** The id of the element that carries the boot data. */
export const BOOT_ELEMENT_ID = "cairn-boot";

const decodeBootJson = Schema.decodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(Schema.NullOr(BootData)))
);

/** Reads the inlined boot data. A missing element, `null`, or anything unreadable is none. */
export const readBootData: Effect.Effect<Option.Option<BootData>> = Effect.gen(
  function* () {
    const text = yield* Effect.sync(() =>
      Option.fromNullishOr(
        document.querySelector(`#${BOOT_ELEMENT_ID}`)?.textContent
      )
    );

    return yield* Option.match(text, {
      onNone: () => Effect.succeedNone,
      onSome: (json) => Effect.map(decodeBootJson(json), Option.fromNullOr),
    });
  }
).pipe(Effect.orElseSucceed(() => Option.none()));

/**
 * Opens the shell stream after the client's cursor (from the start when it holds no snapshot),
 * asking for the marker that says the replay is done.
 */
export const subscribeShell = (
  client: CairnClient,
  shell: Option.Option<ShellSnapshot>
) =>
  client["shell.subscribe"]({
    afterSequence: shellCursor(shell),
    requestCompletionMarker: true,
  });

/** True for the items after which the client holds the server's current shell. */
export const isCurrent = (item: ShellStreamItem): boolean =>
  Predicate.isTagged(item, "Snapshot") ||
  Predicate.isTagged(item, "Synchronized");
