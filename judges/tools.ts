// The Executor tools judge (plan 3D, at integration): against the deployed brain, through the
// browser's wire, on a cheap real model (the deployed brain has no faux provider), the model reaches
// Executor's apps from a code mode script. Four threads in the project of this repo:
//
//   node judges/tools.ts [--base https://code.gneiss.run] [--model <provider>/<modelId>]
//                        [--repo oscabriel/cairn] [--project ~/Developer/projects/cairn] [--keep]
//
// - Three directed turns, one per server: `convex` (a status read), `playwright` (a navigate) and
//   `github` (a read of this repo). Each passes when a committed code mode script called
//   `tools.executor_call` with a path on that server and the final answer quotes a value from the
//   script's result.
// - One open turn that names no tool: it passes when the scripts called `tools.executor_search`
//   before `tools.executor_call`, and the answer quotes the result.
//
// Prints one JSON line: {pass, model, executor, turns: [{name, pass, replyMs, calls, quoted,
// notes}]}. Prints no credential, and no answer text beyond the quoted value's length. A few cents.
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { applyShellStreamItem } from "@cairn/client-logic/ShellReducer";
import { CommandId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import type { ProjectId } from "@cairn/protocol/Ids";
import { RootWorkspace } from "@cairn/protocol/Launch";
import type { ModelListing } from "@cairn/protocol/Models";
import type { ShellSnapshot, ThreadShell } from "@cairn/protocol/Shell";
import { ProjectCreate, ThreadDelete } from "@cairn/protocol/ShellCommands";
import type { Entry } from "@cairn/protocol/Thread";
import { NodeRuntime } from "@effect/platform-node";
import {
  Clock,
  Console,
  Duration,
  Effect,
  Match,
  Option,
  Predicate,
  Random,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";

import * as ProtocolClient from "./lib/ProtocolClient.ts";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "https://code.gneiss.run" },
    model: { type: "string" },
    repo: { type: "string", default: "oscabriel/cairn" },
    project: {
      type: "string",
      default: path.join(os.homedir(), "Developer", "projects", "cairn"),
    },
    keep: { type: "boolean", default: false },
  },
});

const REPLY_DEADLINE = Duration.minutes(4);

const RULES =
  "Use code mode; reach the user's apps through Executor's tools (tools.executor_search, tools.executor_describe, tools.executor_call). Answer in two sentences and quote the exact value you got.";

interface Turn {
  readonly name: string;
  readonly prompt: string;
  /** The app a call path must name; none for the open turn. */
  readonly app: Option.Option<string>;
}

const TURNS: ReadonlyArray<Turn> = [
  {
    name: "convex",
    prompt: `Through Executor's convex app, read the status of my Convex deployment (any status or info tool). ${RULES}`,
    app: Option.some("convex"),
  },
  {
    name: "playwright",
    prompt: `Through Executor's playwright app, navigate a browser to https://example.com and tell me the page title. ${RULES}`,
    app: Option.some("playwright"),
  },
  {
    name: "github",
    prompt: `Through Executor's github app, read this project's repository (${values.repo}) and tell me its default branch. ${RULES}`,
    app: Option.some("github"),
  },
  {
    name: "open",
    prompt:
      "What MCP tools can you reach? Find one that can open a web page, and use it to tell me the title of https://example.com. Quote the exact value you got.",
    app: Option.none(),
  },
];

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

const newCommandId = Effect.map(uuid7, (id) => CommandId.make(id));

const newRequestId = Effect.map(uuid7, (id) =>
  RequestId.make(`req_${id.replaceAll("-", "")}`)
);

/** `--model`, else the first available opencode-go model. */
const chooseModel = (models: ReadonlyArray<ModelListing>) => {
  const firstOpenCode = models.find(
    (listing) => listing.available && listing.provider === "opencode-go"
  );

  const wanted = Option.fromUndefinedOr(values.model);

  return Option.orElse(
    Option.flatMap(wanted, (text) =>
      Option.fromUndefinedOr(
        models.find(
          (listing) =>
            listing.available &&
            `${listing.provider}/${listing.modelId}` === text
        )
      )
    ),
    () => Option.fromUndefinedOr(firstOpenCode)
  );
};

// The pi-ai messages the judge reads from committed entries.
const Part = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("toolCall"),
    name: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.Json),
  }),
  Schema.Struct({ type: Schema.String }),
]);

const Message = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(Part)]),
});

const decodeMessages = Schema.decodeUnknownOption(Schema.Array(Message));

type Message = typeof Message.Type;

const messagesOf = (entries: ReadonlyArray<Entry>) =>
  entries.flatMap((entry) =>
    Option.getOrElse(decodeMessages(entry.model ?? []), () => [])
  );

const textOf = (message: Message) =>
  Predicate.isString(message.content)
    ? message.content
    : message.content
        .flatMap((part) =>
          "text" in part && Predicate.isString(part.text) ? [part.text] : []
        )
        .join("\n");

/** Every code mode script the model committed, in order. */
const scriptsOf = (messages: ReadonlyArray<Message>) =>
  messages.flatMap((message) =>
    message.role === "assistant" && !Predicate.isString(message.content)
      ? message.content.flatMap((part) =>
          "name" in part &&
          part.name === "codemode" &&
          Predicate.isString(part.arguments.code)
            ? [part.arguments.code]
            : []
        )
      : []
  );

/** Values worth quoting from the tool results: strings and numbers of four characters or more. */
const quotable = (messages: ReadonlyArray<Message>) =>
  messages
    .filter((message) => message.role === "toolResult")
    .flatMap((message) =>
      textOf(message)
        .split(/[\s"'`,:;{}[\]()]+/u)
        .filter((word) => word.length >= 4 && !/^[a-z]+$/u.test(word))
    );

const callIndex = (scripts: ReadonlyArray<string>, tool: string) =>
  scripts.join("\n").indexOf(`tools.${tool}(`);

// The path's own quote closes it: a path may hold the other quotes (`tools["convex-mcp"].status`).
const CALL_PATH =
  /tools\.executor_call\(\s*\{[^}]*?path:\s*(?<quote>["'`])(?<path>(?:(?!\k<quote>).)+)\k<quote>/gu;

const calledPaths = (scripts: ReadonlyArray<string>) =>
  [...scripts.join("\n").matchAll(CALL_PATH)].map(
    (match) => match.groups?.path ?? ""
  );

/**
 * The names along a tool path, dotted (`tools.github.repos.get`) or bracketed
 * (`tools["cairn-bridges"].convex.status`). Executor serves the stdio servers under one source
 * (`cairn-bridges`, the stdio relay), so a server's name may be the second segment, not the first.
 */
const segmentsOf = (toolPath: string) =>
  toolPath
    .split(/[\s"'`[\].]+/u)
    .filter((part) => part !== "" && part !== "tools");

const isSettled = (row: ThreadShell) =>
  Option.isNone(row.activeRunId) &&
  (row.activity === "failed" ||
    (row.activity === "idle" &&
      Option.exists(
        row.latestVisibleMessage,
        (message) => message.role === "assistant"
      )));

const program = Effect.gen(function* () {
  const client = yield* ProtocolClient.cairn({
    base: values.base,
    origin: values.base,
  });

  yield* client["session.hello"]();

  const executor = yield* client["executor.status"]();
  const catalog = yield* client["models.list"]();
  const chosen = chooseModel(catalog.models);

  if (executor.state !== "connected" || Option.isNone(chosen)) {
    return {
      pass: false,
      executor: executor.state,
      model: Option.match(chosen, {
        onNone: () => "none available",
        onSome: (model) => `${model.provider}/${model.modelId}`,
      }),
      turns: [],
    };
  }

  const model = chosen.value;
  const shell = yield* Ref.make(Option.none<ShellSnapshot>());

  yield* client["shell.subscribe"]({
    afterSequence: Option.none(),
    requestCompletionMarker: false,
  }).pipe(
    Stream.runForEach((item) =>
      Ref.update(shell, (state) => applyShellStreamItem(state, item))
    ),
    Effect.ignore,
    Effect.forkScoped
  );

  const findProject = Ref.get(shell).pipe(
    Effect.map((state) =>
      Option.flatMap(state, (snapshot) =>
        Option.fromUndefinedOr(
          snapshot.projects.find(
            (project) =>
              project.kind === "folder" &&
              // A project registered before its repository was known matches by its folder.
              (Option.exists(
                project.repository,
                (repository) => repository.toLowerCase() === values.repo
              ) ||
                project.workspaceRoot === values.project)
          )
        )
      )
    )
  );

  const waitForProject = findProject.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("200 millis"),
      until: Option.isSome,
    }),
    Effect.timeoutOption(Duration.seconds(10)),
    Effect.map(Option.flatten)
  );

  const existing = yield* waitForProject;

  if (Option.isNone(existing)) {
    yield* client["shell.dispatch"](
      ProjectCreate.make({
        commandId: yield* newCommandId,
        workspaceRoot: values.project,
        title: Option.none(),
      })
    );
  }

  const project = Option.isSome(existing) ? existing : yield* waitForProject;

  if (Option.isNone(project)) {
    return {
      pass: false,
      executor: executor.state,
      model: `${model.provider}/${model.modelId}`,
      turns: [],
      notes: [`no project for ${values.repo} at ${values.project}`],
    };
  }

  const projectId: ProjectId = project.value.id;

  const runTurn = Effect.fn("tools.turn")(function* (turn: Turn) {
    const notes: Array<string> = [];
    const threadId = ThreadId.make(yield* uuid7);
    const started = yield* Clock.currentTimeMillis;

    yield* client["thread.launch"]({
      commandId: yield* newCommandId,
      threadId,
      projectId,
      title: Option.some(`Tools judge: ${turn.name}`),
      model: { provider: model.provider, modelId: model.modelId },
      thinkingLevel: model.thinkingLevels.includes("off")
        ? "off"
        : (model.thinkingLevels[0] ?? "off"),
      runtimeMode: "full-access",
      workspace: RootWorkspace.make({ branch: Option.none() }),
      initialMessage: {
        requestId: yield* newRequestId,
        text: turn.prompt,
        attachments: [],
        skillRefs: [],
      },
    });

    const settled = yield* Ref.get(shell).pipe(
      Effect.map((state) =>
        Option.flatMap(state, (snapshot) =>
          Option.fromUndefinedOr(
            snapshot.threads.find((thread) => thread.id === threadId)
          )
        )
      ),
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        until: (row) => Option.exists(row, isSettled),
      }),
      Effect.timeoutOption(REPLY_DEADLINE),
      Effect.map(Option.flatten)
    );

    const replyMs = (yield* Clock.currentTimeMillis) - started;

    const lastError = Option.flatMap(settled, (row) => row.lastError);

    if (Option.isSome(lastError)) {
      notes.push(`lastError: ${lastError.value.slice(0, 200)}`);
    }

    const view = yield* client["thread.subscribe"]({
      threadId,
      conversationId: Option.none(),
    }).pipe(Stream.take(1), Stream.runHead);

    const entries = Option.match(view, {
      onNone: (): ReadonlyArray<Entry> => [],
      onSome: (item) =>
        Match.value(item).pipe(
          Match.tag("Snapshot", (snapshot) => snapshot.view.entries),
          Match.orElse((): ReadonlyArray<Entry> => [])
        ),
    });

    const messages = messagesOf(entries);
    const scripts = scriptsOf(messages);
    const paths = calledPaths(scripts);

    const answer = textOf(
      messages.findLast((message) => message.role === "assistant") ?? {
        role: "assistant",
        content: "",
      }
    );

    const quoted = quotable(messages).find((word) => answer.includes(word));

    const reached = Option.match(turn.app, {
      onNone: () => {
        const search = callIndex(scripts, "executor_search");
        const call = callIndex(scripts, "executor_call");

        return search !== -1 && call !== -1 && search < call;
      },
      onSome: (app) =>
        paths.some((found) => segmentsOf(found).slice(0, 2).includes(app)),
    });

    if (!reached) {
      notes.push(
        `scripts: ${scripts.length}, executor_call paths: ${paths.join(", ") || "none"}`
      );
    }

    if (!values.keep) {
      yield* client["shell.dispatch"](
        ThreadDelete.make({ commandId: yield* newCommandId, threadId })
      ).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            notes.push(`delete failed: ${error.message}`);
          })
        )
      );
    }

    return {
      name: turn.name,
      pass: reached && quoted !== undefined,
      replyMs,
      calls: paths,
      quoted: quoted?.length ?? 0,
      notes,
    };
  });

  const turns = yield* Effect.forEach(TURNS, runTurn);

  return {
    pass: turns.every((turn) => turn.pass),
    executor: executor.state,
    model: `${model.provider}/${model.modelId}`,
    turns,
  };
});

NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.flatMap((result) =>
      Effect.andThen(Console.log(JSON.stringify(result)), () =>
        result.pass ? Effect.void : Effect.sync(() => process.exit(1))
      )
    )
  )
);
