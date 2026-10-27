// Client-minted ids. A thread and a command are UUIDv7 strings (RFC 9562): 48 bits of Unix
// milliseconds, the version, then random bits, so ids sort by creation time and a draft becomes a
// thread idempotently. A turn's request id is a UUIDv7 with a prefix, inside the opaque-token form
// the protocol checks.

import { CommandId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import { Clock, Effect, Random, Schema } from "effect";

const hex = (byte: number): string => byte.toString(16).padStart(2, "0");

/** A fresh UUIDv7 string from Effect's `Clock` and `Random`, so a test can fix both. */
export const mintUuid7: Effect.Effect<string> = Effect.gen(function* () {
  const millis = yield* Clock.currentTimeMillis;

  const bytes = Uint8Array.from(
    yield* Effect.replicateEffect(Random.nextIntBetween(0, 255), 16)
  );

  let time = millis;

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }

  // The version nibble (7) and the RFC 9562 variant bits (10), set arithmetically.
  bytes[6] = 0x70 + ((bytes[6] ?? 0) % 16);
  bytes[8] = 0x80 + ((bytes[8] ?? 0) % 64);

  const digits = Array.from(bytes, hex).join("");

  return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`;
});

const decodeThreadId = Schema.decodeEffect(ThreadId);

const decodeCommandId = Schema.decodeEffect(CommandId);

const decodeRequestId = Schema.decodeEffect(RequestId);

/** A new thread id. */
export const mintThreadId = Effect.flatMap(mintUuid7, (id) =>
  Effect.orDie(decodeThreadId(id))
);

/** A new command id. */
export const mintCommandId = Effect.flatMap(mintUuid7, (id) =>
  Effect.orDie(decodeCommandId(id))
);

/** A new turn request id. */
export const mintRequestId = Effect.flatMap(mintUuid7, (id) =>
  Effect.orDie(decodeRequestId(`req-${id}`))
);

/** The thread id a draft id names, when it is a well-formed UUIDv7. */
export const draftIdAsThreadId = Schema.decodeUnknownOption(ThreadId);
