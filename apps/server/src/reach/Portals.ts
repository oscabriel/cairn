// Portals (ADR 0038, docs/phase-2/notes/reach.md R5): a dev server served at
// `https://<name>.<domain>` through a porch of the same name, its process a transient systemd user
// unit (`PortalUnits`) so it outlives any brain restart. Cairn owns each portal through its
// `portals` row and moves it `opening` → `open` → `stopped` → `removed`.
//
// Opening is five steps, each safe to run again, so a rerun after a crash at any point finishes the
// same portal, keyed by its name, and the tool built on it is `replay: "safe"`:
//
// 1. claim the row `opening` with a port Cairn picked (the installed porch has no lease command;
//    the `portals_live_port` index keeps two live portals off one port, and a stopped portal's
//    port is never handed to another, since its porch still points there);
// 2. register the porch `<name>` → `http://127.0.0.1:<port>`, unless a rerun on the same port finds
//    it listed (each porch change reloads Caddy, cutting every portal's WebSockets). porch refuses
//    `exists` for a porch already there, whose upstream Cairn cannot read back, so that answer
//    re-registers it; a row that moves to a new port loses its old porch first;
// 3. start the unit `<prefix><id>`, unless it already runs;
// 4. probe the port until the server answers HTTP (on a timeout the row stays `opening`, for the
//    agent to retry or close, and the error carries the end of the unit's journal);
// 5. mark the row `open`.
//
// Every write that moves a row is conditional on the row as it was read (its state and
// `updated_at`), and a write that makes a portal live also on the limit, so a claim, a close and a
// sweep racing over one row never act on a stale copy: the loser reads again or leaves it. A judge
// brain plants a crash after any step of an open or a close through `PortalFaults`
// (`judges/reach-restart.sh`).
//
// A portal ends by `close` (the row `removed` first, then its unit stopped and porch removed, so a
// crash anywhere in between still ends removed), by its time-to-live (the unit's `RuntimeMaxSec`
// stops it even while the brain is down; the sweep marks the row `stopped`, `expired`), by its unit
// exiting (`stopped`, `exited`), or by its thread being archived or deleted (closed by the sweep).
// `stopped` keeps the porch, the port and the command, so the name shows porch's dark page and
// `start` runs the same portal again. An `opening` row left past the grace (above the longest
// readiness wait) is ended by the sweep unless its server answers. Settling a thread closes
// nothing. Six portals may be open at once; a seventh is refused naming the oldest.
//
// `reconcile` is the boot repair: rows whose unit is gone become `stopped` (`lost`), an `opening`
// row whose unit answers becomes `open`, an `opening` row left past the grace becomes `stopped`,
// units and porches with no row are stopped and removed, and a row whose porch went missing gets
// it back. Times are epoch milliseconds.

import path from "node:path";

import type { ThreadId } from "@cairn/protocol/Ids";
import {
  DEFAULT_PORTAL_TTL_HOURS,
  MAX_OPEN_PORTALS,
  PortalRow,
} from "@cairn/protocol/Reach";
import type { PortalId, PortalStopReason } from "@cairn/protocol/Reach";
import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Random,
  Schedule,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql";

import { threadProcessEnv } from "../brain/Arms.ts";
import { PorchClient } from "./PorchClient.ts";
import type { PorchError } from "./PorchClient.ts";
import { PortalUnits } from "./PortalUnits.ts";
import type { PortalUnitError } from "./PortalUnits.ts";

// ── Settings and faults ──────────────────────────────────────────────────────────────────────────

/** Where portals run on this brain. */
export interface PortalConfig {
  /** A portal's unit is `<unitPrefix><id>`; judges use their own prefix, so they never touch real units. */
  readonly unitPrefix: string;
  /** The loopback ports Cairn hands out, both ends included. */
  readonly firstPort: number;
  readonly lastPort: number;
  /** How long an `opening` row with no running unit is left for its tool to rerun. */
  readonly openingGrace: Duration.Duration;
  /** How often the sweep runs. */
  readonly sweepEvery: Duration.Duration;
  /** How often an opening portal's port is probed. */
  readonly probeEvery: Duration.Duration;
  /** The brain's variables a unit gets (PATH and the locale); the user manager supplies the rest. */
  readonly env: Readonly<Record<string, string>>;
}

/** The brain's variables a portal unit inherits: enough to find toolchains, nothing secret. */
const INHERITED = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;

/**
 * The longest a portal's server may take to answer (`portal_open`'s `readyTimeoutSec` bound). The
 * opening grace stays above it, so neither the sweep nor the boot repair ends a probe in flight.
 */
export const MAX_READY_TIMEOUT = Duration.minutes(2);

const DEFAULT_PORTAL_CONFIG: PortalConfig = {
  unitPrefix: "cairn-portal-",
  firstPort: 3100,
  lastPort: 3699,
  openingGrace: Duration.sum(MAX_READY_TIMEOUT, Duration.minutes(1)),
  sweepEvery: Duration.minutes(1),
  probeEvery: Duration.millis(250),
  env: {},
};

/**
 * Portal settings. Ports 3100 to 3699 sit clear of the hand-written dev table (3001 to 3032), the
 * brain's 3774 to 3777 and Executor's 4400 (reach note, "Machine setup"). Read once, when `Portals`
 * is built, so the composition root decides them for every caller. The default hands a unit no
 * variables of the brain's; a root gives them with `portalSettingsLayer`.
 */
export const PortalSettings = Context.Reference<PortalConfig>(
  "cairn/server/reach/PortalSettings",
  { defaultValue: () => DEFAULT_PORTAL_CONFIG }
);

/**
 * The default settings with the variables a unit inherits taken from `source`, the brain's
 * environment, which the composition root passes once (S11): PATH and the locale, never `CAIRN_*`.
 */
export const portalSettingsLayer = (
  source: Readonly<Record<string, string | undefined>>
) => {
  const allowed = threadProcessEnv(source);

  return Layer.succeed(PortalSettings, {
    ...DEFAULT_PORTAL_CONFIG,
    env: Object.fromEntries(
      INHERITED.flatMap((name) =>
        allowed[name] === undefined ? [] : [[name, allowed[name]]]
      )
    ),
  });
};

/**
 * The steps of opening a portal, in order, then those of closing one (`close-<step>`: the row
 * marked removed, the unit stopped, the porch removed); a fault names the step it crashes after.
 */
export const PortalStep = Schema.Literals([
  "row",
  "porch",
  "unit",
  "probe",
  "open",
  "close-row",
  "close-unit",
  "close-porch",
]);

export type PortalStep = typeof PortalStep.Type;

/** A hook that runs after each step of an open or a close; a judge brain kills itself there. */
export interface PortalFaultHooks {
  after(step: PortalStep): Effect.Effect<void>;
}

/**
 * No fault: production and dev never plant one. Judge brains set it from `CAIRN_JUDGE_FAULT`
 * (`portalFaultStep`). Read once, when `Portals` is built.
 */
export const PortalFaults = Context.Reference<PortalFaultHooks>(
  "cairn/server/reach/PortalFaults",
  { defaultValue: () => ({ after: () => Effect.void }) }
);

const decodeStep = Schema.decodeUnknownOption(PortalStep);

/**
 * The step a judge brain's `CAIRN_JUDGE_FAULT` names, `portal:after-<step>` (such as
 * `portal:after-unit` or `portal:after-close-row`); none for any other value, which belongs to
 * another fault family.
 */
export const portalFaultStep = (spec: string): Option.Option<PortalStep> =>
  spec.startsWith("portal:after-")
    ? decodeStep(spec.slice("portal:after-".length))
    : Option.none();

/**
 * A judge brain's faults (`judges/reach-restart.sh`): for `spec` a `portal:after-<step>`, the
 * brain kills itself with SIGKILL right after that step of an open or a close, as a `kill -9` there would,
 * once per `marker` file, so the life systemd restarts runs clean. Any other `spec` plants none.
 * Judge brains only: production and dev roots never provide it.
 */
export const judgePortalFaults = (spec: string, marker: string) =>
  Layer.effect(
    PortalFaults,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      return Option.match(portalFaultStep(spec), {
        onNone: (): PortalFaultHooks => ({ after: () => Effect.void }),
        onSome: (target): PortalFaultHooks => ({
          after: (step) =>
            Effect.gen(function* () {
              if (
                step !== target ||
                (yield* fs
                  .exists(marker)
                  .pipe(Effect.orElseSucceed(() => true)))
              ) {
                return;
              }

              // Without its marker the fault would fire again in every life systemd restarts, a crash
              // loop; a marker that cannot be written plants nothing.
              const written = yield* fs.writeFileString(marker, step).pipe(
                Effect.as(true),
                Effect.catchTag("PlatformError", (cause) =>
                  Effect.logError("judge fault marker not written").pipe(
                    Effect.annotateLogs({
                      event: "judge_fault_skipped",
                      fault: spec,
                      marker,
                      cause: cause.message,
                    }),
                    Effect.as(false)
                  )
                )
              );

              if (!written) {
                return;
              }

              yield* Effect.logWarning("judge fault fired").pipe(
                Effect.annotateLogs({ event: "judge_fault", fault: spec })
              );
              yield* Effect.sync(() => {
                process.kill(process.pid, "SIGKILL");
              });
            }),
        }),
      });
    })
  );

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Why a portal could not be opened, started, closed or read. `taken`: another thread's portal
 * holds the name. `limit`: six are open. `not-ready`: the server did not answer in time or its
 * process exited (the row stays `opening`). `no-port`: every port in the range is held.
 * `not-found`: no such portal. `removed`: the portal was closed for good. `unit`: systemd refused.
 * `store`: `cairn.sqlite` failed. `bad-input`: a name, folder, command or lifetime Cairn refuses.
 */
export const PortalErrorReason = Schema.Literals([
  "taken",
  "limit",
  "not-ready",
  "no-port",
  "not-found",
  "removed",
  "unit",
  "store",
  "bad-input",
]);

export type PortalErrorReason = typeof PortalErrorReason.Type;

/** A portal operation was refused or failed; `porch` failures stay `PorchError`. */
export class PortalError extends Schema.TaggedError<PortalError>()(
  "PortalError",
  {
    message: Schema.String,
    /** `open`, `start`, `close`, `list`, `reconcile` or `sweep`. */
    operation: Schema.String,
    reason: PortalErrorReason,
    /** The portal's name or id, as the caller gave it. */
    portal: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** A portal error; a store failure and a server that has not answered yet may be retried. */
const fail = (
  operation: string,
  reason: PortalErrorReason,
  portal: string,
  message: string,
  cause: Option.Option<unknown> = Option.none()
) =>
  new PortalError({
    message,
    operation,
    reason,
    portal,
    retryable: reason === "store" || reason === "not-ready",
    cause: Option.getOrUndefined(cause),
  });

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────

const StoredPortal = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  // Inside Cairn a port is an Option from here on (S22): a host row without one is refused where
  // it is used (`portOf`), never read as port 0.
  port: Schema.OptionFromNullOr(Schema.Int),
  command: Schema.String,
  cwd: Schema.String,
  state: Schema.Literals(["opening", "open", "stopped", "removed"]),
  arms: Schema.Literals(["host", "stone"]),
  unit: Schema.String,
  ttl_hours: Schema.Int,
  opened_at: Schema.Int,
  expires_at: Schema.Int,
  stopped_at: Schema.NullOr(Schema.Int),
  stop_reason: Schema.NullOr(
    Schema.Literals(["closed", "expired", "exited", "lost"])
  ),
  updated_at: Schema.Int,
});

type StoredPortal = typeof StoredPortal.Type;

const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredPortal));

const decodeRow = Schema.decodeUnknownEffect(Schema.toType(PortalRow));

const at = (millis: number) => DateTime.makeUnsafe(millis);

const rowOf = (stored: StoredPortal) =>
  decodeRow({
    id: stored.id,
    threadId: stored.thread_id,
    name: stored.name,
    url: stored.url,
    port: stored.port,
    command: stored.command,
    cwd: stored.cwd,
    state: stored.state,
    arms: stored.arms,
    ttlHours: stored.ttl_hours,
    openedAt: at(stored.opened_at),
    expiresAt: at(stored.expires_at),
    stoppedAt: Option.map(Option.fromNullOr(stored.stopped_at), at),
    stopReason: Option.fromNullOr(stored.stop_reason),
  });

// ── Names ────────────────────────────────────────────────────────────────────────────────────────

/** The longest part on either side of a portal name's `--`. */
const PART_CHARS = 30;

/** `text` as one DNS label part: lowercase letters, digits and single dashes, at most 30 long. */
const slugOf = (text: string, fallback: string) => {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, PART_CHARS)
    .replaceAll(/-+$/gu, "");

  return slug === "" ? fallback : slug;
};

/**
 * A portal's name, `<label>--<project>`: one DNS label, so the wildcard certificate covers it, and
 * always holding `--`, the mark the owner-only guard matches and no hand-written route has. The
 * label is the branch (or a name the agent chose), the project the repository's folder name.
 */
export const portalName = (label: string, project: string) =>
  `${slugOf(label, "main")}--${slugOf(project, "project")}`;

/** A portal name as `portalName` makes them. */
const PORTAL_NAME =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?--[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

/** Whether `name` is a portal name: one DNS label of at most 63 characters, holding `--`. */
export const isPortalName = (name: string) =>
  name.length <= 63 && PORTAL_NAME.test(name);

/** The longest command a portal keeps (the row's `DisplayText`). */
const COMMAND_CHARS = 4096;

/** The longest a portal may live (the row's bound). */
const MAX_TTL_HOURS = 72;

/** How many journal lines a `not-ready` error carries. */
const JOURNAL_LINES = 40;

/** How many times a claim retries after another claim took its port at the same moment. */
const CLAIM_ATTEMPTS = 4;

/** A `cairn.sqlite` failure during `operation`. */
const storeFailure =
  (operation: string, portal: string) =>
  (cause: SqlError.SqlError | Schema.SchemaError) =>
    fail(
      operation,
      "store",
      portal,
      `Portals could not read or write the portals row for ${portal} during ${operation}: ${cause.message}. Nothing else changed; retry.`,
      Option.some(cause)
    );

/** A systemd failure during `operation`. */
const unitFailure =
  (operation: string, portal: string) => (cause: PortalUnitError) =>
    fail(
      operation,
      "unit",
      portal,
      `${cause.message} (portal ${portal}, ${operation}).`,
      Option.some(cause)
    );

/** Why `input` cannot be opened, before anything runs. */
const refuseInput = (input: OpenInput) => {
  const refuse = (message: string) =>
    Effect.fail(fail("open", "bad-input", input.name, message));

  if (!isPortalName(input.name)) {
    return refuse(
      `${input.name} is not a portal name: one DNS label of lowercase letters, digits and dashes, at most 63 characters, holding "--".`
    );
  }

  if (!path.isAbsolute(input.cwd)) {
    return refuse(`The folder ${input.cwd} is not an absolute path.`);
  }

  if (input.command.trim() === "" || input.command.length > COMMAND_CHARS) {
    return refuse(
      `A portal's command must be 1 to ${String(COMMAND_CHARS)} characters.`
    );
  }

  if (
    !Number.isInteger(input.ttlHours) ||
    input.ttlHours < 1 ||
    input.ttlHours > MAX_TTL_HOURS
  ) {
    return refuse(
      `A portal lives 1 to ${String(MAX_TTL_HOURS)} whole hours (default ${String(DEFAULT_PORTAL_TTL_HOURS)}); ${String(input.ttlHours)} is not one.`
    );
  }

  return Effect.void;
};

/** Runs a SELECT and decodes its rows. */
const query = (
  operation: string,
  portal: string,
  statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>
) =>
  statement.pipe(
    Effect.flatMap(decodeStored),
    Effect.mapError(storeFailure(operation, portal))
  );

/** Runs a write. */
const write = (
  operation: string,
  portal: string,
  statement: Effect.Effect<unknown, SqlError.SqlError>
) =>
  statement.pipe(
    Effect.asVoid,
    Effect.mapError(storeFailure(operation, portal))
  );

/**
 * Runs a conditional write ending `RETURNING id`; answers whether it changed a row. A write whose
 * condition no longer holds (another writer moved the row first), or that a unique index refused,
 * changed nothing.
 */
const writeIf = (
  operation: string,
  portal: string,
  statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>
) =>
  statement.pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.catchTag("SqlError", (cause) =>
      Predicate.isTagged(cause.reason, "UniqueViolation")
        ? Effect.succeed(false)
        : Effect.fail(storeFailure(operation, portal)(cause))
    )
  );

/** A host row's port; a row without one is refused rather than served on port 0. */
const portOf = (operation: string, stored: StoredPortal) =>
  Effect.fromOption(stored.port).pipe(
    Effect.mapError(() =>
      fail(
        operation,
        "store",
        stored.name,
        `The portals row of ${stored.name} holds no port, which a host portal must. Close it and open it again.`
      )
    )
  );

/** The protocol row of a stored row. */
const toRow = (operation: string, stored: StoredPortal) =>
  rowOf(stored).pipe(Effect.mapError(storeFailure(operation, stored.name)));

// ── The service ──────────────────────────────────────────────────────────────────────────────────

/** What to open: a dev server for a thread, under a portal name. */
export interface OpenInput {
  readonly threadId: ThreadId;
  /** A portal name (`portalName`). */
  readonly name: string;
  /** The dev server's command, run by `/bin/sh -c` with `PORT` and `HOST` set. */
  readonly command: string;
  /** An absolute folder the command runs in. */
  readonly cwd: string;
  readonly ttlHours: number;
  /** The path the readiness probe asks for. */
  readonly readyPath: string;
  /** How long the server has to answer. */
  readonly readyTimeout: Duration.Duration;
}

/** What `start` uses when it runs a stopped portal again. */
export const DEFAULT_READY_TIMEOUT = Duration.seconds(60);

/** What a boot reconcile or a sweep changed, for its log line. */
export interface PortalRepairReport {
  readonly opened: number;
  readonly stopped: number;
  readonly closed: number;
  readonly unitsStopped: number;
  readonly porchesRemoved: number;
  /** Porches put back in front of a row that had lost its own. */
  readonly porchesRestored: number;
}

const NO_REPAIRS: PortalRepairReport = {
  opened: 0,
  stopped: 0,
  closed: 0,
  unitsStopped: 0,
  porchesRemoved: 0,
  porchesRestored: 0,
};

type PortalFailure = PortalError | PorchError;

/** Opens, starts, closes, lists and reconciles portals (ADR 0038). */
export class Portals extends Context.Service<
  Portals,
  {
    /**
     * Opens `input.name` for its thread, or finishes or restarts that thread's portal of the name:
     * the same name again is the same portal. Fails `taken`, `limit`, `no-port`, `not-ready`
     * (the row stays `opening`), `unit`, `store` or `bad-input`, or with porch's `PorchError`.
     */
    open(input: OpenInput): Effect.Effect<PortalRow, PortalFailure>;
    /** Runs a stopped (or failed) portal again with its own command. Fails `not-found`, `removed`, or as `open`. */
    start(portalId: PortalId): Effect.Effect<PortalRow, PortalFailure>;
    /** Stops the unit, removes the porch, marks the row `removed`. Idempotent; fails `not-found`. */
    close(portalId: PortalId): Effect.Effect<PortalRow, PortalFailure>;
    /** A thread's portals, or every thread's, without removed ones, newest first. */
    list(
      threadId: Option.Option<ThreadId>
    ): Effect.Effect<ReadonlyArray<PortalRow>, PortalError>;
    /** The boot repair: rows, units and porches made to agree. */
    readonly reconcile: Effect.Effect<PortalRepairReport, PortalFailure>;
    /** One sweep: lifetimes, exited units, archived threads. */
    readonly sweep: Effect.Effect<PortalRepairReport, PortalFailure>;
    /** Starts the periodic sweep; idempotent. */
    readonly startSweeper: Effect.Effect<void>;
    /** Stops it; units keep running, so pages keep answering while the brain is down. */
    readonly stopSweeper: Effect.Effect<void>;
  }
>()("cairn/server/reach/Portals") {
  /** Over the ambient `PorchClient`, `PortalUnits` and `SqlClient`. */
  static readonly layerNoDeps = Layer.effect(
    Portals,
    Effect.gen(function* () {
      const porch = yield* PorchClient;
      const units = yield* PortalUnits;
      const sql = yield* SqlClient.SqlClient;
      // Fixed by the composition root when the layer is built, never read per call: a call runs on
      // whatever fiber made it (a tool, an RPC), which need not carry the root's settings.
      const settings = yield* PortalSettings;
      const faults = yield* PortalFaults;
      const sweeper = yield* FiberSet.make();
      let sweeping = false;

      /** Removes a porch; one already gone is fine. */
      const removePorch = (name: string) =>
        porch.remove(name).pipe(
          Effect.asVoid,
          Effect.catchTag("PorchError", (failure) =>
            failure.reason === "missing" ? Effect.void : Effect.fail(failure)
          )
        );

      const byId = (operation: string, id: string) =>
        Effect.map(
          query(operation, id, sql`SELECT * FROM portals WHERE id = ${id}`),
          (rows) => Option.fromUndefinedOr(rows[0])
        );

      const liveByName = (operation: string, name: string) =>
        Effect.map(
          query(
            operation,
            name,
            sql`SELECT * FROM portals WHERE name = ${name} AND state <> 'removed'`
          ),
          (rows) => Option.fromUndefinedOr(rows[0])
        );

      const mustGet = (operation: string, id: string) =>
        Effect.gen(function* () {
          const found = yield* byId(operation, id);

          if (Option.isNone(found)) {
            return yield* fail(
              operation,
              "store",
              id,
              `The portals row ${id} vanished during ${operation}. Retry.`
            );
          }

          return found.value;
        });

      /**
       * Ports other portals hold, `except`'s aside: a live one's, and a stopped one's too, since
       * its porch still points there for the dark page. Only a removed portal gives its port back.
       */
      const heldPorts = (operation: string, except: string) =>
        Effect.map(
          query(
            operation,
            except,
            sql`SELECT * FROM portals WHERE state <> 'removed' AND port IS NOT NULL AND id <> ${except}`
          ),
          (rows) => new Set(rows.flatMap((row) => Option.toArray(row.port)))
        );

      /** A free port: `preferred` when it still is, else the first in the range. */
      const pickPort = Effect.fnUntraced(function* (
        operation: string,
        portal: string,
        except: string,
        preferred: Option.Option<number>
      ) {
        const held = yield* heldPorts(operation, except);
        const candidates: Array<number> = Option.toArray(preferred);

        for (
          let port = settings.firstPort;
          port <= settings.lastPort;
          port += 1
        ) {
          candidates.push(port);
        }

        for (const port of candidates) {
          if (!held.has(port) && (yield* units.portFree(port))) {
            return port;
          }
        }

        return yield* fail(
          operation,
          "no-port",
          portal,
          `Every port from ${String(settings.firstPort)} to ${String(settings.lastPort)} is held, so ${portal} has none. Close a portal or stop what holds those ports, then retry.`
        );
      });

      /** Live portals other than `except`, oldest first; a seventh is refused naming the oldest. */
      const refuseOverLimit = Effect.fnUntraced(function* (
        operation: string,
        portal: string,
        except: string
      ) {
        const live = yield* query(
          operation,
          portal,
          sql`SELECT * FROM portals WHERE state IN ('opening', 'open') AND id <> ${except} ORDER BY opened_at ASC`
        );

        const [oldest] = live;

        if (live.length >= MAX_OPEN_PORTALS && oldest !== undefined) {
          return yield* fail(
            operation,
            "limit",
            portal,
            `${String(MAX_OPEN_PORTALS)} portals are already open, the most this brain keeps. Close one first; the oldest is ${oldest.name} (${oldest.url}).`
          );
        }

        return yield* Effect.void;
      });

      /** Mints a portal id: 16 hex digits, so a unit name stays one systemd word. */
      const mintId = Effect.gen(function* () {
        const high = yield* Random.nextIntBetween(0, 0xff_ff_ff_ff);
        const low = yield* Random.nextIntBetween(0, 0xff_ff_ff_ff);

        return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
      });

      /** The live-portal count a claim's write compares against the limit, `except`'s row aside. */
      const liveCount = (except: string) =>
        sql`(SELECT COUNT(*) FROM portals WHERE state IN ('opening', 'open') AND id <> ${except})`;

      /**
       * Step 1: the row this open runs on, `opening`, holding a port. A live row of the name from
       * this thread is reused: `open` and still running is returned as done; `opening` continues;
       * `stopped`, or `open` with its unit gone, is restarted with the new command. Every write is
       * conditional on the row as read (and a write that makes a portal live, on the limit), so a
       * claim that loses a race to another claim, a close or a sweep reads again. `samePort` says
       * the row's porch, if it has one, already points at its port.
       */
      const claim = Effect.fnUntraced(function* (
        input: OpenInput,
        url: string
      ): Effect.fn.Return<
        {
          readonly stored: StoredPortal;
          readonly done: boolean;
          readonly samePort: boolean;
        },
        PortalFailure
      > {
        for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
          const held = yield* liveByName("open", input.name);
          const now = yield* Clock.currentTimeMillis;
          const expiresAt = now + input.ttlHours * 3_600_000;

          if (Option.isSome(held)) {
            const row = held.value;

            if (row.thread_id !== input.threadId) {
              return yield* fail(
                "open",
                "taken",
                input.name,
                `Another thread's portal is named ${input.name}. Pick another name, or close that portal first.`
              );
            }

            if (
              row.state === "opening" &&
              row.command === input.command &&
              row.cwd === input.cwd
            ) {
              // A rerun of the same open (after a crash, or a server that answered late). Its
              // grace starts again, so no sweep ends the probe this rerun is about to run.
              const renewed = yield* writeIf(
                "open",
                input.name,
                sql`
                  UPDATE portals SET updated_at = ${now}
                  WHERE id = ${row.id} AND state = 'opening' AND updated_at = ${row.updated_at}
                  RETURNING id
                `
              );

              if (renewed) {
                return {
                  stored: yield* mustGet("open", row.id),
                  done: false,
                  samePort: true,
                };
              }

              continue;
            }

            if (row.state === "opening") {
              // The agent fixed its command after `not-ready`: the row keeps its port and
              // lifetime but runs the new command, and the old process goes once the row says so.
              const changed = yield* writeIf(
                "open",
                input.name,
                sql`
                  UPDATE portals SET command = ${input.command}, cwd = ${input.cwd},
                    updated_at = ${now}
                  WHERE id = ${row.id} AND state = 'opening' AND updated_at = ${row.updated_at}
                  RETURNING id
                `
              );

              if (!changed) {
                continue;
              }

              yield* units
                .stop(row.unit)
                .pipe(Effect.mapError(unitFailure("open", input.name)));

              return {
                stored: yield* mustGet("open", row.id),
                done: false,
                samePort: true,
              };
            }

            if (
              row.state === "open" &&
              (yield* units
                .isActive(row.unit)
                .pipe(Effect.mapError(unitFailure("open", input.name))))
            ) {
              return { stored: row, done: true, samePort: true };
            }

            // Stopped, or open with its process gone: run it again, on its old port if still free.
            yield* refuseOverLimit("open", input.name, row.id);

            const port = yield* pickPort("open", input.name, row.id, row.port);

            // On a new port the old porch points at the wrong place: it goes before the row moves,
            // so a porch that lists the name always points at its row's port (a kill in between
            // leaves a row without its porch, which the boot repair puts back).
            if (!Option.contains(row.port, port)) {
              yield* removePorch(row.name);
            }

            const restarted = yield* writeIf(
              "open",
              input.name,
              sql`
                UPDATE portals SET
                  state = 'opening', port = ${port}, command = ${input.command}, cwd = ${input.cwd},
                  ttl_hours = ${input.ttlHours}, opened_at = ${now}, expires_at = ${expiresAt},
                  stopped_at = NULL, stop_reason = NULL, updated_at = ${now}
                WHERE id = ${row.id} AND state = ${row.state} AND updated_at = ${row.updated_at}
                  AND ${liveCount(row.id)} < ${MAX_OPEN_PORTALS}
                RETURNING id
              `
            );

            if (restarted) {
              return {
                stored: yield* mustGet("open", row.id),
                done: false,
                samePort: Option.contains(row.port, port),
              };
            }

            continue;
          }

          yield* refuseOverLimit("open", input.name, "");

          const id = yield* mintId;
          const port = yield* pickPort("open", input.name, id, Option.none());

          // The limit is part of the write, so two opens at once cannot make a seventh.
          const inserted = yield* writeIf(
            "open",
            input.name,
            sql`
              INSERT INTO portals (
                id, thread_id, name, url, port, command, cwd, state, arms, unit, ttl_hours,
                opened_at, expires_at, updated_at
              )
              SELECT
                ${id}, ${input.threadId}, ${input.name}, ${url}, ${port}, ${input.command},
                ${input.cwd}, 'opening', 'host', ${`${settings.unitPrefix}${id}`},
                ${input.ttlHours}, ${now}, ${expiresAt}, ${now}
              WHERE ${liveCount("")} < ${MAX_OPEN_PORTALS}
              RETURNING id
            `
          );

          if (inserted) {
            return {
              stored: yield* mustGet("open", id),
              done: false,
              samePort: false,
            };
          }
        }

        // Another claim took the name or the port each time: say so rather than loop.
        return yield* fail(
          "open",
          "store",
          input.name,
          `Opening ${input.name} lost the race for a name or port ${String(CLAIM_ATTEMPTS)} times. Retry.`
        );
      });

      /** Step 2: the porch in front of the row's port. */
      const register = Effect.fnUntraced(function* (
        operation: string,
        stored: StoredPortal
      ) {
        const upstream = `http://127.0.0.1:${String(yield* portOf(operation, stored))}`;

        yield* porch.add(stored.name, upstream).pipe(
          // Registered before (a rerun, or a stopped portal's porch): its upstream may be an older
          // port, which porch cannot report, so `exists` puts it back with this one.
          Effect.catchTag("PorchError", (failure) =>
            failure.reason === "exists"
              ? porch.remove(stored.name).pipe(
                  Effect.catchTag("PorchError", (removal) =>
                    removal.reason === "missing"
                      ? Effect.void
                      : Effect.fail(removal)
                  ),
                  Effect.andThen(porch.add(stored.name, upstream))
                )
              : Effect.fail(failure)
          )
        );
      });

      /** Step 3: the unit, unless it already runs. */
      const launch = Effect.fnUntraced(function* (
        stored: StoredPortal,
        domain: string
      ) {
        const toUnit = unitFailure("open", stored.name);

        if (yield* units.isActive(stored.unit).pipe(Effect.mapError(toUnit))) {
          return;
        }

        const host = `${stored.name}.${domain}`;
        const port = yield* portOf("open", stored);

        yield* units
          .start({
            unit: stored.unit,
            cwd: stored.cwd,
            command: stored.command,
            env: {
              ...settings.env,
              PORT: String(port),
              HOST: "127.0.0.1",
              PORCH_HOST: host,
              PORCH_URL: stored.url,
              __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: host,
            },
            lifetime: Duration.millis(
              Math.max(
                1000,
                stored.expires_at - (yield* Clock.currentTimeMillis)
              )
            ),
          })
          .pipe(Effect.mapError(toUnit));
      });

      /** Step 4: waits for the server to answer, or for its process to exit. */
      const awaitReady = Effect.fnUntraced(function* (
        stored: StoredPortal,
        readyPath: string,
        timeout: Duration.Duration
      ) {
        const port = yield* portOf("open", stored);

        const deadline =
          (yield* Clock.currentTimeMillis) + Duration.toMillis(timeout);

        const notReady = (why: string) =>
          Effect.gen(function* () {
            const journal = yield* units.journal(stored.unit, JOURNAL_LINES);

            return yield* fail(
              "open",
              "not-ready",
              stored.name,
              `The portal ${stored.name} ${why}, so it is not open. Its row stays opening: fix the command and open it again, or close it. The unit's last lines:\n${journal === "" ? "(none)" : journal}`
            );
          });

        for (;;) {
          if (yield* units.answers(port, readyPath)) {
            return yield* Effect.void;
          }

          const running = yield* units
            .isActive(stored.unit)
            .pipe(Effect.mapError(unitFailure("open", stored.name)));

          if (!running) {
            return yield* notReady(
              `exited before it answered on port ${String(port)}`
            );
          }

          if ((yield* Clock.currentTimeMillis) >= deadline) {
            return yield* notReady(
              `did not answer on port ${String(port)} within ${Duration.format(timeout)}`
            );
          }

          yield* Effect.sleep(settings.probeEvery);
        }
      });

      const open = Effect.fn("Portals.open")(function* (input: OpenInput) {
        yield* Effect.annotateCurrentSpan({ portal: input.name });
        yield* refuseInput(input);

        const machine = yield* porch.machine;
        const url = `https://${input.name}.${machine.domain}`;

        const claimed = yield* claim(input, url);

        if (claimed.done) {
          return yield* toRow("open", claimed.stored);
        }

        const { stored } = claimed;

        yield* faults.after("row");

        // Each porch add or remove reloads Caddy, which cuts every portal's WebSockets: a rerun on
        // the same port whose porch is there already leaves it be.
        const porched =
          claimed.samePort &&
          (yield* porch.list).some((row) => row.name === stored.name);

        if (!porched) {
          yield* register("open", stored);
        }

        yield* faults.after("porch");
        yield* launch(stored, machine.domain);
        yield* faults.after("unit");
        yield* awaitReady(stored, input.readyPath, input.readyTimeout);
        yield* faults.after("probe");

        const now = yield* Clock.currentTimeMillis;

        yield* write(
          "open",
          input.name,
          sql`UPDATE portals SET state = 'open', updated_at = ${now} WHERE id = ${stored.id} AND state = 'opening'`
        );

        const opened = yield* mustGet("open", stored.id);

        if (opened.state !== "open") {
          // Its unit may have started after the close or sweep stopped the old one: it goes too.
          yield* units
            .stop(opened.unit)
            .pipe(Effect.mapError(unitFailure("open", input.name)));

          return yield* fail(
            "open",
            "not-ready",
            input.name,
            `The portal ${input.name} was ${opened.state} by a close or a sweep while it opened. Open it again.`
          );
        }

        yield* faults.after("open");

        yield* Effect.logInfo("portal open").pipe(
          Effect.annotateLogs({
            event: "portal_open",
            portal: opened.id,
            name: opened.name,
            port: Option.getOrNull(opened.port),
          })
        );

        return yield* toRow("open", opened);
      });

      const start = Effect.fn("Portals.start")(function* (portalId: PortalId) {
        const found = yield* byId("start", portalId);

        if (Option.isNone(found)) {
          return yield* fail(
            "start",
            "not-found",
            portalId,
            `No portal ${portalId}. Open a new one.`
          );
        }

        const row = found.value;

        if (row.state === "removed") {
          return yield* fail(
            "start",
            "removed",
            portalId,
            `The portal ${row.name} was closed for good. Open a new one.`
          );
        }

        return yield* open({
          threadId: (yield* toRow("start", row)).threadId,
          name: row.name,
          command: row.command,
          cwd: row.cwd,
          ttlHours: row.ttl_hours,
          readyPath: "/",
          readyTimeout: DEFAULT_READY_TIMEOUT,
        });
      });

      /**
       * Marks a live row `stopped` with `reason`, only if it is still the row the caller read (same
       * state, same `updated_at`): a claim that restarted or renewed it since wins. Answers whether
       * it changed the row; a caller stops the unit only then.
       */
      const markStopped = (
        operation: string,
        stored: StoredPortal,
        reason: PortalStopReason
      ) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          const changed = yield* writeIf(
            operation,
            stored.name,
            sql`
              UPDATE portals SET state = 'stopped', stopped_at = ${now}, stop_reason = ${reason},
                updated_at = ${now}
              WHERE id = ${stored.id} AND state = ${stored.state}
                AND updated_at = ${stored.updated_at}
              RETURNING id
            `
          );

          if (changed) {
            yield* Effect.logInfo("portal stopped").pipe(
              Effect.annotateLogs({
                event: "portal_stopped",
                portal: stored.id,
                name: stored.name,
                reason,
              })
            );
          }

          return changed;
        });

      /** Marks an `opening` row `open`, only if it is still the row the caller read. */
      const markOpen = (operation: string, stored: StoredPortal) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          return yield* writeIf(
            operation,
            stored.name,
            sql`
              UPDATE portals SET state = 'open', updated_at = ${now}
              WHERE id = ${stored.id} AND state = 'opening' AND updated_at = ${stored.updated_at}
              RETURNING id
            `
          );
        });

      /**
       * Closes a portal: the row is marked `removed` first, then the unit is stopped and the porch
       * removed, so a crash anywhere in between ends removed (the boot repair stops units and
       * removes portal porches no live row names) and never comes back as a stopped portal. Run
       * again on a removed row, it finishes what a crash left; a porch whose name a newer portal
       * holds is that portal's and stays.
       */
      const closeStored = (operation: string, stored: StoredPortal) =>
        Effect.gen(function* () {
          if (stored.state !== "removed") {
            const now = yield* Clock.currentTimeMillis;

            yield* write(
              operation,
              stored.name,
              sql`
                UPDATE portals SET state = 'removed', stopped_at = COALESCE(stopped_at, ${now}),
                  stop_reason = 'closed', updated_at = ${now}
                WHERE id = ${stored.id} AND state <> 'removed'
              `
            );
          }

          yield* faults.after("close-row");
          yield* units
            .stop(stored.unit)
            .pipe(Effect.mapError(unitFailure(operation, stored.name)));
          yield* faults.after("close-unit");

          if (Option.isNone(yield* liveByName(operation, stored.name))) {
            yield* removePorch(stored.name);
          }

          yield* faults.after("close-porch");

          if (stored.state !== "removed") {
            yield* Effect.logInfo("portal closed").pipe(
              Effect.annotateLogs({
                event: "portal_closed",
                portal: stored.id,
                name: stored.name,
              })
            );
          }

          return yield* toRow(operation, yield* mustGet(operation, stored.id));
        });

      const close = Effect.fn("Portals.close")(function* (portalId: PortalId) {
        const found = yield* byId("close", portalId);

        if (Option.isNone(found)) {
          return yield* fail(
            "close",
            "not-found",
            portalId,
            `No portal ${portalId}; nothing to close.`
          );
        }

        return yield* closeStored("close", found.value);
      });

      const list = Effect.fn("Portals.list")(function* (
        threadId: Option.Option<ThreadId>
      ) {
        const stored = yield* Option.match(threadId, {
          onNone: () =>
            query(
              "list",
              "*",
              sql`SELECT * FROM portals WHERE state <> 'removed' ORDER BY opened_at DESC`
            ),
          onSome: (thread) =>
            query(
              "list",
              thread,
              sql`SELECT * FROM portals WHERE thread_id = ${thread} AND state <> 'removed' ORDER BY opened_at DESC`
            ),
        });

        return yield* Effect.forEach(stored, (row) => toRow("list", row));
      });

      /** Whether a row's server answers on its port; a row without one does not. */
      const answersOn = (row: StoredPortal) =>
        Option.match(row.port, {
          onNone: () => Effect.succeed(false),
          onSome: (port) => units.answers(port, "/"),
        });

      const liveRows = (operation: string) =>
        query(
          operation,
          "*",
          sql`SELECT * FROM portals WHERE state IN ('opening', 'open') ORDER BY opened_at ASC`
        );

      const reconcile = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const grace = Duration.toMillis(settings.openingGrace);
        let opened = 0;
        let stopped = 0;

        for (const row of yield* liveRows("reconcile")) {
          const toUnit = unitFailure("reconcile", row.name);

          const active = yield* units
            .isActive(row.unit)
            .pipe(Effect.mapError(toUnit));

          const pastGrace = row.updated_at + grace <= now;

          // Each change is made only if the row is still as read; its unit is stopped only then.
          if (row.expires_at <= now) {
            if (yield* markStopped("reconcile", row, "expired")) {
              yield* units.stop(row.unit).pipe(Effect.mapError(toUnit));
              stopped += 1;
            }
          } else if (row.state === "open") {
            if (!active && (yield* markStopped("reconcile", row, "lost"))) {
              stopped += 1;
            }
          } else if (active && (yield* answersOn(row))) {
            if (yield* markOpen("reconcile", row)) {
              opened += 1;
            }
          } else if (
            pastGrace &&
            (yield* markStopped("reconcile", row, "lost"))
          ) {
            yield* units.stop(row.unit).pipe(Effect.mapError(toUnit));
            stopped += 1;
          }
        }

        // A unit is kept only while its row is live; any other is stopped.
        const live = new Set(
          (yield* liveRows("reconcile")).map((row) => row.unit)
        );

        const strays = (yield* units
          .list(settings.unitPrefix)
          .pipe(
            Effect.mapError(unitFailure("reconcile", settings.unitPrefix))
          )).filter((unit) => !live.has(unit));

        for (const unit of strays) {
          yield* units
            .stop(unit)
            .pipe(Effect.mapError(unitFailure("reconcile", unit)));
        }

        // A portal porch (a service porch whose name holds `--`) is kept while any row holds the
        // name; `stopped` keeps it on purpose, for the dark page. A row whose porch is missing (a
        // kill between `register`'s remove and add) gets it back, so its name never falls to the
        // catch-all 404.
        const kept = yield* query(
          "reconcile",
          "*",
          sql`SELECT * FROM portals WHERE state <> 'removed'`
        );

        const named = new Set(kept.map((row) => row.name));
        const registered = yield* porch.list;
        const present = new Set(registered.map((row) => row.name));

        const porches = registered.filter(
          (row) =>
            row.kind === "service" &&
            isPortalName(row.name) &&
            !named.has(row.name)
        );

        for (const row of porches) {
          yield* removePorch(row.name);
        }

        const unporched = kept.filter(
          (row) => Option.isSome(row.port) && !present.has(row.name)
        );

        for (const row of unporched) {
          yield* register("reconcile", row);
        }

        const report: PortalRepairReport = {
          ...NO_REPAIRS,
          opened,
          stopped,
          unitsStopped: strays.length,
          porchesRemoved: porches.length,
          porchesRestored: unporched.length,
        };

        yield* Effect.logInfo("portals reconciled").pipe(
          Effect.annotateLogs({ event: "portal_reconcile", ...report })
        );

        return report;
      }).pipe(Effect.withSpan("Portals.reconcile"));

      const sweep = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const grace = Duration.toMillis(settings.openingGrace);
        let opened = 0;
        let stopped = 0;

        for (const row of yield* liveRows("sweep")) {
          const toUnit = unitFailure("sweep", row.name);

          // Each change is made only if the row is still as read (a claim may have restarted or
          // renewed it since), and a unit is stopped only after its row's change took effect.
          if (row.expires_at <= now) {
            if (yield* markStopped("sweep", row, "expired")) {
              yield* units.stop(row.unit).pipe(Effect.mapError(toUnit));
              stopped += 1;
            }

            continue;
          }

          // An `opening` row inside its grace may have a probe in flight: left to its open.
          if (row.state === "opening" && row.updated_at + grace > now) {
            continue;
          }

          const active = yield* units
            .isActive(row.unit)
            .pipe(Effect.mapError(toUnit));

          if (!active) {
            if (yield* markStopped("sweep", row, "exited")) {
              stopped += 1;
            }
          } else if (row.state === "opening") {
            // Past the grace, as the boot repair does: open if its server answers, else ended, so
            // a server that never answers does not hold a slot until its lifetime.
            if (yield* answersOn(row)) {
              if (yield* markOpen("sweep", row)) {
                opened += 1;
              }
            } else if (yield* markStopped("sweep", row, "lost")) {
              yield* units.stop(row.unit).pipe(Effect.mapError(toUnit));
              stopped += 1;
            }
          }
        }

        // Archiving or deleting a thread closes its portals.
        const orphaned = yield* query(
          "sweep",
          "*",
          sql`
            SELECT portals.* FROM portals JOIN threads ON threads.id = portals.thread_id
            WHERE portals.state <> 'removed'
              AND (threads.archived_at IS NOT NULL OR threads.deleted_at IS NOT NULL)
          `
        );

        for (const row of orphaned) {
          yield* closeStored("sweep", row);
        }

        return { ...NO_REPAIRS, opened, stopped, closed: orphaned.length };
      }).pipe(Effect.withSpan("Portals.sweep"));

      const sweepLogged = sweep.pipe(
        Effect.tap((report) =>
          report.opened + report.stopped + report.closed === 0
            ? Effect.void
            : Effect.logInfo("portals swept").pipe(
                Effect.annotateLogs({ event: "portal_sweep", ...report })
              )
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("portal sweep failed").pipe(
            Effect.annotateLogs({
              event: "portal_sweep_failed",
              cause: String(cause),
            })
          )
        )
      );

      const startSweeper = Effect.gen(function* () {
        if (sweeping) {
          return;
        }

        sweeping = true;

        yield* FiberSet.run(
          sweeper,
          Effect.repeat(
            Effect.sleep(settings.sweepEvery).pipe(Effect.andThen(sweepLogged)),
            Schedule.forever
          )
        );
      });

      const stopSweeper = Effect.gen(function* () {
        sweeping = false;
        yield* FiberSet.clear(sweeper);

        const left = yield* liveRows("close").pipe(
          Effect.orElseSucceed((): ReadonlyArray<StoredPortal> => [])
        );

        yield* Effect.logInfo("portal sweep stopped").pipe(
          Effect.annotateLogs({
            event: "portal_sweep_stopped",
            // Their units keep running: pages answer while the brain is down.
            portalsLeftRunning: left.length,
          })
        );
      });

      return Portals.of({
        open,
        start,
        close,
        list,
        reconcile,
        sweep,
        startSweeper,
        stopSweeper,
      });
    })
  );

  /** With the real porch and systemd; needs `SqlClient`. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(PorchClient.layer),
    Layer.provide(PortalUnits.layer)
  );
}
