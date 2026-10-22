// The boot JSON the page reads before its socket opens (plan D46, notes/edges.md section 3): the
// shell snapshot, so the sidebar paints on the first frame; the protocol version and the web
// build id, so a page can tell it belongs to another build without waiting for `session.hello`;
// and the VAPID public key. `Static.ts` injects it as `<script id="cairn-boot"
// type="application/json">` with `<` and `>` escaped, and serves it only behind the guard, like
// the page itself. A shell store that cannot be read injects nothing, and the page falls back to
// the socket's snapshot.
import { VapidKey } from "@cairn/protocol/Push";
import { PROTOCOL_VERSION } from "@cairn/protocol/Rpc";
import { ShellSnapshot as ShellSnapshotSchema } from "@cairn/protocol/Shell";
import { Effect, Layer, Option, Schema } from "effect";

import { BootJson } from "../http/Static.ts";
import { SessionHello } from "../rpc/SessionHandlers.ts";
import { ShellSnapshot } from "../shell/ShellSnapshot.ts";

/** The boot JSON's wire shape. The client's `BootData` reads `shell`; `load/` reads `build`. */
export const BootDataJson = Schema.Struct({
  shell: ShellSnapshotSchema,
  protocol: Schema.Literal(PROTOCOL_VERSION),
  /** The web build this page is: the same id `session.hello` reports. */
  build: Schema.String,
  vapidPublicKey: Schema.OptionFromNullOr(VapidKey),
});

export type BootDataJson = typeof BootDataJson.Type;

const encodeBootData = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(BootDataJson))
);

/** The `BootJson` the brain injects: the shell, protocol, build and push key, read per load. */
export const BootData = Layer.effect(
  BootJson,
  Effect.gen(function* () {
    const snapshots = yield* ShellSnapshot;
    const hello = yield* SessionHello;

    const render = Effect.gen(function* () {
      const shell = yield* snapshots.load;
      const vapidPublicKey = yield* hello.vapidPublicKey;

      return yield* encodeBootData({
        shell,
        protocol: PROTOCOL_VERSION,
        build: hello.build,
        vapidPublicKey,
      });
    }).pipe(
      Effect.asSome,
      Effect.catchTags({
        ShellStoreError: (cause) =>
          Effect.logWarning("boot data skipped: shell unreadable").pipe(
            Effect.annotateLogs({
              event: "boot_data.skipped",
              operation: cause.operation,
            }),
            Effect.as(Option.none<string>())
          ),
        SchemaError: (cause) =>
          Effect.logWarning("boot data skipped: shell did not encode").pipe(
            Effect.annotateLogs({
              event: "boot_data.skipped",
              cause: cause.message,
            }),
            Effect.as(Option.none<string>())
          ),
      }),
      Effect.withSpan("BootData.render")
    );

    return BootJson.of({ render });
  })
);
