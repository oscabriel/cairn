// The judge brain of `judges/pi-host.ts` (ADR 0039, reach R8): Cairn's pi-durable Harness over a
// scratch directory, on pi-ai's faux model, with the tools-only pi host loading the user's real
// allowlisted packages and the `pi-host-counter` fixture through pi's own loader. Never the deployed
// unit's store, never `~/.pi/agent` itself: the scratch agent dir's `settings.json` names the
// packages and its `npm/node_modules` holds symlinks to the user's installed copies, read only.
//
//   node judges/fixtures/pi-host/HostBrain.ts --dir <run> --life call|resume|read [--control]
//                                             [--user-agent <dir>]
//
// - `call`: the real packages answer first (`ffgrep` finds a nonce in a scratch folder,
//   `get_search_content` answers for an id it never stored; no network), then two threads call
//   `counter_safe` and `counter_unsafe` while `<run>/hold` exists. The judge `kill -9`s this life
//   once both calls have counted a run.
// - `resume`: the Harness resumes; both counter threads finish; `ffgrep` runs again on a new folder
//   instance (the restart dropped the old one).
// - `read`: a plain reopen that runs nothing, reading back what the store committed.
//
// `--control` is the broken control: a host whose replay table names neither counter tool, so the
// safe one comes back interrupted instead of running again; the judge must fail on it.
//
// Every life prints JSON lines: `loaded` (the host's packages), `calling` (both counter calls
// submitted), and `report` (each thread's tool results and final answer) once its work is done.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ProjectId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import type { Entry } from "@cairn/protocol/Thread";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { NodeRuntime } from "@effect/platform-node";
import {
  Console,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";

import { Brain } from "../../../apps/server/src/brain/Brain.ts";
import { FauxModels } from "../../../apps/server/src/brain/FauxModels.ts";
import { HarnessSeam } from "../../../apps/server/src/brain/HarnessSeam.ts";
import { FAUX_MODEL } from "../../../apps/server/src/brain/ModelSource.ts";
import { PiConfig } from "../../../apps/server/src/models/PiConfig.ts";
import { PiHost } from "../../../apps/server/src/pi-host/PiHost.ts";
import type {
  PiHostPolicy,
  PiPackagePolicy,
} from "../../../apps/server/src/pi-host/PiHostPolicy.ts";
import { PI_HOST_POLICY } from "../../../apps/server/src/pi-host/PiHostPolicy.ts";
import { brainLayer } from "../../../apps/server/src/pi-host/PiHostTestKit.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    life: { type: "string", default: "call" },
    control: { type: "boolean", default: false },
    "user-agent": { type: "string" },
  },
});

const dir = path.resolve(values.dir ?? ".");

const { life } = values;

/** The fixture package beside this file. */
const COUNTER = path.join(import.meta.dirname, "pi-host-counter");

/** The real packages, by npm name, as the user's agent dir installs them. */
const REAL = ["pi-web-access", "@ff-labs/pi-fff"];

/** The nonce `ffgrep` must find, fixed per run so every life searches for the same one. */
const nonceFile = path.join(dir, "nonce");

const thread = (n: number) =>
  ThreadId.make(
    `0190f0c0-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`
  );

/** The threads of a run: what each one's model calls, and where it runs. */
const THREADS = {
  safe: { id: thread(1), tool: "counter_safe" },
  unsafe: { id: thread(2), tool: "counter_unsafe" },
  grep: { id: thread(3), tool: "ffgrep" },
  content: { id: thread(4), tool: "get_search_content" },
  regrep: { id: thread(5), tool: "ffgrep" },
} as const;

type ThreadName = keyof typeof THREADS;

/** What one thread committed, as a life reports it. */
interface ThreadReport {
  /** Each `pi.tool-result` entry, as JSON. */
  readonly toolResults: ReadonlyArray<string>;
  readonly finished: boolean;
  readonly entries: number;
}

/** One line this brain prints. */
type BrainLine =
  | {
      readonly event: "loaded";
      readonly life: string;
      readonly packages: ReadonlyArray<{
        readonly name: string;
        readonly version: string;
        readonly tools: ReadonlyArray<string>;
      }>;
    }
  | { readonly event: "calling"; readonly life: string }
  | {
      readonly event: "report";
      readonly life: string;
      readonly threads: Readonly<Record<string, ThreadReport>>;
    };

const print = (line: BrainLine) => Console.log(JSON.stringify(line));

/**
 * The scratch agent dir: `settings.json` naming the counter and every real package the user has
 * installed, each under `npm/node_modules` (a copy of the counter, symlinks to the real ones).
 */
const prepareAgentDir = (userAgent: string) => {
  const agentDir = path.join(dir, "agent");
  const npm = path.join(agentDir, "npm");
  const userNpm = path.join(userAgent, "npm");

  mkdirSync(agentDir, { recursive: true });

  // The whole `npm` tree, so each real package resolves its own dependencies beside it.
  if (!existsSync(npm) && userAgent !== "" && existsSync(userNpm)) {
    symlinkSync(userNpm, npm, "dir");
  }

  const real = REAL.filter((name) =>
    existsSync(path.join(npm, "node_modules", name, "package.json"))
  );

  writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [COUNTER, ...real.map((name) => `npm:${name}`)],
    })
  );

  return agentDir;
};

const counterPolicy: PiPackagePolicy = {
  name: "pi-host-counter",
  versions: "1.0.x",
  scope: "brain",
  flags: () => new Map([["counter-dir", dir]]),
  env: () => new Map(),
  dropped: [],
};

/** The brain's own policy plus the counter; the control's replay table forgets both tools. */
const policy: PiHostPolicy = {
  packages: [...PI_HOST_POLICY.packages, counterPolicy],
  safeTools: values.control
    ? PI_HOST_POLICY.safeTools
    : new Set([...PI_HOST_POLICY.safeTools, "counter_safe"]),
  folderInstances: PI_HOST_POLICY.folderInstances,
};

/** The call a user message names. */
const NamedCall = Schema.Struct({
  tool: Schema.String,
  args: Schema.Record(Schema.String, Schema.String),
});

const decodeCall = Schema.decodeUnknownOption(Schema.fromJsonString(NamedCall));

/** A user message that names the tool call the faux model should make. */
const ask = (tool: string, args: Record<string, string>) =>
  `call ${JSON.stringify({ tool, args })}`;

/**
 * The faux model: after a tool result it answers "done"; otherwise it makes the call the newest
 * user message names.
 */
const step: FauxResponseFactory = (context) => {
  const last = context.messages.at(-1);

  if (last?.role === "toolResult") {
    return fauxAssistantMessage("done");
  }

  const user = context.messages.findLast((message) => message.role === "user");

  const text = Predicate.isString(user?.content)
    ? user.content
    : (user?.content ?? [])
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");

  const named = /^call (?<json>.*)$/su.exec(text)?.groups?.json ?? "";

  const call = Option.getOrElse(decodeCall(named), () => ({
    tool: "none",
    args: {},
  }));

  return fauxAssistantMessage(
    [fauxToolCall(call.tool, call.args, { id: "c1" })],
    { stopReason: "toolUse" }
  );
};

/** Text of an entry, as JSON, for the judge's checks. */
const entryText = (entry: Entry) => JSON.stringify(entry);

/** The thread's entries now. */
const entriesOf = (name: ThreadName) =>
  Effect.gen(function* () {
    const seam = yield* HarnessSeam;

    const [frame] = yield* seam
      .watch(THREADS[name].id)
      .pipe(Stream.take(1), Stream.runCollect);

    return frame?._tag === "Snapshot" ? frame.view.entries : [];
  });

/** A thread is finished when its newest entry is the model's closing "done". */
const finished = (entries: ReadonlyArray<Entry>) => {
  const last = entries.at(-1);

  return (
    last !== undefined &&
    last.kind !== "pi.tool-result" &&
    /"done"/u.test(entryText(last))
  );
};

/** Waits for every named thread to finish, polling its view. */
const awaitFinished = (names: ReadonlyArray<ThreadName>) =>
  Effect.gen(function* () {
    for (;;) {
      const views = yield* Effect.forEach(names, entriesOf);

      if (views.every(finished)) {
        return;
      }

      yield* Effect.sleep("50 millis");
    }
  }).pipe(Effect.timeout("90 seconds"));

/** Starts `name`'s thread in `cwd` and submits its one call. */
const start = (
  name: ThreadName,
  cwd: string,
  args: Record<string, string> = {}
) =>
  Effect.gen(function* () {
    const seam = yield* HarnessSeam;
    const spec = THREADS[name];

    yield* seam.ensureThread({
      threadId: spec.id,
      projectId: ProjectId.make("pi-host-judge"),
      model: FAUX_MODEL,
      thinkingLevel: "off",
      cwd,
      instructions: Option.none(),
      runtimeMode: "full-access",
    });

    yield* seam.submit(spec.id, {
      requestId: RequestId.make(`judge-${name}`),
      content: [{ type: "text", text: ask(spec.tool, args) }],
      entry: Option.none(),
      whenBusy: "reject",
    });
  });

/** A fresh folder holding one file with the run's nonce in it. */
const searchFolder = (name: string, nonce: string) => {
  const folder = path.join(dir, "folders", name);

  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, "notes.txt"),
    `first line\nthe marker is ${nonce} here\nlast line\n`
  );

  return folder;
};

/** What every thread that ran committed: its tool results and whether it finished. */
const report = (names: ReadonlyArray<ThreadName>) =>
  Effect.gen(function* () {
    const threads: Record<string, ThreadReport> = {};

    for (const name of names) {
      const entries = yield* entriesOf(name);

      threads[name] = {
        toolResults: entries
          .filter((entry) => entry.kind === "pi.tool-result")
          .map(entryText),
        finished: finished(entries),
        entries: entries.length,
      };
    }

    yield* print({ event: "report", life, threads });
  });

/** The nonce the `call` life wrote, or "" when the real packages were absent. */
const nonce = () =>
  existsSync(nonceFile) ? readFileSync(nonceFile, "utf-8").trim() : "";

const program = Effect.gen(function* () {
  const host = yield* PiHost;
  const brain = yield* Brain;
  const { faux } = yield* FauxModels;

  const real = host.packages.some(
    (loaded) => loaded.name === "@ff-labs/pi-fff"
  );

  faux.setResponses(Array.from({ length: 64 }, () => step));

  yield* print({
    event: "loaded",
    life,
    packages: host.packages.map((loaded) => ({
      name: loaded.name,
      version: loaded.version,
      tools: loaded.tools,
    })),
  });

  if (life === "call") {
    yield* brain.resume;

    const ran: Array<ThreadName> = [];

    if (real) {
      const marker = `cairn${String(Date.now())}nonce`;

      writeFileSync(nonceFile, marker);
      yield* start("grep", searchFolder("grep", marker), { pattern: marker });
      yield* start("content", dir, { responseId: "no-such-response" });
      ran.push("grep", "content");
      yield* awaitFinished(ran);
    }

    yield* report(ran);
    writeFileSync(path.join(dir, "hold"), "");
    yield* start("safe", dir);
    yield* start("unsafe", dir);
    yield* print({ event: "calling", life });

    // The judge kills this life; it never ends by itself.
    return yield* Effect.never;
  }

  if (life === "resume") {
    yield* brain.resume;
    yield* awaitFinished(["safe", "unsafe"]);

    const names: Array<ThreadName> = ["safe", "unsafe"];
    const marker = nonce();

    if (real && marker !== "") {
      yield* start("regrep", searchFolder("regrep", marker), {
        pattern: marker,
      });
      yield* awaitFinished(["regrep"]);
      names.push("regrep");
    }

    return yield* report(names);
  }

  // `read`: nothing resumes, so nothing runs; what the store holds is read back.
  return yield* report(
    real ? ["safe", "unsafe", "grep", "content", "regrep"] : ["safe", "unsafe"]
  );
});

const userAgent = values["user-agent"] ?? "";

const agentDir = prepareAgentDir(userAgent);

const host = PiHost.layerWith({
  policy,
  root: path.join(dir, "host"),
}).pipe(
  Layer.provide(
    PiConfig.layerWith({
      agentDir,
      cwd: path.join(dir, "pi-cwd"),
      home: path.join(dir, "home"),
    })
  )
);

NodeRuntime.runMain(
  program.pipe(Effect.provide(brainLayer(host, path.join(dir, "brain"))))
);
