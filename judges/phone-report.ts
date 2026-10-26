// The phone verdicts for the wizard (plan 4B, notes/edges.md "Load" and "Paste to model"), read from
// the brain's log: the events log a judge brain writes, or the deployed unit's journal.
//
//   node judges/phone-report.ts load  [--log <events.log> | --unit cairn] [--since "15 min ago"]
//                                     [--device phone] [--runs 3]
//   node judges/phone-report.ts paste [--log <events.log> | --unit cairn] [--since "15 min ago"]
//
// Load: the last `--runs` cold loads from the device's user agent (`load.report` lines), each with
// `interactiveMs` under 1,000. A report the brain flagged `derp` (the phone reached the Beelink
// through a relay) is excluded and counted, and the verdict asks for that many more loads.
//
// Paste: for each pasted image on the phone, `(chip ready - paste) + (provider.request - send)` under
// 2,000 ms. Every term is a brain-side difference or a phone-side duration, so no clock is compared
// across devices: `pasteToRequestMs` (the phone's own paste to `createUploadUrl`, on the
// `attachment.url_issued` line) plus `attachment.prepared - attachment.url_issued` (the upload and
// preparation the chip waits on) is the paste work; `provider.request - turn.submitted` (the first
// request with images after the send reached the brain) is send to model. The user's own pause
// before pressing send counts in neither.
//
// Prints one JSON line and exits 0 when the verdict passes, 1 when it fails, 2 when the log holds
// too few runs to judge.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { DateTime, Option } from "effect";

import * as Events from "./lib/Events.ts";
import type { BrainEvent } from "./lib/Events.ts";

/** A load must be interactive within this, on the phone (kickoff Targets). */
export const LOAD_LIMIT_MS = 1000;

/** Paste work plus send to model must be within this (plan, review response 11). */
export const PASTE_LIMIT_MS = 2000;

/** User agents the wizard counts as the phone. */
export const PHONE_AGENT = /iPhone|iPad|Android|Mobile/u;

export interface LoadRun {
  readonly at: string;
  readonly interactiveMs: number;
  readonly derp: boolean;
  readonly standalone: boolean;
}

export interface LoadVerdict {
  readonly verdict: "pass" | "fail" | "incomplete";
  /** The runs judged, oldest first. */
  readonly runs: ReadonlyArray<LoadRun>;
  /** Phone loads flagged `derp`, not judged. */
  readonly excludedDerp: number;
  /** How many more direct loads the wizard should ask for. */
  readonly askFor: number;
}

const millis = (event: BrainEvent) => DateTime.toEpochMillis(event.at);

const loadRunOf = (event: BrainEvent): Option.Option<LoadRun> =>
  Option.map(Events.numberField(event, "interactiveMs"), (interactiveMs) => ({
    at: DateTime.formatIso(event.at),
    interactiveMs,
    derp: event.fields.derp === true,
    standalone: event.fields.standalone === true,
  }));

/** The load verdict over a log's events: the last `runs` direct loads whose agent matches. */
export const loadVerdict = (
  events: ReadonlyArray<BrainEvent>,
  options: { readonly agent: RegExp; readonly runs: number }
): LoadVerdict => {
  const phone = events
    .filter(Events.named("load.report"))
    .filter((event) =>
      Option.exists(Events.stringField(event, "userAgent"), (agent) =>
        options.agent.test(agent)
      )
    )
    .flatMap((event) => Option.toArray(loadRunOf(event)));

  const direct = phone.filter((run) => !run.derp);
  const runs = direct.slice(-options.runs);
  const excludedDerp = phone.length - direct.length;

  if (runs.length < options.runs) {
    return {
      verdict: "incomplete",
      runs,
      excludedDerp,
      askFor: options.runs - runs.length,
    };
  }

  return {
    verdict: runs.every((run) => run.interactiveMs < LOAD_LIMIT_MS)
      ? "pass"
      : "fail",
    runs,
    excludedDerp,
    askFor: 0,
  };
};

export interface PasteRun {
  readonly attachmentId: string;
  readonly pasteToRequestMs: number;
  readonly uploadAndPrepareMs: number;
  readonly sendToProviderMs: number;
  readonly totalMs: number;
}

export interface PasteVerdict {
  readonly verdict: "pass" | "fail" | "incomplete";
  readonly runs: ReadonlyArray<PasteRun>;
}

/**
 * One paste's terms: the issued URL carrying the phone's paste-to-request time, its preparation,
 * the first send after it, and the first provider request with images after that send.
 */
const pasteRunOf = (
  events: ReadonlyArray<BrainEvent>,
  issued: BrainEvent
): Option.Option<PasteRun> => {
  const id = Events.stringField(issued, "attachmentId");
  const pasteToRequestMs = Events.numberField(issued, "pasteToRequestMs");

  if (Option.isNone(id) || Option.isNone(pasteToRequestMs)) {
    return Option.none();
  }

  const after = (from: BrainEvent) =>
    events.filter((event) => millis(event) >= millis(from));

  const prepared = Option.fromNullishOr(
    after(issued).find(
      (event) =>
        event.event === "attachment.prepared" &&
        Option.contains(Events.stringField(event, "attachmentId"), id.value)
    )
  );

  const submitted = Option.flatMap(prepared, (ready) =>
    Option.fromNullishOr(
      after(ready).find(
        (event) =>
          event.event === "turn.submitted" &&
          Option.exists(Events.numberField(event, "images"), (n) => n > 0)
      )
    )
  );

  const request = Option.flatMap(submitted, (send) =>
    Option.fromNullishOr(after(send).find(Events.named("provider.request")))
  );

  return Option.all({ prepared, submitted, request }).pipe(
    Option.map(({ prepared: ready, submitted: send, request: sent }) => {
      const uploadAndPrepareMs = millis(ready) - millis(issued);
      const sendToProviderMs = millis(sent) - millis(send);

      return {
        attachmentId: id.value,
        pasteToRequestMs: pasteToRequestMs.value,
        uploadAndPrepareMs,
        sendToProviderMs,
        totalMs: pasteToRequestMs.value + uploadAndPrepareMs + sendToProviderMs,
      };
    })
  );
};

/** The paste verdict over every image paste in the log that reached the model. */
export const pasteVerdict = (
  events: ReadonlyArray<BrainEvent>
): PasteVerdict => {
  const runs = events
    .filter(Events.named("attachment.url_issued"))
    .filter((event) =>
      Option.exists(Events.stringField(event, "mimeType"), (mime) =>
        mime.startsWith("image/")
      )
    )
    .flatMap((issued) => Option.toArray(pasteRunOf(events, issued)));

  if (runs.length === 0) {
    return { verdict: "incomplete", runs };
  }

  return {
    verdict: runs.every((run) => run.totalMs < PASTE_LIMIT_MS)
      ? "pass"
      : "fail",
    runs,
  };
};

/** The log's text: a file, or the unit's journal since `since`. */
export const readLog = (options: {
  readonly log: Option.Option<string>;
  readonly unit: string;
  readonly since: string;
}): string =>
  Option.match(options.log, {
    onSome: (file) => readFileSync(file, "utf-8"),
    onNone: () =>
      execFileSync(
        "journalctl",
        ["--user", "-u", options.unit, "-o", "cat", "--since", options.since],
        { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 }
      ),
  });

const exitCodeOf = (verdict: "pass" | "fail" | "incomplete") => {
  if (verdict === "pass") {
    return 0;
  }

  return verdict === "fail" ? 1 : 2;
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      log: { type: "string" },
      unit: { type: "string", default: "cairn" },
      since: { type: "string", default: "15 min ago" },
      device: { type: "string", default: "phone" },
      runs: { type: "string", default: "3" },
    },
  });

  const events = Events.parseLines(
    readLog({
      log: Option.fromUndefinedOr(values.log),
      unit: values.unit,
      since: values.since,
    })
  );

  const result =
    positionals[0] === "paste"
      ? pasteVerdict(events)
      : loadVerdict(events, {
          agent:
            values.device === "phone"
              ? PHONE_AGENT
              : new RegExp(values.device, "u"),
          runs: Number(values.runs),
        });

  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCodeOf(result.verdict);
}
