// Reads the brain's events log, the file judges aim by (plan, "Deployment": judges run the brain with
// `CAIRN_PORT=0` and read the bound port from it; the durability judge waits on `partial N`,
// `tool_started` and `committed`).
//
// The log is Effect's own structured JSON, one object per line, as `Logger.formatJson` writes it
// (`{message, level, timestamp, cause, annotations, spans, fiberId}`). An event is a line whose
// `annotations.event` is a string, so the brain names one with
// `Effect.log("listening").pipe(Effect.annotateLogs({ event: "listening", port }))`; a line without
// that annotation is named by its message when the message is one string. Lines that are not such
// objects (a Node warning, a torn line after `kill -9`) are skipped, never fatal. The same parser
// reads `journalctl -o cat` output of the unit, which is the same JSON on stdout.

import { Buffer } from "node:buffer";

import {
  DateTime,
  Effect,
  FileSystem,
  Option,
  Predicate,
  Ref,
  Result,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { Duration } from "effect";

const LogLine = Schema.Struct({
  message: Schema.Unknown,
  level: Schema.String,
  timestamp: Schema.DateTimeUtcFromString,
  annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

const decodeLogLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(LogLine)
);

export interface BrainEvent {
  /** The `event` annotation, or the message when it is one string. */
  readonly event: string;
  readonly level: string;
  readonly at: DateTime.Utc;
  /** Every annotation on the line, `event` included. */
  readonly fields: Readonly<Record<string, Schema.Json>>;
}

export class EventsLogError extends Schema.TaggedError<EventsLogError>()(
  "EventsLogError",
  {
    path: Schema.String,
    operation: Schema.Literals(["read", "follow"]),
    cause: Schema.Defect(),
  }
) {
  override get message(): string {
    return `Events log ${this.operation} failed for ${this.path}; check that the brain can write it and the judge can read it.`;
  }
}

export class EventTimeout extends Schema.TaggedError<EventTimeout>()(
  "EventTimeout",
  { path: Schema.String, waitedFor: Schema.String }
) {
  override get message(): string {
    return `Events log wait timed out: no ${this.waitedFor} line appeared in ${this.path}; read the log to see how far the brain got.`;
  }
}

/** One log line, or none when it is not a structured log line with a name. */
export const parseLine = (line: string): Option.Option<BrainEvent> =>
  Option.flatMap(decodeLogLine(line), (decoded) => {
    const fields = decoded.annotations ?? {};

    const named = fields.event;

    const event = Predicate.isString(named)
      ? Option.some(named)
      : Option.liftPredicate(decoded.message, Predicate.isString);

    return Option.map(event, (name) => ({
      event: name,
      level: decoded.level,
      at: decoded.timestamp,
      fields,
    }));
  });

/** Every event in a block of text, in order. */
export const parseLines = (text: string): ReadonlyArray<BrainEvent> =>
  text.split("\n").flatMap((line) => Option.toArray(parseLine(line)));

/** Matches events by name. */
export const named =
  (name: string) =>
  (event: BrainEvent): boolean =>
    event.event === name;

/** A numeric annotation, such as the bound `port` on `listening`. */
export const numberField = (
  event: BrainEvent,
  name: string
): Option.Option<number> =>
  Option.liftPredicate(event.fields[name], Predicate.isNumber);

/** A string annotation. */
export const stringField = (
  event: BrainEvent,
  name: string
): Option.Option<string> =>
  Option.liftPredicate(event.fields[name], Predicate.isString);

/**
 * The log's size in bytes, 0 when it does not exist yet. Pass it as `from` to see only what the brain
 * writes after this moment, for example the `listening` line of the next restart.
 */
export const size = Effect.fnUntraced(
  function* (path: string) {
    const fs = yield* FileSystem.FileSystem;

    // One stat, not exists-then-stat: the log can be removed between the two (a replaced log).
    return yield* fs.stat(path).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(0))
    );
  },
  (effect, path) =>
    Effect.mapError(
      effect,
      (cause) => new EventsLogError({ path, operation: "read", cause })
    )
);

/** Every event in the log now; an absent log has none. */
export const read = Effect.fnUntraced(
  function* (path: string) {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(path))) {
      return [];
    }

    return parseLines(yield* fs.readFileString(path));
  },
  (effect, path) =>
    Effect.mapError(
      effect,
      (cause) => new EventsLogError({ path, operation: "read", cause })
    )
);

export interface FollowOptions {
  /** Byte offset to start from (see `size`); 0 reads the log from its start. */
  readonly from?: number;
  readonly interval?: Duration.Input;
}

const newline = 0x0a;

/**
 * Every event from `from` on, as the brain writes it, forever. Only whole lines are read, so a
 * line the brain is still writing waits for the next poll. A log that shrinks was replaced, and is
 * read again from its start; a log that does not exist yet is waited for.
 */
export const follow = (
  path: string,
  options?: FollowOptions
): Stream.Stream<BrainEvent, EventsLogError, FileSystem.FileSystem> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const cursor = yield* Ref.make(options?.from ?? 0);

      const poll = Effect.gen(function* () {
        const start = yield* Ref.get(cursor);

        const end = yield* size(path);

        if (end < start) {
          yield* Ref.set(cursor, 0);

          return [];
        }

        if (end === start) {
          return [];
        }

        const chunks = yield* fs
          .stream(path, { offset: start, bytesToRead: end - start })
          .pipe(Stream.runCollect);

        const bytes = Buffer.concat(chunks);

        const lastNewline = bytes.lastIndexOf(newline);

        if (lastNewline === -1) {
          return [];
        }

        yield* Ref.set(cursor, start + lastNewline + 1);

        return parseLines(bytes.toString("utf-8", 0, lastNewline + 1));
      }).pipe(
        Effect.mapError(
          (cause) => new EventsLogError({ path, operation: "follow", cause })
        )
      );

      return Stream.fromEffectSchedule(
        poll,
        Schedule.spaced(options?.interval ?? "50 millis")
      ).pipe(Stream.flatMap(Stream.fromIterable));
    })
  );

export interface WaitOptions extends FollowOptions {
  readonly timeout: Duration.Input;
}

/**
 * The first value `select` finds in the events from `from` on, or `EventTimeout`. `description`
 * names what was awaited in the error.
 */
export const waitForSome = <A>(
  path: string,
  description: string,
  select: (event: BrainEvent) => Option.Option<A>,
  options: WaitOptions
): Effect.Effect<A, EventsLogError | EventTimeout, FileSystem.FileSystem> =>
  follow(path, options).pipe(
    Stream.filterMap((event) => Result.fromOption(select(event), () => event)),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new EventTimeout({ path, waitedFor: description })),
        onSome: Effect.succeed,
      })
    ),
    Effect.timeoutOrElse({
      duration: options.timeout,
      orElse: () =>
        Effect.fail(new EventTimeout({ path, waitedFor: description })),
    })
  );

/** The first event from `from` on that matches, or `EventTimeout`. */
export const waitFor = (
  path: string,
  description: string,
  matches: (event: BrainEvent) => boolean,
  options: WaitOptions
): Effect.Effect<
  BrainEvent,
  EventsLogError | EventTimeout,
  FileSystem.FileSystem
> =>
  waitForSome(
    path,
    description,
    (event) => Option.liftPredicate(event, matches),
    options
  );

/**
 * The port from the first `listening` line (with a numeric `port`) from `from` on: how a judge finds
 * a brain started with `CAIRN_PORT=0`.
 */
export const waitForListening = (
  path: string,
  options: WaitOptions
): Effect.Effect<
  number,
  EventsLogError | EventTimeout,
  FileSystem.FileSystem
> =>
  waitForSome(
    path,
    "listening",
    (event) =>
      event.event === "listening" ? numberField(event, "port") : Option.none(),
    options
  );

/** Milliseconds between two events, for the judges' reported timings. */
export const millisBetween = (from: BrainEvent, to: BrainEvent): number =>
  DateTime.toEpochMillis(to.at) - DateTime.toEpochMillis(from.at);
