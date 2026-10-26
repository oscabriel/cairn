// The wire budget judge (plan 4C, ADR 0020): what a client pays to open a long thread.
//
//   node judges/wire-budget.ts [--entries 2000] [--images 20] [--rounds 5] [--rtt-ms 60] [--mbps 10]
//                              [--keep] [--reuse <dir>]
//
// It starts the judge brain (`apps/server/src/judge-main.ts`, pi-durable over the scripted faux
// model, the real coding tools) on an ephemeral loopback port in a throwaway directory and grows one
// thread to `--entries` active entries with real tool calls (`bash`, `read`, `grep`, `find`, `ls`
// over a small project), spreading `--images` pictures through it: half pasted by the user (a
// 1170x2532 PNG uploaded through the attachment route), half returned by `read` on a PNG file.
//
// Then, `--rounds` times, a cold client opens a socket, says hello and subscribes, and the judge
// times the first frame. Each first frame must be a snapshot under 200,000 bytes of JSON that holds
// no base64 payload. The time on the tailnet is modelled from the loopback time: 4 round trips
// (TCP, TLS, the upgrade, the subscribe) of `--rtt-ms` plus the deflated frame at `--mbps`, and its
// p95 must be under 1,000 ms. Every image in the thread (the window plus the pages `thread.history`
// returns behind it) must be fetchable: a pasted one returns the uploaded bytes, a tool one returns
// a PNG of the size the entry declares. The window plus its history must hold every active entry
// once, oldest first.
//
// `--keep` leaves the directory; `--reuse <dir>` starts the brain over a kept directory and skips
// the seeding, so the same thread is measured before and after a change. Prints one JSON line and
// exits 0 only on a pass.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";

import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import {
  AttachmentId,
  CommandId,
  EntryId,
  RequestId,
  ThreadId,
} from "@cairn/protocol/Ids";
import { RootWorkspace } from "@cairn/protocol/Launch";
import type { CairnRpcs } from "@cairn/protocol/Rpc";
import { ProjectCreate } from "@cairn/protocol/ShellCommands";
import { ProjectedImage, ThreadStreamItem } from "@cairn/protocol/Thread";
import type { Entry } from "@cairn/protocol/Thread";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Clock,
  Effect,
  Exit,
  Match,
  Option,
  Predicate,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { RpcClient, RpcClientError, RpcGroup } from "effect/rpc";

import { projectIdFor } from "../apps/server/src/shell/ShellCommands.ts";
import { SCRIPT_PREFIX } from "./fixtures/JudgeModel.ts";
import * as Events from "./lib/Events.ts";
import * as ProtocolClient from "./lib/ProtocolClient.ts";

const { values } = parseArgs({
  options: {
    entries: { type: "string", default: "2000" },
    images: { type: "string", default: "20" },
    rounds: { type: "string", default: "5" },
    "rtt-ms": { type: "string", default: "60" },
    mbps: { type: "string", default: "10" },
    keep: { type: "boolean", default: false },
    reuse: { type: "string" },
  },
});

const TARGET_ENTRIES = Number(values.entries);

const TARGET_IMAGES = Number(values.images);

const ROUNDS = Number(values.rounds);

const RTT_MS = Number(values["rtt-ms"]);

const MBPS = Number(values.mbps);

/** The budget for one snapshot frame, in bytes of JSON. */
const SNAPSHOT_BUDGET_BYTES = 200_000;

/** The budget for the first frame on the tailnet (modelled), p95. */
const FIRST_FRAME_BUDGET_MS = 1000;

/** Round trips before the first frame: TCP, TLS, the upgrade, the subscribe. */
const ROUND_TRIPS = 4;

const REPO = path.resolve(import.meta.dirname, "..");

const ORIGIN = "http://judge.cairn.test";

const HOST = "judge.cairn.test";

const OWNER = "owner@loopback";

/** Base64 runs this long are payloads, not prose. */
const BASE64_RUN = /[A-Za-z0-9+/]{400,}={0,2}/u;

class JudgeFailed extends Schema.TaggedError<JudgeFailed>()("JudgeFailed", {
  message: Schema.String,
}) {}

const fail = (message: string) => Effect.fail(new JudgeFailed({ message }));

type Client = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof CairnRpcs>,
  RpcClientError.RpcClientError
>;

// Ids: commands and threads take UUIDv7 strings, requests an opaque token.

const uuid7 = Effect.map(Clock.currentTimeMillis, (now) => {
  const time = now.toString(16).padStart(12, "0");
  const tail = randomBytes(10).toString("hex");

  const variant = (0x8 + (Number.parseInt(tail.slice(3, 4), 16) % 4)).toString(
    16
  );

  return [
    time.slice(0, 8),
    time.slice(8, 12),
    `7${tail.slice(0, 3)}`,
    `${variant}${tail.slice(4, 7)}`,
    tail.slice(7, 19).padEnd(12, "0"),
  ].join("-");
});

const newCommandId = Effect.map(uuid7, (id) => CommandId.make(id));

const newThreadId = Effect.map(uuid7, (id) => ThreadId.make(id));

const newRequestId = Effect.map(uuid7, (id) =>
  RequestId.make(`req_${id.replaceAll("-", "")}`)
);

// A PNG without dependencies: 8-bit RGB, stripes and a nonce row, so every image is distinct.

const pngChunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);

  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
};

const png = (width: number, height: number, nonce: number) => {
  const header = Buffer.alloc(13);

  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);

  const row = width * 3 + 1;
  const pixels = Buffer.alloc(row * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * row + 1 + x * 3;
      const band = Math.floor(y / 40) % 6;

      pixels[at] = (band * 40 + nonce * 7) % 256;
      pixels[at + 1] = (x + nonce * 13) % 256;
      pixels[at + 2] = y === nonce % height ? 255 : (y * 3) % 256;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

// The project the thread works in.

const NOTES = Array.from(
  { length: 60 },
  (_, line) =>
    `- Note ${line}: the wire budget judge reads this file, so a tool result looks like a real one.`
).join("\n");

const SOURCE = Array.from(
  { length: 90 },
  (_, line) =>
    `export function step${line}(input: number): number {\n  return input * ${line} + 1;\n}`
).join("\n\n");

const writeProject = (project: string) => {
  mkdirSync(path.join(project, "src"), { recursive: true });
  mkdirSync(path.join(project, "shots"), { recursive: true });
  writeFileSync(path.join(project, "notes.md"), NOTES);
  writeFileSync(path.join(project, "src", "app.ts"), SOURCE);
  writeFileSync(path.join(project, "src", "small.ts"), "export const a = 1;\n");

  for (let index = 0; index < TARGET_IMAGES; index += 1) {
    writeFileSync(
      path.join(project, "shots", `shot-${index}.png`),
      png(320, 240, index + 1)
    );
  }
};

/** One turn's script: eight tool calls over the project, then a short answer. */
const turnScript = (turn: number, shot: Option.Option<number>) => {
  const steps = [
    `tool bash {"command":"cat notes.md | head -${4 + (turn % 8)}"}`,
    `tool read {"path":"src/app.ts","offset":${1 + (turn % 50)},"limit":12}`,
    `tool grep {"pattern":"step${turn % 90}\\\\b"}`,
    `tool ls {"path":"src"}`,
    `tool bash {"command":"seq 1 ${10 + (turn % 30)}"}`,
    `tool read {"path":"notes.md","limit":${3 + (turn % 6)}}`,
    `tool find {"pattern":"*.ts"}`,
    Option.match(shot, {
      onNone: () => `tool bash {"command":"wc -l src/app.ts notes.md"}`,
      onSome: (index) => `tool read {"path":"shots/shot-${index}.png"}`,
    }),
    "text 30",
  ];

  return `${SCRIPT_PREFIX} ${steps.join("; ")}`;
};

// The brain.

interface Run {
  readonly dir: string;
  readonly project: string;
  readonly events: string;
  readonly state: string;
}

interface Seeded {
  readonly threadId: string;
  /** Uploaded attachment id to the sha256 of the bytes sent. */
  readonly uploads: Record<string, string>;
}

const startBrain = (run: Run) =>
  Effect.gen(function* () {
    const from = yield* Effect.sync(() =>
      existsSync(run.events) ? readFileSync(run.events).length : 0
    );

    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, ["apps/server/src/judge-main.ts"], {
          cwd: REPO,
          stdio: "ignore",
          env: {
            HOME: run.dir,
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            CAIRN_PORT: "0",
            CAIRN_ORIGIN: ORIGIN,
            CAIRN_OWNER: OWNER,
            CAIRN_DATA_DIR: path.join(run.dir, "data"),
            CAIRN_CONFIG_DIR: path.join(run.dir, "config"),
            CAIRN_EVENTS_LOG: run.events,
            CAIRN_JUDGE_EFFECTS_LOG: path.join(run.dir, "effects.log"),
          },
        })
      ),
      (process: ChildProcess) =>
        Effect.sync(() => {
          process.kill("SIGKILL");
        })
    );

    const port = yield* Events.waitForListening(run.events, {
      from,
      timeout: "60 seconds",
    });

    yield* Events.waitFor(run.events, "ready", Events.named("ready"), {
      from,
      timeout: "60 seconds",
    });

    return { child, port };
  });

/** A protocol client in the caller's scope, retried until the brain accepts the socket. */
const connect = (port: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const scope = yield* Scope.make();

      const opened = yield* ProtocolClient.cairn({
        base: `http://127.0.0.1:${port}`,
        origin: ORIGIN,
        headers: { host: HOST, "x-cairn-user": OWNER },
        openTimeout: "5 seconds",
      }).pipe(
        Effect.tap((client) =>
          client["session.hello"]().pipe(Effect.timeout("5 seconds"))
        ),
        Scope.provide(scope),
        Effect.result
      );

      if (Result.isSuccess(opened)) {
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

        return opened.success;
      }

      yield* Scope.close(scope, Exit.void);
      yield* Effect.sleep("100 millis");
    }

    return yield* fail(`no socket to the brain on port ${port}`);
  });

/** One HTTP request to the brain with the headers Caddy would add. */
const request = (
  port: number,
  method: string,
  pathname: string,
  body: Option.Option<Buffer>
) =>
  Effect.callback<
    { readonly status: number; readonly type: string; readonly body: Buffer },
    JudgeFailed
  >((resume) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathname,
        headers: {
          host: HOST,
          origin: ORIGIN,
          "x-cairn-user": OWNER,
          ...Option.match(body, {
            onNone: () => ({}),
            onSome: (bytes) => ({
              "content-length": String(bytes.length),
              "content-type": "application/octet-stream",
            }),
          }),
        },
      },
      (response) => {
        const chunks: Array<Buffer> = [];

        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resume(
            Effect.succeed({
              status: response.statusCode ?? 0,
              type: response.headers["content-type"] ?? "",
              body: Buffer.concat(chunks),
            })
          );
        });
      }
    );

    outgoing.on("error", (cause) => {
      resume(fail(`${method} ${pathname} failed: ${cause.message}`));
    });
    outgoing.end(Option.getOrUndefined(body));
  });

// Following the thread: a client-logic view, as the browser holds it.

const follow = (client: Client, threadId: ThreadId) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(Option.none<ThreadViewState>());
    const errors = yield* Ref.make<ReadonlyArray<string>>([]);

    yield* client["thread.subscribe"]({
      threadId,
      conversationId: Option.none(),
    }).pipe(
      Stream.runForEach((item) =>
        Effect.gen(function* () {
          const next = applyThreadStreamItem(yield* Ref.get(state), item);

          if (Result.isFailure(next)) {
            yield* Ref.update(errors, (all) => [...all, next.failure.message]);

            return;
          }

          yield* Ref.set(state, Option.some(next.success));
        })
      ),
      Effect.ignore,
      Effect.forkScoped
    );

    return { state, errors };
  });

const USER_KINDS: ReadonlySet<string> = new Set(["pi.user", "cairn.user"]);

const stopReasonOf = (entry: Entry) => {
  const [message] = entry.model ?? [];

  return Predicate.isObject(message) &&
    Predicate.hasProperty(message, "stopReason")
    ? String(message.stopReason)
    : "";
};

/** Active entries the client knows of, and whether the newest turn has ended. */
const progress = (state: ThreadViewState) => {
  const { entries } = state.view;
  const lastUser = entries.findLastIndex((entry) => USER_KINDS.has(entry.kind));
  const last = entries.at(-1);
  const inbox = state.view.docs["pi.inbox"];

  const queued =
    Predicate.isObject(inbox) &&
    Predicate.hasProperty(inbox, "items") &&
    Array.isArray(inbox.items) &&
    inbox.items.length > 0;

  return {
    /** Entry ids only grow, so the newest id survives a compaction that shortens the view. */
    newest: last?.id ?? 0,
    active: state.entriesOffset + entries.length,
    settled:
      !queued &&
      last !== undefined &&
      last.kind === "pi.assistant" &&
      stopReasonOf(last) === "stop" &&
      entries.lastIndexOf(last) > lastUser,
  };
};

/** Waits until the thread's newest turn ended with an entry newer than `after`. */
const settledPast = (
  state: Ref.Ref<Option.Option<ThreadViewState>>,
  after: number
) =>
  Effect.gen(function* () {
    for (;;) {
      const held = yield* Ref.get(state);

      if (Option.isSome(held)) {
        const now = progress(held.value);

        if (now.settled && now.newest > after) {
          return now;
        }
      }

      yield* Effect.sleep("20 millis");
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "120 seconds",
      orElse: () => fail(`a turn did not end after entry ${after}`),
    })
  );

/** Uploads a pasted screenshot; returns its ref and the sha256 of the bytes sent. */
const upload = (client: Client, port: number, nonce: number) =>
  Effect.gen(function* () {
    const bytes = png(1170, 2532, 1000 + nonce);

    const target = yield* client["attachments.createUploadUrl"]({
      name: `screenshot-${nonce}.png`,
      mimeType: "image/png",
      sizeBytes: bytes.length,
    });

    const answer = yield* request(
      port,
      "POST",
      target.uploadPath,
      Option.some(bytes)
    );

    if (answer.status !== 200) {
      return yield* fail(
        `the upload answered ${answer.status}: ${answer.body.toString("utf-8").slice(0, 200)}`
      );
    }

    return { attachmentId: target.attachmentId, sha: sha256(bytes) };
  });

/** Grows a new thread to the target size. */
const seed = (port: number, run: Run) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* connect(port);
      const projectCommand = yield* newCommandId;

      yield* client["shell.dispatch"](
        ProjectCreate.make({
          commandId: projectCommand,
          workspaceRoot: run.project,
          title: Option.some("wire budget"),
        })
      );

      const threadId = yield* newThreadId;
      const uploads: Record<string, string> = {};

      // Images are spread evenly: one every `spacing` turns, alternating paste and tool.
      const turns = Math.ceil(TARGET_ENTRIES / 18);

      const spacing = Math.max(
        1,
        Math.floor(turns / Math.max(1, TARGET_IMAGES))
      );

      let pasted = 0;
      let shots = 0;

      const imageFor = (turn: number) =>
        Effect.gen(function* () {
          if (turn % spacing !== 0 || pasted + shots >= TARGET_IMAGES) {
            return { attachments: [], shot: Option.none<number>() };
          }

          if ((turn / spacing) % 2 === 0) {
            const uploaded = yield* upload(client, port, pasted);

            pasted += 1;
            uploads[uploaded.attachmentId] = uploaded.sha;

            return {
              attachments: [AttachmentId.make(uploaded.attachmentId)],
              shot: Option.none<number>(),
            };
          }

          shots += 1;

          return { attachments: [], shot: Option.some(shots - 1) };
        });

      const first = yield* imageFor(0);

      yield* client["thread.launch"]({
        commandId: yield* newCommandId,
        threadId,
        projectId: projectIdFor(projectCommand),
        title: Option.some("wire budget"),
        model: { provider: "faux", modelId: "scripted" },
        thinkingLevel: "off",
        runtimeMode: "full-access",
        workspace: RootWorkspace.make({ branch: Option.none() }),
        initialMessage: {
          requestId: yield* newRequestId,
          text: turnScript(0, first.shot),
          attachments: first.attachments,
          skillRefs: [],
        },
      });

      const { state } = yield* follow(client, threadId);
      let reached = yield* settledPast(state, 0);

      for (let turn = 1; reached.active < TARGET_ENTRIES; turn += 1) {
        const image = yield* imageFor(turn);

        yield* client["thread.send"]({
          threadId,
          input: {
            requestId: yield* newRequestId,
            text: turnScript(turn, image.shot),
            attachments: image.attachments,
            skillRefs: [],
          },
          whenBusy: "followUp",
        });

        reached = yield* settledPast(state, reached.newest);
      }

      const seeded: Seeded = { threadId, uploads };

      writeFileSync(run.state, JSON.stringify(seeded));

      return seeded;
    })
  );

// Measuring.

const decodeSeeded = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: Schema.String,
      uploads: Schema.Record(Schema.String, Schema.String),
    })
  )
);

const encodeItem = Schema.encodeSync(ThreadStreamItem);

interface Round {
  readonly loopbackMs: number;
  readonly snapshotBytes: number;
  readonly deflatedBytes: number;
  readonly tailnetMs: number;
  readonly entries: number;
  readonly entriesOffset: number;
  readonly hasMoreHistory: boolean;
  readonly base64: boolean;
}

/** One cold client: socket, hello, subscribe, first frame. */
const coldRound = (port: number, threadId: ThreadId) =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const client = yield* connect(port);

      const first = yield* client["thread.subscribe"]({
        threadId,
        conversationId: Option.none(),
      }).pipe(Stream.runHead);

      const at = yield* Clock.currentTimeMillis;

      if (
        Option.isNone(first) ||
        !Predicate.isTagged(first.value, "Snapshot")
      ) {
        return yield* fail(
          "the first frame of a subscription was not a snapshot"
        );
      }

      const json = JSON.stringify(encodeItem(first.value));
      const deflated = deflateRawSync(Buffer.from(json)).length;
      const loopbackMs = at - started;

      return {
        loopbackMs,
        snapshotBytes: Buffer.byteLength(json),
        deflatedBytes: deflated,
        tailnetMs: Math.round(
          loopbackMs + ROUND_TRIPS * RTT_MS + (deflated * 8) / (MBPS * 1000)
        ),
        entries: first.value.view.entries.length,
        entriesOffset: first.value.entriesOffset,
        hasMoreHistory: first.value.hasMoreHistory,
        base64: json.includes("iVBORw0KGgo") || BASE64_RUN.test(json),
        snapshot: first.value,
      } satisfies Round & { readonly snapshot: unknown };
    })
  );

const percentile = (samples: ReadonlyArray<number>, p: number) => {
  const sorted = samples.toSorted((a, b) => a - b);

  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0
  );
};

const isProjectedImage = Schema.is(ProjectedImage);

const decodeContent = Schema.decodeUnknownOption(
  Schema.Struct({ content: Schema.Array(Schema.Unknown) })
);

/** The images of an entry's messages: user pastes and tool results carry them in `content`. */
const imagesOf = (entry: Entry): ReadonlyArray<ProjectedImage> =>
  (entry.model ?? []).flatMap((message) =>
    Option.match(decodeContent(message), {
      onNone: () => [],
      onSome: ({ content }) => content.filter(isProjectedImage),
    })
  );

/** The window plus every page behind it, oldest first. */
const wholeThread = (
  client: Client,
  threadId: ThreadId,
  window: ReadonlyArray<Entry>,
  hasMoreHistory: boolean
) =>
  Effect.gen(function* () {
    const pages: Array<ReadonlyArray<Entry>> = [];
    let before = window[0]?.id;
    let exhausted = !hasMoreHistory;

    while (!exhausted && before !== undefined) {
      const page = yield* client["thread.history"]({
        threadId,
        conversationId: Option.none(),
        before: EntryId.make(before),
        limit: 500,
      });

      pages.unshift(page.entries);
      before = page.entries[0]?.id;
      exhausted = !page.hasMore;

      if (page.entries.length === 0) {
        break;
      }
    }

    return {
      entries: [...pages.flat(), ...window],
      pages: pages.length,
      exhausted,
    };
  });

/** Fetches one image by its reference and judges the bytes. */
const fetchImage = (
  port: number,
  threadId: ThreadId,
  image: ProjectedImage,
  seeded: Seeded,
  shotShas: ReadonlySet<string>
) =>
  Match.valueTags(image.ref, {
    Attachment: ({ attachmentId }) =>
      Effect.map(
        request(
          port,
          "GET",
          `/api/attachments/${encodeURIComponent(attachmentId)}/original`,
          Option.none()
        ),
        (answer) => ({
          ok:
            answer.status === 200 &&
            seeded.uploads[attachmentId] === sha256(answer.body),
          how: "attachment",
        })
      ),
    EntryImage: ({ entryId, index }) =>
      Effect.map(
        request(
          port,
          "GET",
          `/api/threads/${encodeURIComponent(threadId)}/entries/${entryId}/images/${index}`,
          Option.none()
        ),
        (answer) => ({
          ok:
            answer.status === 200 &&
            answer.body.subarray(1, 4).toString("latin1") === "PNG" &&
            answer.body.length === image.bytes,
          how: shotShas.has(sha256(answer.body))
            ? "tool-exact"
            : "tool-reencoded",
        })
      ),
  });

const countBy = (
  results: ReadonlyArray<{ readonly how: string }>,
  how: string
) => results.filter((result) => result.how === how).length;

/** The run's directory: a new one, or the kept one `--reuse` names. */
const prepare = Effect.gen(function* () {
  const dir =
    values.reuse ?? mkdtempSync(path.join(os.tmpdir(), "cairn-wire-budget-"));

  const run: Run = {
    dir,
    project: path.join(dir, "project"),
    events: path.join(dir, "events.log"),
    state: path.join(dir, "judge.json"),
  };

  if (values.reuse === undefined) {
    writeProject(run.project);
  }

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (!values.keep && values.reuse === undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    })
  );

  return run;
});

/** `--rounds` cold first frames; the first snapshot is kept for the history and image checks. */
const measure = (port: number, threadId: ThreadId) =>
  Effect.gen(function* () {
    const { snapshot, ...first } = yield* coldRound(port, threadId);
    const rounds: Array<Round> = [first];

    for (let index = 1; index < ROUNDS; index += 1) {
      rounds.push(yield* coldRound(port, threadId));
    }

    return { rounds, snapshot };
  });

const main = Effect.gen(function* () {
  const run = yield* prepare;
  const { port } = yield* startBrain(run);
  const seedStarted = yield* Clock.currentTimeMillis;

  const seeded =
    values.reuse === undefined
      ? yield* seed(port, run)
      : decodeSeeded(readFileSync(run.state, "utf-8"));

  const seedMs = (yield* Clock.currentTimeMillis) - seedStarted;
  const threadId = ThreadId.make(seeded.threadId);
  const { rounds, snapshot } = yield* measure(port, threadId);
  const active = snapshot.entriesOffset + snapshot.view.entries.length;

  const whole = yield* Effect.scoped(
    Effect.flatMap(connect(port), (client) =>
      wholeThread(
        client,
        threadId,
        snapshot.view.entries,
        snapshot.hasMoreHistory
      )
    )
  );

  const ids = whole.entries.map((entry) => entry.id);

  const ordered = ids.every(
    (id, index) => index === 0 || id > (ids[index - 1] ?? 0)
  );

  const found = whole.entries.flatMap(imagesOf);

  const shotShas = new Set(
    Array.from({ length: TARGET_IMAGES }, (_, index) =>
      sha256(readFileSync(path.join(run.project, "shots", `shot-${index}.png`)))
    )
  );

  const images = yield* Effect.forEach(found, (image) =>
    fetchImage(port, threadId, image, seeded, shotShas)
  );

  const tailnet = rounds.map((round) => round.tailnetMs);
  const loopback = rounds.map((round) => round.loopbackMs);
  const largest = Math.max(...rounds.map((round) => round.snapshotBytes));

  const checks = {
    entries: active >= TARGET_ENTRIES,
    snapshotUnderBudget: largest < SNAPSHOT_BUDGET_BYTES,
    noBase64: rounds.every((round) => !round.base64),
    images:
      images.length >= TARGET_IMAGES && images.every((result) => result.ok),
    firstFrame: percentile(tailnet, 0.95) < FIRST_FRAME_BUDGET_MS,
    // History is fork-aware: it may also return entries a compaction took out of the view.
    historyComplete: ordered && whole.exhausted && ids.length >= active,
    hasMoreHistory: snapshot.entriesOffset === 0 || snapshot.hasMoreHistory,
  };

  const passed = Object.values(checks).every(Boolean);

  const report = {
    judge: "wire-budget",
    passed,
    checks,
    thread: {
      activeEntries: active,
      newestEntryId: ids.at(-1) ?? 0,
      historyEntries: ids.length,
      historyPages: whole.pages,
      seedMs,
      images: images.length,
      imagesByKind: {
        attachment: countBy(images, "attachment"),
        toolExact: countBy(images, "tool-exact"),
        toolReencoded: countBy(images, "tool-reencoded"),
      },
      imageFailures: images.filter((result) => !result.ok).length,
    },
    snapshot: {
      bytes: largest,
      deflatedBytes: Math.max(...rounds.map((round) => round.deflatedBytes)),
      entries: snapshot.view.entries.length,
      entriesOffset: snapshot.entriesOffset,
      hasMoreHistory: snapshot.hasMoreHistory,
    },
    firstFrameMs: {
      loopbackP50: percentile(loopback, 0.5),
      loopbackMax: Math.max(...loopback),
      tailnetModelP50: percentile(tailnet, 0.5),
      tailnetModelP95: percentile(tailnet, 0.95),
      model: `${ROUND_TRIPS} x ${RTT_MS} ms + deflated bytes at ${MBPS} Mbps`,
    },
    dir: values.keep || values.reuse !== undefined ? run.dir : undefined,
  };

  yield* Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  });

  return yield* passed ? Effect.void : fail("the wire budget was not met");
});

NodeRuntime.runMain(
  Effect.scoped(main).pipe(
    Effect.tapError((failure) =>
      Effect.sync(() => {
        process.stderr.write(`wire-budget: ${failure.message}\n`);
      })
    ),
    Effect.provide(NodeServices.layer)
  )
);
