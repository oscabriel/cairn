// The subagent kill judge (ADR 0028, plan 4C, subagents note section 10 and "Judges"): the real
// judge brain (`apps/server/src/judge-main.ts`, the production composition with the judge tools and
// the subagents extension) runs as a plain child process over a scratch folder, never the deployed
// unit. A parent thread spawns one subagent, the judge says Go, and the brain kills itself with
// SIGKILL at a named crash point of the child's delivery (`CAIRN_JUDGE_FAULT=subagent:<point>`,
// `apps/server/src/brain/SubagentFaults.ts`), as a `kill -9` there would. The judge starts it again
// over the same folder, reconnects, resends what it had sent, and waits until the parent, the child
// and the registry are quiet. Then it counts.
//
//   node judges/subagent-durability.ts [--case <name>]... [--bridge] [--model claude-haiku-5-5] [--keep]
//
// Cases on the judge's faux model (the default set):
// - no-crash: the baseline.
// - reporter-submitted, reporter-answered, reporter-settled, reporter-noted, reporter-woken: one
//   kill at each step of a reporter's delivery, the brief's input to the child to the parent's wake.
// - steer-recorded: after the brief's result, the user steers the child (`thread.send` on the
//   child), and the kill lands between the steer reporter's commit and the seam's submit; the judge
//   resends the steer under its request id. It asserts the kill landed there: none had fired when
//   the steer was first sent, and it fired once.
// - nudge-marked, nudge-submitted: a typed child ends without a result, and the kill lands around
//   its one nudge.
// - park: five kills at reporter-noted, so pi-durable's crash-loop guard parks the reporter; the
//   next boot's repair retries it.
// - question, question-recorded, question-routed, question-answered: question routing (ADR 0027,
//   4B). The child asks its parent with `ask_parent`; the parent's model answers it with
//   `subagent_reply` (its script names the child as `$subagent`, `fixtures/JudgeModel.ts`). The
//   kill lands after the question's record commit, after its offer to the parent is admitted, or
//   after the parent's answer commit.
// - escalate, question-escalated: the parent escalates the question instead; the judge answers
//   the card in the parent thread as the user would. The kill lands after the escalation commit.
// - relay, relayed-asked, relayed-routed, relayed-answered, relayed-answer-submitted: the child's
//   final answer ends in a question (its brief says it, `say`), so its reporter relays it to the
//   parent as a question of its own (ADR 0027) and the parent answers it with `subagent_reply`. The
//   kill lands after the commit that puts the reporter in `ask`, after the offer to the parent is
//   admitted, after the `answer` checkpoint, or after the answer is admitted to the child.
// - control-*: the broken controls. `freshIds`, a reporter that mints a fresh request id for each
//   submit on every attempt (`CAIRN_JUDGE_SUBAGENT_FAULTS=freshIds`): with no kill it delivers once
//   and passes; with a kill after the child's input or the wake was submitted it must fail by
//   delivering more than once. `deliverTwice`, the conformance suite's mutation (a reporter whose
//   note and wake ids are minted fresh, twice): it must fail by delivering twice. Each must fail by
//   that and by nothing else, or the judge proves nothing. `seamOwnIds` (control-steer-recorded),
//   a seam that submits the steer under an id of its own rather than its reporter's: killed at
//   steer-recorded, the reporter's resumed submit and the resent steer both land, so it must fail by
//   the child receiving the steer twice. `freshQuestionIds` (control-question-routed), a route
//   that offers the question under a fresh request id on every attempt: killed at question-routed,
//   the rerun offers it again, so it must fail by the parent being asked twice;
//   control-relayed-routed plants it in the reporter's relay, killed at relayed-routed, and must
//   fail the same way.
//
// `--bridge` runs bridge-reporter-answered instead: parent and child on the Claude bridge
// (`judge-main.ts --models real`, the model `--model` names), killed after the child's real answer
// and before its settlement. It uses the real home for Claude Code's login and a scratch folder
// under `~/cairn-judges`, removed afterwards with the transcripts Claude Code wrote for it. The
// Claude Code plan bills nothing; at API list price a run is a few cents.
//
// Per case it asserts: one child (one registry item, one child row); each input reached the child
// once (the brief, and the steer or the nudge) and the child answered each once; for a question,
// one question record settled accepted, the parent asked once and replying once, the child given
// the answer once (by `ask_parent`'s result, or for a relay as its next input), and for an escalation one mirror and one index entry, both settled; one note per
// settlement, under its `seq`; one wake for a settlement that wakes and none for a steer's quiet
// one; every settlement delivered; the parent's tally of its child; the kill fired as many times as
// asked; for park, that a boot repair retried a parked subagent task. Prints one JSON line per case
// and a summary line; exits 0 when every real case passes and the control fails as it must.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { approvalRecordsOf } from "@cairn/client-logic/PendingRequests";
import { CommandId, ProjectId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import { RootWorkspace } from "@cairn/protocol/Launch";
import type { CairnRpcs } from "@cairn/protocol/Rpc";
import type { ShellSnapshot, ThreadShell } from "@cairn/protocol/Shell";
import { ProjectCreate } from "@cairn/protocol/ShellCommands";
import {
  ESCALATIONS_DOCUMENT,
  EscalationsDocument,
  SUBAGENT_RESULT_ENTRY,
  SubagentsDocument,
} from "@cairn/protocol/Subagents";
import type { SubagentRecord, SubagentTally } from "@cairn/protocol/Subagents";
import type { ConversationView, Entry } from "@cairn/protocol/Thread";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Clock,
  Console,
  Duration,
  Effect,
  Exit,
  Option,
  Predicate,
  Random,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import type { RpcClient, RpcClientError, RpcGroup } from "effect/rpc";

import { renderWake } from "../apps/server/src/brain/SubagentText.ts";
import { projectIdFor } from "../apps/server/src/shell/ShellCommands.ts";
import { SCRIPT_PREFIX } from "./fixtures/JudgeModel.ts";
import * as Events from "./lib/Events.ts";
import * as ProtocolClient from "./lib/ProtocolClient.ts";

const REPO = path.resolve(import.meta.dirname, "..");

const OWNER = "owner@loopback";

const ORIGIN = "http://127.0.0.1";

const { values } = parseArgs({
  options: {
    case: { type: "string", multiple: true },
    bridge: { type: "boolean", default: false },
    model: { type: "string", default: "claude-haiku-5-5" },
    keep: { type: "boolean", default: false },
  },
});

/** What the parent asks its child to do. */
type Errand = "plain" | "steer" | "nudge" | "question" | "escalate" | "relay";

interface CaseSpec {
  readonly name: string;
  /** The crash point, `<point>` or `<point>*<times>`; none for a run with no kill. */
  readonly crash: Option.Option<string>;
  readonly errand: Errand;
  /** The broken reporter a control plants (`CAIRN_JUDGE_SUBAGENT_FAULTS`); none for a real case. */
  readonly fault: Option.Option<
    "freshIds" | "deliverTwice" | "seamOwnIds" | "freshQuestionIds"
  >;
  /** What the case must end in: a pass, or (a control) a double delivery and nothing else. */
  readonly expect: "pass" | "double";
  readonly bridge: boolean;
  /** Expect a boot repair to have retried a parked subagent task. */
  readonly park: boolean;
}

const spec = (
  name: string,
  fields: Partial<Omit<CaseSpec, "name" | "crash">> & {
    readonly crash?: string;
  } = {}
): CaseSpec => ({
  name,
  errand: "plain",
  fault: Option.none(),
  expect: "pass",
  bridge: false,
  park: false,
  ...fields,
  crash: Option.fromUndefinedOr(fields.crash),
});

/** A real case killed once at `point`, named after it. */
const killedAt = (point: string) => spec(point, { crash: point });

const FAUX_CASES: ReadonlyArray<CaseSpec> = [
  spec("no-crash"),
  killedAt("reporter-submitted"),
  killedAt("reporter-answered"),
  killedAt("reporter-settled"),
  killedAt("reporter-noted"),
  killedAt("reporter-woken"),
  spec("steer-recorded", { crash: "steer-recorded", errand: "steer" }),
  spec("nudge-marked", { crash: "nudge-marked", errand: "nudge" }),
  spec("nudge-submitted", { crash: "nudge-submitted", errand: "nudge" }),
  spec("park", { crash: "reporter-noted*5", park: true }),
  spec("question", { errand: "question" }),
  spec("question-recorded", {
    crash: "question-recorded",
    errand: "question",
  }),
  spec("question-routed", { crash: "question-routed", errand: "question" }),
  spec("question-answered", {
    crash: "question-answered",
    errand: "question",
  }),
  spec("escalate", { errand: "escalate" }),
  spec("question-escalated", {
    crash: "question-escalated",
    errand: "escalate",
  }),
  spec("relay", { errand: "relay" }),
  spec("relayed-asked", { crash: "relayed-asked", errand: "relay" }),
  spec("relayed-routed", { crash: "relayed-routed", errand: "relay" }),
  spec("relayed-answered", { crash: "relayed-answered", errand: "relay" }),
  spec("relayed-answer-submitted", {
    crash: "relayed-answer-submitted",
    errand: "relay",
  }),
  spec("control-no-crash", { fault: Option.some("freshIds") }),
  spec("control-reporter-submitted", {
    crash: "reporter-submitted",
    fault: Option.some("freshIds"),
    expect: "double",
  }),
  spec("control-reporter-woken", {
    crash: "reporter-woken",
    fault: Option.some("freshIds"),
    expect: "double",
  }),
  spec("control-steer-recorded", {
    crash: "steer-recorded",
    errand: "steer",
    fault: Option.some("seamOwnIds"),
    expect: "double",
  }),
  spec("control-deliver-twice", {
    fault: Option.some("deliverTwice"),
    expect: "double",
  }),
  spec("control-question-routed", {
    crash: "question-routed",
    errand: "question",
    fault: Option.some("freshQuestionIds"),
    expect: "double",
  }),
  spec("control-relayed-routed", {
    crash: "relayed-routed",
    errand: "relay",
    fault: Option.some("freshQuestionIds"),
    expect: "double",
  }),
];

const BRIDGE_CASES: ReadonlyArray<CaseSpec> = [
  spec("bridge-reporter-answered", {
    crash: "reporter-answered",
    bridge: true,
  }),
];

/** How long one case may take to go quiet, kills and restarts included. */
const caseTimeout = (bridge: boolean) =>
  bridge ? Duration.minutes(5) : Duration.seconds(150);

/** How long the parent, child and registry must hold still before the judge counts. */
const QUIET_FOR = Duration.seconds(2);

const UP_TIMEOUT = Duration.seconds(60);

/** More lives than any case's kills need: a brain that keeps dying is a crash loop. */
const MAX_LIVES = 12;

/** The faux child's work, as a judge script line (the brief's task). */
const FAUX_TASK = `${SCRIPT_PREFIX} text 30`;

/** The faux steer: a short reply, its result a quiet note. */
const FAUX_STEER = `${SCRIPT_PREFIX} text 10`;

/** The child's description, which its question and its wake name. */
const DESCRIPTION = "Count for the judge";

/** The answer the parent (or the user, for an escalation) gives the child's question. */
const ANSWER = "blue";

/** What the user is told when the parent escalates. */
const ESCALATE_REASON = "The judge asks the user.";

/**
 * The child's question: its words, then on a line of its own the script the parent's model runs
 * when the question reaches it (`renderQuestion` puts it after "asks: ").
 */
const questionOf = (errand: Errand) =>
  `Which colour?\n${SCRIPT_PREFIX} tool subagent_reply ${JSON.stringify(
    errand === "escalate"
      ? { subagent: "$subagent", escalate: ESCALATE_REASON }
      : { subagent: "$subagent", answer: ANSWER }
  )}`;

/**
 * The relay errand's child's final answer: a lead line, the parent's script on a line of its own,
 * and a question last, so `needsDecision` relays it. No `;`, which ends a script step.
 */
const RELAYED_ANSWER = `Pick one for the count.\n${SCRIPT_PREFIX} tool subagent_reply ${JSON.stringify(
  { subagent: "$subagent", answer: ANSWER }
)}\nWhich colour?`;

/** What a relayed question's answer reaches the child as, as `renderAnswer` begins it. */
const RELAYED_ANSWER_LEAD = "The parent answered:";

/** The input the parent is asked a question with, as `renderQuestion` begins it. */
const QUESTION_LEAD = `Subagent "${DESCRIPTION}" asks:`;

const TYPED_SCHEMA = {
  type: "object",
  properties: { count: { type: "number" } },
  required: ["count"],
};

/** The faux child's brief: its script line. */
const briefOf = (errand: Errand): string => {
  if (errand === "question" || errand === "escalate") {
    return `${SCRIPT_PREFIX} tool ask_parent ${JSON.stringify({
      question: questionOf(errand),
    })}`;
  }

  return errand === "relay"
    ? `${SCRIPT_PREFIX} say ${JSON.stringify(RELAYED_ANSWER)}`
    : FAUX_TASK;
};

/** The parent's first message: spawn one child, then wait. */
const parentMessage = (errand: Errand, bridge: boolean): string => {
  if (bridge) {
    return 'Call the subagent_spawn tool exactly once, with description "Name three colours" and brief "Reply with exactly three colour names, comma separated, and nothing else. Use no tools." After the tool returns, reply with the single word waiting.';
  }

  const brief = briefOf(errand);

  const args =
    errand === "nudge"
      ? {
          description: DESCRIPTION,
          brief: `${SCRIPT_PREFIX} text 5`,
          result_schema: TYPED_SCHEMA,
        }
      : { description: DESCRIPTION, brief };

  return `${SCRIPT_PREFIX} tool subagent_spawn ${JSON.stringify(args)}`;
};

// The brain under test.

interface Brain {
  readonly dir: string;
  readonly dataDir: string;
  readonly project: string;
  readonly events: string;
  readonly marker: string;
  readonly env: Readonly<Record<string, string>>;
  readonly bridge: boolean;
  /** The current life, if one runs. */
  life: Option.Option<{ readonly child: ChildProcess; readonly port: number }>;
  lives: number;
}

const isAlive = (child: ChildProcess) =>
  child.exitCode === null && child.signalCode === null;

/** Waits until `child` exits; at once when it already did. */
const exited = (child: ChildProcess) =>
  Effect.callback<true>((resume) => {
    if (!isAlive(child)) {
      resume(Effect.succeed(true));

      return;
    }

    child.once("exit", () => {
      resume(Effect.succeed(true));
    });
  });

/** A fresh scratch folder for one case, and the brain's settings over it. */
const makeBrain = (caseSpec: CaseSpec): Brain => {
  const base = caseSpec.bridge
    ? path.join(os.homedir(), "cairn-judges")
    : os.tmpdir();

  mkdirSync(base, { recursive: true });

  const dir = mkdtempSync(path.join(base, `cairn-subagent-${caseSpec.name}-`));

  const dataDir = path.join(dir, "data");
  const project = path.join(dir, "project");

  mkdirSync(dataDir);
  mkdirSync(project);

  const events = path.join(dir, "events.log");

  return {
    dir,
    dataDir,
    project,
    events,
    marker: path.join(dataDir, "subagent-fault-fired"),
    bridge: caseSpec.bridge,
    life: Option.none(),
    lives: 0,
    env: {
      // A faux brain's home is the case's folder, so FolderRules admits the project beside it; a
      // bridge brain needs the real home for Claude Code's login.
      HOME: caseSpec.bridge ? os.homedir() : dir,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      // The portal repairs at boot ask the user's systemd about the judge's own units.
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "",
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "",
      CAIRN_PORT: "0",
      CAIRN_ORIGIN: ORIGIN,
      CAIRN_OWNER: OWNER,
      CAIRN_DATA_DIR: dataDir,
      CAIRN_CONFIG_DIR: path.join(dir, "config"),
      CAIRN_EVENTS_LOG: events,
      CAIRN_JUDGE_FAULT: Option.match(caseSpec.crash, {
        onNone: () => "",
        onSome: (crash) => `subagent:${crash}`,
      }),
      CAIRN_JUDGE_SUBAGENT_FAULTS: Option.getOrElse(caseSpec.fault, () => ""),
    },
  };
};

/** How many kills the brain's marker counts; 0 when none fired. */
const firedCount = (brain: Brain) => {
  try {
    const fired = Math.trunc(Number(readFileSync(brain.marker, "utf-8")));

    return Number.isFinite(fired) ? fired : 0;
  } catch {
    return 0;
  }
};

/** Starts a life of the brain and waits until it is ready; the port it listens on. */
const startLife = (brain: Brain) =>
  Effect.gen(function* () {
    const from = yield* Events.size(brain.events);

    const args = ["apps/server/src/judge-main.ts"];

    if (brain.bridge) {
      args.push("--models", "real");
    }

    const child = spawn(process.execPath, args, {
      cwd: REPO,
      env: brain.env,
      stdio: ["ignore", "ignore", "inherit"],
    });

    brain.lives += 1;

    const ready = Effect.gen(function* () {
      const port = yield* Events.waitForListening(brain.events, {
        from,
        timeout: UP_TIMEOUT,
      });

      yield* Events.waitFor(brain.events, "ready", Events.named("ready"), {
        from,
        timeout: UP_TIMEOUT,
      });

      return Option.some(port);
    });

    // A kill can land while the brain boots (a resumed reporter reaches its crash point before
    // `ready`): that life is over, and the caller starts the next.
    const port = yield* Effect.raceFirst(
      ready,
      exited(child).pipe(Effect.as(Option.none<number>()))
    );

    brain.life = Option.map(port, (found) => ({ child, port: found }));

    return port;
  });

/** The running life's port, starting a new life when the last one died; none if it died booting. */
const ensureUp = (brain: Brain) =>
  Option.match(
    Option.filter(brain.life, (life) => isAlive(life.child)),
    {
      onNone: () => startLife(brain),
      onSome: (life) => Effect.succeedSome(life.port),
    }
  );

/** Stops the brain cleanly (SIGTERM) and waits for it. */
const stopBrain = (brain: Brain) =>
  Effect.gen(function* () {
    for (const life of Option.toArray(brain.life)) {
      if (isAlive(life.child)) {
        life.child.kill("SIGTERM");
        yield* exited(life.child).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(10),
            orElse: () =>
              Effect.sync(() => {
                life.child.kill("SIGKILL");
              }),
          })
        );
      }
    }

    brain.life = Option.none();
  });

// The client.

type Client = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof CairnRpcs>,
  RpcClientError.RpcClientError
>;

/** A protocol client to the brain's port, in the caller's scope. */
const connect = (port: number) =>
  ProtocolClient.cairn({
    base: `http://127.0.0.1:${port}`,
    origin: ORIGIN,
    headers: { host: "127.0.0.1", "x-cairn-user": OWNER },
    openTimeout: "3 seconds",
  });

/** The shell as a fresh subscription's snapshot shows it. */
const shellOf = (client: Client) =>
  client["shell.subscribe"]({
    afterSequence: Option.none(),
    requestCompletionMarker: false,
  }).pipe(
    Stream.runHead,
    Effect.map((item) =>
      item.pipe(
        Option.flatMap((found): Option.Option<ShellSnapshot> =>
          Predicate.isTagged(found, "Snapshot")
            ? Option.some(found.snapshot)
            : Option.none()
        )
      )
    ),
    Effect.timeout("5 seconds")
  );

/** A thread's view as a fresh subscription's snapshot shows it. */
const viewOf = (client: Client, threadId: ThreadId) =>
  client["thread.subscribe"]({ threadId }).pipe(
    Stream.runHead,
    Effect.map((item) =>
      item.pipe(
        Option.flatMap((found): Option.Option<ConversationView> =>
          Predicate.isTagged(found, "Snapshot")
            ? Option.some(found.view)
            : Option.none()
        )
      )
    ),
    Effect.timeout("5 seconds")
  );

const decodeRegistry = Schema.decodeUnknownOption(SubagentsDocument);

/** The one item of the parent's registry, if the child started. */
const registryOf = (view: ConversationView) =>
  Option.match(decodeRegistry(view.docs["cairn.subagents"]), {
    onNone: (): ReadonlyArray<SubagentRecord> => [],
    onSome: (registry) => Object.values(registry.items),
  });

const ModelText = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([
    Schema.String,
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optionalKey(Schema.String),
      })
    ),
  ]),
});

const decodeModelText = Schema.decodeUnknownOption(ModelText);

/** An entry's model message: its role and its text parts joined. */
const messageOf = (entry: Entry) =>
  Option.map(decodeModelText(entry.model?.[0]), (message) => ({
    role: message.role,
    text: Predicate.isString(message.content)
      ? message.content
      : message.content
          .flatMap((part) => (part.text === undefined ? [] : [part.text]))
          .join(""),
  }));

const USER_KINDS: ReadonlySet<string> = new Set(["pi.user", "cairn.user"]);

const userTexts = (view: ConversationView) =>
  view.entries.flatMap((entry) =>
    USER_KINDS.has(entry.kind)
      ? Option.toArray(Option.map(messageOf(entry), (message) => message.text))
      : []
  );

const answers = (view: ConversationView) =>
  view.entries.filter((entry) => entry.kind === "pi.assistant");

const SettlementSeq = Schema.Struct({ seq: Schema.Int });

const decodeSeq = Schema.decodeUnknownOption(SettlementSeq);

/** The `seq` of every settlement note in the parent's transcript, in order. */
const noteSeqs = (view: ConversationView) =>
  view.entries.flatMap((entry) =>
    entry.kind === SUBAGENT_RESULT_ENTRY
      ? Option.toArray(Option.map(decodeSeq(entry.data), (found) => found.seq))
      : []
  );

const ToolResultModel = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolName: Schema.String,
});

const decodeToolResult = Schema.decodeUnknownOption(ToolResultModel);

/** The text of each result of tool `name` in `view`'s transcript, in order. */
const toolResults = (view: ConversationView, name: string) =>
  view.entries.flatMap((entry) =>
    Option.exists(
      decodeToolResult(entry.model?.[0]),
      (result) => result.toolName === name
    )
      ? Option.toArray(Option.map(messageOf(entry), (message) => message.text))
      : []
  );

const decodeEscalations = Schema.decodeUnknownOption(EscalationsDocument);

/** The entries of a parent's escalation index. */
const escalationsOf = (view: ConversationView) =>
  Option.match(decodeEscalations(view.docs[ESCALATIONS_DOCUMENT]), {
    onNone: () => [],
    onSome: (index) => Object.values(index.items),
  });

const isQuietRow = (row: ThreadShell) =>
  Option.isNone(row.activeRunId) &&
  row.queueLength === 0 &&
  Option.isNone(row.pendingRuntimeRequest) &&
  row.activity !== "running" &&
  row.activity !== "waiting" &&
  row.activity !== "preparing";

// One case.

class CaseFailed extends Schema.TaggedError<CaseFailed>()("CaseFailed", {
  message: Schema.String,
}) {}

/** What the judge holds across a case's lives: its fixed ids, and what it sent. */
interface Plan {
  readonly projectCommand: CommandId;
  readonly launchCommand: CommandId;
  readonly threadId: ThreadId;
  readonly launchRequest: RequestId;
  readonly steerRequest: RequestId;
  steered: boolean;
  /** The kills that had fired when the judge first sent the steer; none before it was sent. */
  firedAtSteer: Option.Option<number>;
  /** Where the case stood at its last full read, for a case that never goes quiet. */
  lastSeen: string;
}

/** What one quiet read found. */
interface Reading {
  readonly parentView: ConversationView;
  readonly childView: ConversationView;
  readonly items: ReadonlyArray<SubagentRecord>;
  readonly childRows: number;
  readonly parentRow: ThreadShell;
}

const hex = (value: number, width: number) =>
  value.toString(16).padStart(width, "0");

const uuid7 = Effect.gen(function* () {
  const time = hex(yield* Clock.currentTimeMillis, 12);

  const parts = yield* Effect.forEach([0, 1, 2, 3, 4], () =>
    Random.nextIntBetween(0, 0xff_ff)
  );

  const [a = 0, b = 0, c = 0, d = 0, e = 0] = parts;

  return [
    time.slice(0, 8),
    time.slice(8, 12),
    `7${hex(a % 0x10_00, 3)}`,
    hex(0x80_00 + (b % 0x40_00), 4),
    `${hex(c, 4)}${hex(d, 4)}${hex(e, 4)}`,
  ].join("-");
});

/** A request id from a uuid, as the protocol's `RequestId` takes it. */
const requestOf = (id: string) =>
  RequestId.make(`req_${id.replaceAll("-", "")}`);

const makePlan = Effect.gen(function* () {
  return {
    projectCommand: CommandId.make(yield* uuid7),
    launchCommand: CommandId.make(yield* uuid7),
    threadId: ThreadId.make(yield* uuid7),
    launchRequest: requestOf(yield* uuid7),
    steerRequest: requestOf(yield* uuid7),
    steered: false,
    firedAtSteer: Option.none(),
    lastSeen: "nothing read",
  } satisfies Plan;
});

/** Creates the project and launches the parent, with the case's fixed ids: a resend lands once. */
const launch = (client: Client, brain: Brain, caseSpec: CaseSpec, plan: Plan) =>
  Effect.gen(function* () {
    yield* client["shell.dispatch"](
      ProjectCreate.make({
        commandId: plan.projectCommand,
        workspaceRoot: brain.project,
        title: Option.some("subagent durability"),
      })
    ).pipe(Effect.ignore);

    yield* client["thread.launch"]({
      commandId: plan.launchCommand,
      threadId: plan.threadId,
      projectId: ProjectId.make(projectIdFor(plan.projectCommand)),
      title: Option.some("subagent durability"),
      model: caseSpec.bridge
        ? { provider: "claude-bridge", modelId: values.model }
        : { provider: "faux", modelId: "scripted" },
      thinkingLevel: "off",
      runtimeMode: "full-access",
      workspace: RootWorkspace.make({ branch: Option.none() }),
      initialMessage: {
        requestId: plan.launchRequest,
        text: parentMessage(caseSpec.errand, caseSpec.bridge),
        attachments: [],
        skillRefs: [],
      },
    }).pipe(Effect.ignore);
  });

/** Go on a brief the parent's row shows, as the user would; an answered one is left as it is. */
const goOnBrief = (client: Client, plan: Plan, parentRow: ThreadShell) =>
  Effect.forEach(
    Option.toArray(
      Option.filter(
        parentRow.pendingRuntimeRequest,
        (request) => request.kind === "brief"
      )
    ),
    (request) =>
      client["thread.respond"]({
        threadId: plan.threadId,
        approvalId: request.id,
        decision: "accept",
        reason: Option.none(),
        answers: Option.none(),
        launch: Option.none(),
      }).pipe(Effect.ignore),
    { discard: true }
  );

/**
 * The user's answer to an escalated question, from the card in the parent thread; an answered one
 * is left as it is. Only the escalate errand has one: a question the parent answers never reaches
 * the user.
 */
const answerEscalation = (
  client: Client,
  caseSpec: CaseSpec,
  plan: Plan,
  parentRow: ThreadShell
) =>
  Effect.forEach(
    Option.toArray(
      Option.filter(
        parentRow.pendingRuntimeRequest,
        (request) =>
          caseSpec.errand === "escalate" && request.kind === "user-input"
      )
    ),
    (request) =>
      client["thread.respond"]({
        threadId: plan.threadId,
        approvalId: request.id,
        decision: "accept",
        reason: Option.none(),
        answers: Option.some([{ index: 0, picks: [], custom: ANSWER }]),
        launch: Option.none(),
      }).pipe(Effect.ignore),
    { discard: true }
  );

/** The user's steer, once the brief's result is delivered, under one request id in every life. */
const steerOnce = (
  client: Client,
  brain: Brain,
  caseSpec: CaseSpec,
  plan: Plan,
  item: SubagentRecord
) =>
  Effect.gen(function* () {
    if (
      caseSpec.errand !== "steer" ||
      plan.steered ||
      item.status !== "settled" ||
      item.delivered < 1
    ) {
      return false;
    }

    if (Option.isNone(plan.firedAtSteer)) {
      plan.firedAtSteer = Option.some(firedCount(brain));
    }

    yield* client["thread.send"]({
      threadId: item.threadId,
      input: {
        requestId: plan.steerRequest,
        text: FAUX_STEER,
        attachments: [],
        skillRefs: [],
      },
      whenBusy: "followUp",
    });

    plan.steered = true;

    return true;
  });

/** One read of the case: the reading, whether it is quiet, and a key that changes with progress. */
const readCase = (
  client: Client,
  brain: Brain,
  caseSpec: CaseSpec,
  plan: Plan
) =>
  Effect.gen(function* () {
    const shell = yield* shellOf(client);

    const parentRow = Option.flatMap(shell, (found) =>
      Option.fromUndefinedOr(
        found.threads.find((thread) => thread.id === plan.threadId)
      )
    );

    if (Option.isNone(parentRow)) {
      return Option.none();
    }

    yield* goOnBrief(client, plan, parentRow.value);
    yield* answerEscalation(client, caseSpec, plan, parentRow.value);

    const parentView = yield* viewOf(client, plan.threadId);

    const items = Option.match(parentView, {
      onNone: (): ReadonlyArray<SubagentRecord> => [],
      onSome: registryOf,
    });

    const [item] = items;

    if (Option.isNone(parentView) || item === undefined) {
      return Option.none();
    }

    if (yield* steerOnce(client, brain, caseSpec, plan, item)) {
      return Option.none();
    }

    const childView = yield* viewOf(client, item.threadId);

    if (Option.isNone(childView)) {
      return Option.none();
    }

    const childRows = Option.match(shell, {
      onNone: (): ReadonlyArray<ThreadShell> => [],
      onSome: (found) =>
        found.threads.filter((thread) =>
          Option.exists(
            thread.lineage,
            (lineage) => lineage.parentThreadId === plan.threadId
          )
        ),
    });

    const quiet =
      item.status === "settled" &&
      item.settlements.length > 0 &&
      item.delivered === item.settlements.length &&
      (caseSpec.errand !== "steer" || plan.steered) &&
      isQuietRow(parentRow.value) &&
      childRows.every(isQuietRow);

    plan.lastSeen = JSON.stringify({
      item: item.status,
      settlements: item.settlements.length,
      delivered: item.delivered,
      parent: {
        activity: parentRow.value.activity,
        running: Option.isSome(parentRow.value.activeRunId),
        queue: parentRow.value.queueLength,
        request: Option.getOrNull(parentRow.value.pendingRuntimeRequest),
      },
      children: childRows.map((row) => ({
        activity: row.activity,
        running: Option.isSome(row.activeRunId),
        queue: row.queueLength,
        request: Option.getOrNull(row.pendingRuntimeRequest),
      })),
    });

    const key = JSON.stringify([
      parentView.value.entries.length,
      childView.value.entries.length,
      item.settlements.length,
      item.delivered,
      parentRow.value.activity,
      parentRow.value.subagents,
    ]);

    return Option.some({
      quiet,
      key,
      reading: {
        parentView: parentView.value,
        childView: childView.value,
        items,
        childRows: childRows.length,
        parentRow: parentRow.value,
      } satisfies Reading,
    });
  });

/**
 * One pass on one connection: everything the judge sends is sent again with the same ids (a resend
 * after a restart lands once), then it reads until the parent, the child and the registry have been
 * quiet for `QUIET_FOR` (no entry, settlement or row change). A dropped connection fails the pass;
 * the caller starts the next life.
 */
const onePass = (
  client: Client,
  brain: Brain,
  caseSpec: CaseSpec,
  plan: Plan
) =>
  Effect.gen(function* () {
    yield* launch(client, brain, caseSpec, plan);

    let quietSince = Option.none<number>();
    let lastKey = "";

    while (true) {
      yield* Effect.sleep("250 millis");

      const read = yield* readCase(client, brain, caseSpec, plan);
      const now = yield* Clock.currentTimeMillis;

      if (Option.isNone(read) || !read.value.quiet) {
        quietSince = Option.none();

        continue;
      }

      if (read.value.key !== lastKey || Option.isNone(quietSince)) {
        quietSince = Option.some(now);
        lastKey = read.value.key;

        continue;
      }

      if (now - quietSince.value >= Duration.toMillis(QUIET_FOR)) {
        return read.value.reading;
      }
    }
  });

/** Drives the case through every life until it is quiet; then the reading. */
const drive = (brain: Brain, caseSpec: CaseSpec, plan: Plan) =>
  Effect.gen(function* () {
    while (true) {
      const up = yield* ensureUp(brain);

      if (Option.isNone(up)) {
        if (brain.lives > MAX_LIVES) {
          return yield* new CaseFailed({
            message: `the brain died ${brain.lives} times; the kills should have stopped`,
          });
        }

        continue;
      }

      const scope = yield* Scope.make();

      const outcome = yield* connect(up.value).pipe(
        Effect.flatMap((client) => onePass(client, brain, caseSpec, plan)),
        Scope.provide(scope),
        Effect.result
      );

      yield* Scope.close(scope, Exit.void);

      if (Result.isSuccess(outcome)) {
        return outcome.success;
      }

      // A dead brain is the kill landing: start the next life. A live one dropped the socket or
      // timed a read out: wait a moment and read again.
      yield* Effect.sleep("200 millis");
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: caseTimeout(caseSpec.bridge),
      orElse: () =>
        Effect.fail(
          new CaseFailed({
            message: `the case did not go quiet in ${Duration.format(caseTimeout(caseSpec.bridge))}; last seen ${plan.lastSeen}`,
          })
        ),
    })
  );

/** A failed count: `double` when something happened more often than it should, else `other`. */
interface Failure {
  readonly kind: "double" | "other";
  readonly text: string;
}

const count = (
  what: string,
  found: number,
  expected: number
): ReadonlyArray<Failure> =>
  found === expected
    ? []
    : [
        {
          kind: found > expected ? "double" : "other",
          text: `${what}: ${found}, expected ${expected}`,
        },
      ];

const timesOf = (crash: Option.Option<string>) =>
  Option.match(crash, {
    onNone: () => 0,
    onSome: (found) =>
      Number(/\*(?<times>\d+)$/u.exec(found)?.groups?.times ?? 1),
  });

const sameTally = (left: SubagentTally, right: SubagentTally) =>
  left.working === right.working &&
  left.asking === right.asking &&
  left.settled === right.settled &&
  left.failed === right.failed;

/** A failed check unless `holds`, saying what was found. */
const check = (holds: boolean, text: string): ReadonlyArray<Failure> =>
  holds ? [] : [{ kind: "other", text }];

/** Every one of `statuses` is `accepted`. */
const allAccepted = (what: string, statuses: ReadonlyArray<string>) =>
  check(
    statuses.every((status) => status === "accepted"),
    `${what}: ${statuses.join(", ")}`
  );

/** The errands whose child asks its parent a question. */
const QUESTION_ERRANDS: ReadonlySet<Errand> = new Set([
  "question",
  "escalate",
  "relay",
]);

/** The inputs each errand gives the child: the brief, and the steer or the nudge. */
const INPUTS: Readonly<Record<Errand, number>> = {
  plain: 1,
  steer: 2,
  nudge: 2,
  question: 1,
  escalate: 1,
  // The brief, then the relayed question's answer.
  relay: 2,
};

/** The child's answers each errand expects; a question is a tool call of its own, then its answer. */
const ANSWERS: Readonly<Record<Errand, number>> = {
  plain: 1,
  steer: 2,
  nudge: 2,
  question: 2,
  escalate: 2,
  // The answer that asked, then the one after the parent's answer.
  relay: 2,
};

/**
 * The routing checks of a question errand: the child's one question settled accepted; the parent
 * asked once and replying once; for an escalation, one mirror settled accepted and one index entry
 * resolved; the child given the answer once.
 */
const questionChecks = (
  caseSpec: CaseSpec,
  reading: Reading
): ReadonlyArray<Failure> => {
  const escalated = caseSpec.errand === "escalate" ? 1 : 0;

  const questions = approvalRecordsOf(
    reading.childView.docs["cairn.approvals"]
  ).filter((record) => record.kind === "user-input");

  const mirrors = approvalRecordsOf(
    reading.parentView.docs["cairn.approvals"]
  ).filter((record) => record.mirrorOf !== null);

  const asked = userTexts(reading.parentView).filter((text) =>
    text.startsWith(QUESTION_LEAD)
  ).length;

  const given =
    caseSpec.errand === "relay"
      ? userTexts(reading.childView).filter((text) =>
          text.startsWith(RELAYED_ANSWER_LEAD)
        )
      : toolResults(reading.childView, "ask_parent");

  const escalations = escalationsOf(reading.parentView);

  return [
    ...count("questions the child asked", questions.length, 1),
    ...allAccepted(
      "the child's question settled",
      questions.map((record) => record.status)
    ),
    ...count("times the parent was asked", asked, 1),
    ...count(
      "replies the parent gave",
      toolResults(reading.parentView, "subagent_reply").length,
      1
    ),
    ...count("mirrors in the parent", mirrors.length, escalated),
    ...allAccepted(
      "the mirror settled",
      mirrors.map((record) => record.status)
    ),
    ...count("escalations indexed", escalations.length, escalated),
    ...check(
      escalations.every((entry) => entry.status === "resolved"),
      `an escalation is still ${escalations.map((entry) => entry.status).join(", ")}`
    ),
    ...count("answers the child was given", given.length, 1),
    ...check(
      given.every((text) => text.includes(ANSWER)),
      `the child was given ${JSON.stringify(given)}, not ${ANSWER}`
    ),
  ];
};

/** Every check of one quiet reading. */
const judge = (
  caseSpec: CaseSpec,
  brain: Brain,
  plan: Plan,
  reading: Reading,
  retried: number
): ReadonlyArray<Failure> => {
  const steer = caseSpec.errand === "steer";
  const nudge = caseSpec.errand === "nudge";
  const [item] = reading.items;
  const settlements = steer ? 2 : 1;

  const notes = noteSeqs(reading.parentView);

  const wakeText = item === undefined ? "" : renderWake(item.description);

  const wakes = userTexts(reading.parentView).filter(
    (text) => text === wakeText
  ).length;

  const childInputs = userTexts(reading.childView).length;

  const expectedTally: SubagentTally = {
    working: 0,
    asking: 0,
    settled: nudge ? 0 : 1,
    failed: nudge ? 1 : 0,
  };

  const failures: Array<Failure> = [
    ...count("registry items", reading.items.length, 1),
    ...count("child rows", reading.childRows, 1),
    ...count("inputs the child received", childInputs, INPUTS[caseSpec.errand]),
    ...count(
      "answers the child gave",
      answers(reading.childView).length,
      ANSWERS[caseSpec.errand]
    ),
    ...count("settlements", item?.settlements.length ?? 0, settlements),
    ...count("settlements delivered", item?.delivered ?? 0, settlements),
    ...Array.from({ length: settlements }, (_, index) =>
      count(
        `notes for settlement ${index + 1}`,
        notes.filter((seq) => seq === index + 1).length,
        1
      )
    ).flat(),
    ...count("notes", notes.length, settlements),
    // The brief's settlement wakes the parent; a steer's is quiet.
    ...count("wakes", wakes, 1),
    ...count("kills that fired", firedCount(brain), timesOf(caseSpec.crash)),
  ];

  if (QUESTION_ERRANDS.has(caseSpec.errand)) {
    failures.push(...questionChecks(caseSpec, reading));
  }

  if (!sameTally(reading.parentRow.subagents, expectedTally)) {
    failures.push({
      kind: "other",
      text: `the parent's tally is ${JSON.stringify(reading.parentRow.subagents)}, expected ${JSON.stringify(expectedTally)}`,
    });
  }

  // A steer kill must land in the steer: none fired before the judge sent it.
  if (
    steer &&
    Option.exists(caseSpec.crash, (crash) => crash.startsWith("steer-")) &&
    !Option.contains(plan.firedAtSteer, 0)
  ) {
    failures.push({
      kind: "other",
      text: `the steer kill did not land in the steer: ${Option.getOrElse(plan.firedAtSteer, () => -1)} kills had fired when the steer was first sent`,
    });
  }

  if (caseSpec.park && retried < 1) {
    failures.push({
      kind: "other",
      text: "no boot repair retried a parked subagent task",
    });
  }

  return failures;
};

/** Parked subagent tasks retried at boot, over every life. */
const retriedAtBoot = (brain: Brain) =>
  Events.read(brain.events).pipe(
    Effect.map((events) =>
      events
        .filter(Events.named("boot_retried_subagent_tasks"))
        .reduce(
          (sum, event) =>
            sum +
            Option.getOrElse(Events.numberField(event, "retried"), () => 0),
          0
        )
    )
  );

const removeScratch = (brain: Brain) =>
  Effect.sync(() => {
    if (values.keep) {
      return;
    }

    rmSync(brain.dir, { recursive: true, force: true });

    if (brain.bridge) {
      rmSync(
        path.join(
          os.homedir(),
          ".claude",
          "projects",
          brain.project.replaceAll(/[/.]/gu, "-")
        ),
        { recursive: true, force: true }
      );
    }
  });

/** One case from a fresh folder: its JSON line. */
const runCase = (caseSpec: CaseSpec) =>
  Effect.gen(function* () {
    const brain = makeBrain(caseSpec);
    const started = yield* Clock.currentTimeMillis;
    let kills = 0;

    const outcome = yield* Effect.gen(function* () {
      const plan = yield* makePlan;
      const reading = yield* drive(brain, caseSpec, plan);
      const retried = yield* retriedAtBoot(brain);

      return judge(caseSpec, brain, plan, reading, retried);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed<ReadonlyArray<Failure>>([
          { kind: "other", text: `the case broke: ${String(cause)}` },
        ])
      ),
      // Read before the scratch folder goes.
      Effect.ensuring(
        Effect.sync(() => {
          kills = firedCount(brain);
        })
      ),
      Effect.ensuring(stopBrain(brain)),
      Effect.ensuring(removeScratch(brain))
    );

    const took = (yield* Clock.currentTimeMillis) - started;

    return {
      case: caseSpec.name,
      control: Option.isSome(caseSpec.fault),
      expect: caseSpec.expect,
      crash: Option.getOrNull(caseSpec.crash),
      pass: outcome.length === 0,
      lives: brain.lives,
      kills,
      seconds: Math.round(took / 100) / 10,
      failures: outcome,
    };
  });

/** A control case failed for its reason: a double delivery, and nothing else. */
const failedRightly = (failures: ReadonlyArray<Failure>) =>
  failures.some((failure) => failure.kind === "double") &&
  failures.every((failure) => failure.kind === "double");

const main = Effect.gen(function* () {
  const all = values.bridge ? BRIDGE_CASES : FAUX_CASES;
  const named = values.case ?? [];

  const chosen = all.filter(
    (caseSpec) => named.length === 0 || named.includes(caseSpec.name)
  );

  if (chosen.length === 0) {
    return yield* Effect.fail(
      `no case named ${named.join(", ")}; cases: ${all.map((caseSpec) => caseSpec.name).join(", ")}`
    );
  }

  const results = [];

  for (const caseSpec of chosen) {
    const result = yield* runCase(caseSpec);

    yield* Console.log(JSON.stringify(result));
    results.push(result);
  }

  const real = results.filter((result) => !result.control);

  const controlRight = results
    .filter((result) => result.control)
    .every((result) =>
      result.expect === "pass" ? result.pass : failedRightly(result.failures)
    );

  const judged = real.every((result) => result.pass) && controlRight;

  yield* Console.log(
    JSON.stringify({
      summary: true,
      pass: judged,
      cases: real.length,
      passed: real.filter((result) => result.pass).length,
      controls: results.length - real.length,
      controlFailedRightly: controlRight,
    })
  );

  if (!judged) {
    return yield* Effect.fail("the subagent kill judge failed");
  }

  return judged;
});

NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
