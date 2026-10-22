// The deployed brain's chat judge (plan, wave 2 integration: "the user can open code.gneiss.run and
// chat with API models"). It speaks the browser's wire through Caddy, from this machine's own tailnet
// node, so the route, forward_auth, the guard, the handlers and pi's model runtime are all real:
//
//   node judges/live-chat.ts [--base https://code.gneiss.run] [--model <provider>/<modelId>] [--keep]
//
// Steps: `session.hello`; `models.list` (some `opencode-go` model available, no `anthropic` model);
// `providers.status`; `settings.get`; `projects.ensureScratch`; `thread.launch` in the scratch project
// with a one-word prompt on an API model (the hello's default when it is an `opencode-go` model, else
// the first available one); then the shell stream until the thread's row is idle with an assistant
// preview. The thread is deleted afterwards unless `--keep`. One turn costs cents.
//
// Prints one JSON line: {pass, helloMs, models, anthropic, providers, model, launchMs, replyMs,
// activity, notes}. Prints no credential and no reply text.
import { parseArgs } from "node:util";

import { applyShellStreamItem } from "@cairn/client-logic/ShellReducer";
import { CommandId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import { RootWorkspace } from "@cairn/protocol/Launch";
import type { ModelListing, ModelRef } from "@cairn/protocol/Models";
import type { ShellSnapshot, ThreadShell } from "@cairn/protocol/Shell";
import { ThreadDelete } from "@cairn/protocol/ShellCommands";
import { NodeRuntime } from "@effect/platform-node";
import {
  Clock,
  Console,
  Duration,
  Effect,
  Option,
  Random,
  Ref,
  Schedule,
  Stream,
} from "effect";

import * as ProtocolClient from "./lib/ProtocolClient.ts";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "https://code.gneiss.run" },
    model: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});

const REPLY_DEADLINE = Duration.seconds(90);

const PROMPT = "Reply with the single word: ready. Use no tool.";

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

const parseModel = (text: string): Option.Option<ModelRef> => {
  const slash = text.indexOf("/");

  return slash <= 0
    ? Option.none()
    : Option.some({
        provider: text.slice(0, slash),
        modelId: text.slice(slash + 1),
      });
};

const sameModel = (listing: ModelListing, model: ModelRef) =>
  listing.provider === model.provider && listing.modelId === model.modelId;

/** The model the turn runs on: `--model`, the hello's default when it is opencode-go, or the first one. */
const chooseModel = (
  models: ReadonlyArray<ModelListing>,
  defaults: ModelRef
): Option.Option<ModelListing> => {
  const available = models.filter(
    (listing) => listing.available && listing.provider === "opencode-go"
  );

  const wanted = Option.orElse(
    Option.flatMap(Option.fromUndefinedOr(values.model), parseModel),
    () =>
      defaults.provider === "opencode-go"
        ? Option.some(defaults)
        : Option.none()
  );

  return Option.orElse(
    Option.flatMap(wanted, (model) =>
      Option.fromUndefinedOr(
        available.find((listing) => sameModel(listing, model))
      )
    ),
    () => Option.fromUndefinedOr(available[0])
  );
};

const rowOf = (shell: Option.Option<ShellSnapshot>, threadId: ThreadId) =>
  Option.flatMap(shell, (snapshot) =>
    Option.fromUndefinedOr(
      snapshot.threads.find((thread) => thread.id === threadId)
    )
  );

const isAnswered = (row: ThreadShell) =>
  row.activity === "idle" &&
  Option.isNone(row.activeRunId) &&
  Option.exists(
    row.latestVisibleMessage,
    (message) => message.role === "assistant"
  );

const program = Effect.gen(function* () {
  const notes: Array<string> = [];

  const client = yield* ProtocolClient.cairn({
    base: values.base,
    origin: values.base,
  });

  const started = yield* Clock.currentTimeMillis;
  const hello = yield* client["session.hello"]();
  const helloMs = (yield* Clock.currentTimeMillis) - started;

  const catalog = yield* client["models.list"]();
  const providers = yield* client["providers.status"]();

  yield* client["settings.get"]();

  const opencode = catalog.models.filter(
    (listing) => listing.provider === "opencode-go" && listing.available
  ).length;

  const anthropic = catalog.models.filter(
    (listing) => listing.provider === "anthropic"
  ).length;

  const chosen = chooseModel(catalog.models, hello.defaults.model);

  if (Option.isNone(chosen)) {
    return {
      pass: false,
      helloMs,
      models: opencode,
      anthropic,
      notes: ["no available opencode-go model to chat with"],
    };
  }

  const model = chosen.value;
  const scratch = yield* client["projects.ensureScratch"]();
  const threadId = ThreadId.make(yield* uuid7);
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

  const launchedAt = yield* Clock.currentTimeMillis;

  yield* client["thread.launch"]({
    commandId: yield* newCommandId,
    threadId,
    projectId: scratch.id,
    title: Option.some("Live chat judge"),
    model: { provider: model.provider, modelId: model.modelId },
    thinkingLevel: model.thinkingLevels.includes("off")
      ? "off"
      : (model.thinkingLevels[0] ?? "off"),
    runtimeMode: "full-access",
    workspace: RootWorkspace.make({ branch: Option.none() }),
    initialMessage: {
      requestId: yield* newRequestId,
      text: PROMPT,
      attachments: [],
      skillRefs: [],
    },
  });

  const launchMs = (yield* Clock.currentTimeMillis) - launchedAt;

  const answered = yield* Ref.get(shell).pipe(
    Effect.map((state) => rowOf(state, threadId)),
    Effect.repeat({
      schedule: Schedule.spaced("200 millis"),
      until: (row) =>
        Option.exists(
          row,
          (found) => isAnswered(found) || found.activity === "failed"
        ),
    }),
    Effect.timeoutOption(REPLY_DEADLINE),
    Effect.map(Option.flatten)
  );

  const replyMs = (yield* Clock.currentTimeMillis) - launchedAt;

  const activity = Option.match(answered, {
    onNone: () => "timed out",
    onSome: (row) => row.activity,
  });

  const lastError = Option.flatMap(answered, (row) => row.lastError);

  if (Option.isSome(lastError)) {
    notes.push(`lastError: ${lastError.value}`);
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
    pass:
      opencode > 0 && anthropic === 0 && Option.exists(answered, isAnswered),
    helloMs,
    models: opencode,
    anthropic,
    providers: providers.map(
      (provider) => `${provider.provider}=${provider.state}`
    ),
    model: `${model.provider}/${model.modelId}`,
    launchMs,
    replyMs,
    activity,
    notes,
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
