// Ported from cairn-v1, apps/server/src/Push.ts (`loadVapid`) at 1a5cd4a. Kept: the VAPID key pair is
// made once into `push.json` beside `cairn.json` (created with `wx` at 0600, so a second process
// racing the first reads the winner's key), a file found with group or world bits is narrowed to
// 0600, and the subject is `mailto:admin@gneiss.run`. Changed: an Effect service over `FileSystem`
// and `ServerConfig.configDir`; the file is decoded with a schema; the private key never reaches a
// log or an error message.
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Context, Effect, FileSystem, Layer, Predicate, Schema } from "effect";

import { ServerConfig } from "../Config.ts";

/** The VAPID `sub` claim: who a push service writes to about this sender. */
export const VAPID_SUBJECT = "mailto:admin@gneiss.run";

/** The file under the config directory that holds the key pair. */
export const VAPID_FILE = "push.json";

/** A VAPID key pair in `web-push`'s format, and the subject that signs with it. */
export const VapidKeys = Schema.Struct({
  /** The uncompressed P-256 public point, base64url (the page's `applicationServerKey`). */
  publicKey: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{86,88}$/u)),
  /** The private scalar `d`, base64url. Never logged. */
  privateKey: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{42,44}$/u)),
  subject: Schema.String,
});

/** A VAPID key pair. */
export type VapidKeys = typeof VapidKeys.Type;

const decodeVapidFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VapidKeys)
);

/** `push.json` could not be read, made or decoded. Push stays off until the file is fixed. */
export class VapidError extends Schema.TaggedError<VapidError>()("VapidError", {
  message: Schema.String,
  file: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * A new VAPID key pair in `web-push`'s format: the public key as an uncompressed P-256 point and
 * the private key as its scalar `d`, both base64url. WebCrypto only.
 */
export const generateVapidKeyPair = Effect.gen(function* () {
  const { subtle } = globalThis.crypto;

  const pair = yield* Effect.tryPromise(
    async () =>
      await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ])
  );

  const raw = yield* Effect.tryPromise(
    async () => await subtle.exportKey("raw", pair.publicKey)
  );

  const jwk = yield* Effect.tryPromise(
    async () => await subtle.exportKey("jwk", pair.privateKey)
  );

  return yield* Schema.decodeUnknownEffect(VapidKeys)({
    publicKey: Buffer.from(raw).toString("base64url"),
    privateKey: jwk.d,
    subject: VAPID_SUBJECT,
  });
}).pipe(Effect.withSpan("Vapid.generateVapidKeyPair"));

/**
 * Where the VAPID key comes from. In memory unless the entry point says `file`: dev brains, judges
 * and tests share the deployed brain's config directory and must never make or read `push.json`.
 */
export const VapidKeySource = Context.Reference<{
  readonly kind: "file" | "ephemeral";
}>("cairn/server/push/Vapid/VapidKeySource", {
  defaultValue: () => ({ kind: "ephemeral" }),
});

/** The deployed brain's choice: `push.json` under the config directory. */
export const VapidKeyFromFile = Layer.succeed(VapidKeySource, {
  kind: "file",
});

/** The server's one VAPID key pair. */
export class Vapid extends Context.Service<
  Vapid,
  {
    /** The key pair and subject every push is signed with. */
    readonly keys: VapidKeys;
  }
>()("cairn/server/push/Vapid") {
  /**
   * The key pair from `<configDir>/push.json`, made there (0600) when the file does not exist.
   * Needs `ServerConfig` and `FileSystem`; fails with `VapidError` when the file is unreadable or
   * not a key pair.
   */
  static readonly layerNoDeps = Layer.effect(
    Vapid,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const file = path.join(config.configDir, VAPID_FILE);

      const failure = (what: string) => (cause: unknown) =>
        new VapidError({
          message: `Vapid could not ${what} ${file}. Web Push stays off; fix or remove the file and restart.`,
          file,
          cause,
        });

      const read = Effect.gen(function* () {
        const text = yield* fs
          .readFileString(file)
          .pipe(Effect.mapError(failure("read")));

        const keys = yield* decodeVapidFile(text).pipe(
          Effect.mapError(failure("decode a VAPID key pair from"))
        );

        const info = yield* fs
          .stat(file)
          .pipe(Effect.mapError(failure("stat")));

        if (info.mode % 0o100 !== 0) {
          yield* fs.chmod(file, 0o600).pipe(Effect.mapError(failure("chmod")));
        }

        return keys;
      });

      const exists = yield* fs
        .exists(file)
        .pipe(Effect.mapError(failure("look for")));

      if (exists) {
        return Vapid.of({ keys: yield* read });
      }

      const pair = yield* generateVapidKeyPair.pipe(
        Effect.mapError(failure("make a key pair for"))
      );

      yield* fs
        .makeDirectory(config.configDir, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(failure("make the directory of")));

      const json = `${JSON.stringify(pair, null, 2)}\n`;

      // `wx` refuses an existing file: a racing process's key wins and is read back below.
      yield* fs.writeFileString(file, json, { flag: "wx", mode: 0o600 }).pipe(
        Effect.andThen(
          Effect.logInfo("made a VAPID key pair").pipe(
            Effect.annotateLogs({ event: "vapid_created", file })
          )
        ),
        Effect.catchTag("PlatformError", (error) =>
          Predicate.isTagged(error.reason, "AlreadyExists")
            ? Effect.void
            : Effect.logWarning("could not write the VAPID key pair").pipe(
                Effect.annotateLogs({
                  event: "vapid_write_failed",
                  file,
                  detail: error.message,
                })
              )
        )
      );

      return Vapid.of({ keys: yield* read });
    })
  );

  /** Over Node's file system. Needs `ServerConfig`. */
  static readonly layer = Vapid.layerNoDeps.pipe(
    Layer.provide(NodeServices.layer)
  );

  /** Fixed keys, for tests. */
  static readonly layerFromKeys = (keys: VapidKeys) =>
    Layer.succeed(Vapid, Vapid.of({ keys }));

  /**
   * A key pair made in memory at start and never written: for dev brains and judges, which share
   * the deployed brain's config directory and must not make or read its `push.json`. A device
   * subscribed to one of these brains is subscribed to a key that dies with the process.
   */
  static readonly layerEphemeral = Layer.effect(
    Vapid,
    generateVapidKeyPair.pipe(
      Effect.map((keys) => Vapid.of({ keys })),
      Effect.orDie
    )
  );

  /**
   * The key `VapidKeySource` chooses: `push.json` for the deployed brain (`main.ts` provides
   * `VapidKeyFromFile`), a key in memory for every other brain. Needs `ServerConfig`.
   */
  static readonly layerChosen = Layer.unwrap(
    Effect.gen(function* () {
      const source = yield* VapidKeySource;

      if (source.kind !== "file") {
        return Vapid.layerEphemeral;
      }

      // A bad `push.json` must not stop boot: under `Restart=always` that is a crash loop, for a
      // feature that can wait. Push runs on a key in memory until the file is fixed (T6).
      return Vapid.layer.pipe(
        Layer.catchTag("VapidError", (unreadable) =>
          Layer.effectDiscard(
            Effect.logWarning(
              `${unreadable.message} Push runs on a key in memory until then, so devices subscribed to the file's key get 403 until they subscribe again.`
            ).pipe(
              Effect.annotateLogs({
                event: "vapid_unavailable",
                file: unreadable.file,
              })
            )
          ).pipe(Layer.provideMerge(Vapid.layerEphemeral))
        )
      );
    })
  );
}
