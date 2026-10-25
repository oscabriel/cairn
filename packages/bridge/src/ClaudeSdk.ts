// The Agent SDK behind one Effect service (coding standard S42): the only importer of
// `@anthropic-ai/claude-agent-sdk` and `@modelcontextprotocol/sdk`. It starts Claude Code children
// from Cairn's `ChildOptions`, serves pi's tools over one in-process MCP server, decodes every SDK
// message into a `ClaudeEvent`, and reads and forks session transcripts. The MCP server is ported
// from elidickinson/pi-claude-bridge, src/mcp-server.ts at 874fa7c2678456336f23b64e784e2057e608d83e
// (MIT, Copyright (c) 2026 Eli Dickinson; notice in `ClaudeMcp.ts`): handlers go on the protocol
// server, not through the zod-only `registerTool`, so pi's JSON Schema is served verbatim.
//
// `probe` is the usage probe (2F): a child that never receives a prompt, asked for its login and the
// plan's windows. Generalized in cairn-v1 apps/server/src/claude/probe.ts at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0 (Cairn's own code) from v1 spike 1; rewritten as an Effect
// that closes the child when it ends or is interrupted. Decoding what it reads is `ClaudeUsage`'s.
//
// `layerTest` is a scripted Claude Code, ported in intent from cairn-v1 apps/server/test/fake-claude.ts
// at 1a5cd4a56e84bfb187940428d144b584d2e084b0: scripts read the prompts, call served tools the way
// Claude Code does, and emit events; every child's options and controls are recorded.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Options,
  Query,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  forkSession,
  getSessionMessages,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Predicate,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import type { Cause, Scope } from "effect";

import type { ClaudeEvent } from "./ClaudeEvents.ts";
import { decodeClaudeEvent } from "./ClaudeEvents.ts";
import type { ChildOptions } from "./ClaudeGuards.ts";
import {
  CLAUDE_MD_EXCLUDES,
  CLEANUP_PERIOD_DAYS,
  QUIET_ENV,
  refuseBuiltinTools,
  TOOL_TIMEOUT_MS,
} from "./ClaudeGuards.ts";
import { listTools, MCP_SERVER_NAME, TOOL_USE_ID_META } from "./ClaudeMcp.ts";
import type { PromptBlock, PromptMessage } from "./ClaudePrompt.ts";
import type { PromptStream } from "./ClaudePromptStream.ts";
import { openPromptStream } from "./ClaudePromptStream.ts";
import type { ClaudeToolResult } from "./ClaudeToolResults.ts";

/** A child could not be started. */
export class ClaudeStartError extends Schema.TaggedError<ClaudeStartError>()(
  "ClaudeStartError",
  {
    message: Schema.String,
    reason: Schema.Literals(["Refused", "SpawnFailed"]),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** A running child's message stream failed: the process died or the SDK threw. */
export class ClaudeQueryError extends Schema.TaggedError<ClaudeQueryError>()(
  "ClaudeQueryError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** Reading or forking a session transcript failed. */
export class ClaudeSessionError extends Schema.TaggedError<ClaudeSessionError>()(
  "ClaudeSessionError",
  {
    message: Schema.String,
    operation: Schema.Literals(["fork", "read"]),
    sessionId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** The usage probe could not read the login: the child did not start or did not initialize. */
export class ClaudeProbeError extends Schema.TaggedError<ClaudeProbeError>()(
  "ClaudeProbeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** Where and how a probe child runs. */
export interface ProbeOptions {
  readonly cwd: string;
  /** The child's environment; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is removed from it. */
  readonly env: Readonly<Record<string, string>>;
  readonly executable: Option.Option<string>;
}

/** What one probe read, raw and unchecked: the usage request's name says it will change. */
export interface RawProbe {
  /** The init answer's `account`, as Claude Code sent it. */
  readonly account: unknown;
  /** The usage answer; none when the request failed (the login is still known). */
  readonly usage: Option.Option<unknown>;
  /** Why the usage request failed, when it did. */
  readonly usageError: Option.Option<string>;
}

/** The first usage answer can come before the CLI fetched the windows; ask again this often. */
const PROBE_RETRY_DELAY = "500 millis";

/** And at most this many times. */
const PROBE_RETRIES = 10;

/** A served tool Claude Code called, by its id and pi name. */
export interface ToolCallRequest {
  readonly toolUseId: string;
  readonly name: string;
  /** Aborts when Claude Code cancels the call (`notifications/cancelled`, sent on its MCP timeout). */
  readonly signal: Option.Option<AbortSignal>;
}

/** Answers one served tool call; resolves when pi delivers the result. Never fails: an error is a result. */
export type ToolHandler = (
  call: ToolCallRequest
) => Effect.Effect<ClaudeToolResult>;

/** One running child. Closing the scope it was opened in kills it. */
export interface ClaudeQuery {
  /** Every message the child produces, decoded; ends when the child ends. Consume it once. */
  readonly events: Stream.Stream<ClaudeEvent, ClaudeQueryError>;
  /** The child's input. */
  readonly input: PromptStream;
  /** Asks the child to stop its turn. */
  readonly interrupt: Effect.Effect<void>;
  /** Kills the child. */
  readonly close: Effect.Effect<void>;
}

/** One entry of a session transcript's chain, as far as a resume needs it. */
export interface SessionEntry {
  readonly uuid: string;
  readonly role: "user" | "assistant" | "system";
  /** Tool calls an assistant entry made. */
  readonly toolUseIds: ReadonlyArray<string>;
  /** Tool calls a user entry answers. */
  readonly toolResultIds: ReadonlyArray<string>;
}

const ContentBlock = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  tool_use_id: Schema.optional(Schema.String),
});

const SessionMessageBody = Schema.Struct({
  content: Schema.optional(
    Schema.Union([Schema.String, Schema.Array(ContentBlock)])
  ),
});

const decodeSessionBody = Schema.decodeUnknownOption(SessionMessageBody);

const blocksOf = (
  body: SessionMessage["message"]
): ReadonlyArray<typeof ContentBlock.Type> =>
  Option.match(decodeSessionBody(body), {
    onNone: () => [],
    onSome: ({ content }) =>
      content === undefined || Predicate.isString(content) ? [] : content,
  });

const SdkPackage = Schema.Struct({ version: Schema.String });

const decodeSdkPackage = Schema.decodeUnknownOption(
  Schema.fromJsonString(SdkPackage)
);

/** The pinned Agent SDK's version, read from its installed package. */
const sdkVersion = (): string => {
  const entry = fileURLToPath(
    import.meta.resolve("@anthropic-ai/claude-agent-sdk")
  );

  const text = readFileSync(
    path.join(path.dirname(entry), "package.json"),
    "utf-8"
  );

  return Option.match(decodeSdkPackage(text), {
    onNone: () => "unknown",
    onSome: ({ version }) => version,
  });
};

type SdkContent = Exclude<SDKUserMessage["message"]["content"], string>;

const sdkBlocks = (blocks: ReadonlyArray<PromptBlock>): SdkContent =>
  blocks.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: block.mediaType,
            data: block.data,
          },
        }
  );

const sdkUserMessage = (message: PromptMessage): SDKUserMessage => {
  const user: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: sdkBlocks(message.blocks) },
    parent_tool_use_id: null,
  };

  if (Option.isSome(message.priority)) {
    user.priority = message.priority.value;
  }

  return user;
};

/** The Agent SDK options for `options`; `mcp` is the in-process tool server when tools are served. */
const sdkOptions = (
  options: ChildOptions,
  mcp: Option.Option<McpServer>
): Options => {
  const sdk: Options = {
    cwd: options.cwd,
    env: { ...options.env },
    model: options.model,
    tools: [...options.builtinTools],
    settingSources: [],
    strictMcpConfig: true,
    settings: {
      disableAllHooks: true,
      autoMemoryEnabled: false,
      includeGitInstructions: false,
      claudeMdExcludes: [...CLAUDE_MD_EXCLUDES],
      cleanupPeriodDays: CLEANUP_PERIOD_DAYS,
    },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    persistSession: options.persistSession,
    systemPrompt: { type: "preset", preset: "claude_code" },
  };

  if (Option.isSome(options.append)) {
    sdk.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: options.append.value,
    };
  }

  if (Option.isSome(options.effort)) {
    sdk.effort = options.effort.value;
    // Some models default thinking display to omitted; summarized keeps thinking deltas coming.
    sdk.extraArgs = { "thinking-display": "summarized" };
  }

  if (options.thinking === "disabled") {
    sdk.thinking = { type: "disabled" };
  }

  if (Option.isSome(options.maxTurns)) {
    sdk.maxTurns = options.maxTurns.value;
  }

  if (Option.isSome(options.executable)) {
    sdk.pathToClaudeCodeExecutable = options.executable.value;
  }

  if (options.session.kind === "new") {
    if (Option.isSome(options.session.sessionId)) {
      sdk.sessionId = options.session.sessionId.value;
    }
  } else {
    sdk.resume = options.session.sessionId;
    sdk.forkSession = options.session.fork;

    if (Option.isSome(options.session.at)) {
      sdk.resumeSessionAt = options.session.at.value;
    }
  }

  if (Option.isSome(mcp)) {
    sdk.mcpServers = {
      [MCP_SERVER_NAME]: {
        type: "sdk",
        name: MCP_SERVER_NAME,
        instance: mcp.value,
        timeout: TOOL_TIMEOUT_MS,
      },
    };
  }

  return sdk;
};

/** Error text of a thrown value, for a typed error's message. */
const thrownText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "unknown failure";

/**
 * Runs an Effect from a callback the SDK owns, in the runtime of the fiber that opened the child
 * (S43): its logger, log level and tracer, and interrupted when the child's scope closes.
 */
type Runner = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

/** Serves `options.tools` to Claude Code; every call runs `onToolCall` through `run`. */
const toolServer = (
  options: ChildOptions,
  onToolCall: ToolHandler,
  run: Runner
): Option.Option<McpServer> => {
  if (options.tools.length === 0) {
    return Option.none();
  }

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  const listed = listTools(options.tools);
  const names = new Set(options.tools.map((tool) => tool.name));

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: listed.map((tool) => ({ ...tool })),
  }));

  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => {
      const { name } = request.params;
      const toolUseId: unknown = request.params._meta?.[TOOL_USE_ID_META];

      if (!names.has(name)) {
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      // Without the id the result cannot be paired with its call; refusing is safer than guessing.
      if (!Predicate.isString(toolUseId)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${name}: tools/call is missing _meta["${TOOL_USE_ID_META}"], so its result cannot be paired with the call.`,
            },
          ],
          isError: true,
        };
      }

      const result = await run(
        onToolCall({ toolUseId, name, signal: Option.some(extra.signal) })
      );

      return {
        content: result.content.map((block) => ({ ...block })),
        isError: result.isError,
      };
    }
  );

  return Option.some(server);
};

const promptIterable = (
  input: PromptStream,
  run: Runner
): AsyncIterable<SDKUserMessage> => ({
  [Symbol.asyncIterator]: () => ({
    next: async () =>
      await run(
        Effect.map(input.take, (next) =>
          Option.match(next, {
            onNone: (): IteratorResult<SDKUserMessage, undefined> => ({
              done: true,
              value: undefined,
            }),
            onSome: (message): IteratorResult<SDKUserMessage, undefined> => ({
              done: false,
              value: sdkUserMessage(message),
            }),
          })
        )
      ),
  }),
});

/** A probe child's options: no tools, no settings files, no saved session, nonessential traffic on. */
const probeSdkOptions = (options: ProbeOptions): Options => {
  const env = Object.fromEntries(
    Object.entries(options.env).filter(([key]) => key !== QUIET_ENV)
  );

  const sdk: Options = {
    cwd: options.cwd,
    env,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    settings: {
      disableAllHooks: true,
      autoMemoryEnabled: false,
      includeGitInstructions: false,
      claudeMdExcludes: [...CLAUDE_MD_EXCLUDES],
      cleanupPeriodDays: CLEANUP_PERIOD_DAYS,
    },
  };

  if (Option.isSome(options.executable)) {
    sdk.pathToClaudeCodeExecutable = options.executable.value;
  }

  return sdk;
};

/**
 * One probe over the real Agent SDK. Its prompt stream is never written, so nothing reaches the
 * API; the child is closed when the probe ends, fails or is interrupted.
 */
const realProbe = Effect.fn("ClaudeSdk.probe")(function* (
  options: ProbeOptions
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const input = yield* openPromptStream;
      const run: Runner = yield* FiberSet.makeRuntimePromise();

      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: (): Query =>
            query({
              prompt: promptIterable(input, run),
              options: probeSdkOptions(options),
            }),
          catch: (cause) =>
            new ClaudeProbeError({
              message: `Claude Code did not start: ${thrownText(cause)}`,
              cause,
            }),
        }),
        (started) =>
          Effect.andThen(
            input.fail("Usage probe ended."),
            Effect.sync(() => {
              started.close();
            })
          )
      );

      // Drain the child's messages so its output never backs up; a probe expects none.
      yield* Effect.forkScoped(
        Effect.ignore(
          Stream.runDrain(
            Stream.fromAsyncIterable(
              child,
              (cause) =>
                new ClaudeQueryError({
                  message: `Claude Code probe child failed: ${thrownText(cause)}`,
                  cause,
                })
            )
          )
        )
      );

      const init = yield* Effect.tryPromise({
        try: async () => await child.initializationResult(),
        catch: (cause) =>
          new ClaudeProbeError({
            message: `Claude Code did not initialize: ${thrownText(cause)}`,
            cause,
          }),
      });

      const account: unknown = init.account;

      const ask = Effect.tryPromise({
        try: async () =>
          await child.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(
            { skipBehaviors: true }
          ),
        catch: thrownText,
      });

      return yield* Effect.gen(function* () {
        let answer = yield* ask;

        for (
          let retry = 0;
          retry < PROBE_RETRIES &&
          (answer.rate_limits_available ||
            Predicate.isString(answer.subscription_type)) &&
          answer.rate_limits === null;
          retry += 1
        ) {
          yield* Effect.sleep(PROBE_RETRY_DELAY);
          answer = yield* ask;
        }

        return answer;
      }).pipe(
        Effect.match({
          onFailure: (failure): RawProbe => ({
            account,
            usage: Option.none(),
            usageError: Option.some(failure),
          }),
          onSuccess: (answer): RawProbe => ({
            account,
            usage: Option.some(answer),
            usageError: Option.none(),
          }),
        })
      );
    })
  );
});

const sessionEntry = (message: SessionMessage): SessionEntry => {
  const blocks = blocksOf(message.message);

  return {
    uuid: message.uuid,
    role: message.type,
    toolUseIds: blocks.flatMap((block) =>
      block.type === "tool_use" && block.id !== undefined ? [block.id] : []
    ),
    toolResultIds: blocks.flatMap((block) =>
      block.type === "tool_result" && block.tool_use_id !== undefined
        ? [block.tool_use_id]
        : []
    ),
  };
};

/** A scripted child's view of its own run. */
export interface FakeIO {
  readonly options: ChildOptions;
  /** The next message the bridge wrote to the child's input; none once it ended. */
  readonly nextPrompt: Effect.Effect<Option.Option<PromptMessage>>;
  /** Every message written to the child's input so far, in order, read or not. */
  readonly written: Effect.Effect<ReadonlyArray<PromptMessage>>;
  /** Calls a served tool the way Claude Code does, waiting for pi's result; `signal` cancels it. */
  callTool(
    name: string,
    toolUseId: string,
    signal?: AbortSignal
  ): Effect.Effect<ClaudeToolResult>;
  /** Emits SDK messages, as decoded events. */
  emit(...events: ReadonlyArray<ClaudeEvent>): Effect.Effect<void>;
  /** Appends to the fake transcript of `sessionId`. */
  record(sessionId: string, entry: SessionEntry): Effect.Effect<void>;
  /** Ends the event stream with a failure, as a child that exits mid-run does. */
  die(message: string): Effect.Effect<void>;
  /** Stops reading stdin, as a wedged Claude Code does: later writes are never taken. */
  readonly stopReading: Effect.Effect<void>;
}

/** One scripted child. The run ends when the script returns. */
export type FakeScript = (io: FakeIO) => Effect.Effect<void>;

/** What a scripted child was started with, and what was done to it. */
export interface FakeRun {
  readonly options: ChildOptions;
  readonly interrupted: number;
  readonly closed: number;
}

/** One `fork` call a scripted Claude Code received. */
export interface FakeFork {
  readonly sessionId: string;
  readonly upTo: Option.Option<string>;
}

/** One scripted usage probe: what the child answers, or how it fails or hangs. */
export type FakeProbe = Effect.Effect<RawProbe, ClaudeProbeError>;

/** The scripts and records behind `ClaudeSdk.layerTest`. */
export class ClaudeSdkScripts extends Context.Service<
  ClaudeSdkScripts,
  {
    /** One script per child, in start order; a child beyond the list fails to start. */
    readonly scripts: ReadonlyArray<FakeScript>;
    /** Every child started, in order. */
    readonly runs: Ref.Ref<ReadonlyArray<FakeRun>>;
    /** Fake transcripts by session id. */
    readonly sessions: Ref.Ref<
      ReadonlyMap<string, ReadonlyArray<SessionEntry>>
    >;
    /** Every `fork` call: the source session and the cut. */
    readonly forks: Ref.Ref<ReadonlyArray<FakeFork>>;
    /** One answer per usage probe, in order; the last repeats, and none means the probe fails. */
    readonly probes: ReadonlyArray<FakeProbe>;
    /** Every probe started, with its options. */
    readonly probed: Ref.Ref<ReadonlyArray<ProbeOptions>>;
  }
>()("cairn/bridge/ClaudeSdk/ClaudeSdkScripts") {
  /** Scripts with empty records. */
  static readonly make = (
    scripts: ReadonlyArray<FakeScript>,
    probes: ReadonlyArray<FakeProbe> = []
  ): Effect.Effect<ClaudeSdkScripts["Service"]> =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<FakeRun>>([]);

      const sessions = yield* Ref.make<
        ReadonlyMap<string, ReadonlyArray<SessionEntry>>
      >(new Map());

      const forks = yield* Ref.make<ReadonlyArray<FakeFork>>([]);

      const probed = yield* Ref.make<ReadonlyArray<ProbeOptions>>([]);

      return ClaudeSdkScripts.of({
        scripts,
        runs,
        sessions,
        forks,
        probes,
        probed,
      });
    });
}

/** Starts Claude Code children and reads their transcripts. */
export class ClaudeSdk extends Context.Service<
  ClaudeSdk,
  {
    /**
     * Starts a child. Refuses options that give Claude Code tools of its own. Closing the scope
     * kills the child. `onToolCall` answers every served tool call.
     */
    open(
      options: ChildOptions,
      onToolCall: ToolHandler
    ): Effect.Effect<ClaudeQuery, ClaudeStartError, Scope.Scope>;
    /** Copies `sessionId` up to and including `upTo` into a new session; returns its id. */
    fork(
      sessionId: string,
      upTo: Option.Option<string>,
      cwd: string
    ): Effect.Effect<string, ClaudeSessionError>;
    /** The chain of `sessionId`'s transcript; empty when the transcript is not found. */
    entries(
      sessionId: string,
      cwd: string
    ): Effect.Effect<ReadonlyArray<SessionEntry>, ClaudeSessionError>;
    /**
     * Starts a child that is sent no prompt, reads its login and the plan's windows, and closes it.
     * No timeout of its own: interrupting it closes the child.
     */
    probe(options: ProbeOptions): Effect.Effect<RawProbe, ClaudeProbeError>;
    /** The pinned Agent SDK's version. */
    readonly sdkVersion: string;
  }
>()("cairn/bridge/ClaudeSdk") {
  /** The real Agent SDK. */
  static readonly layer = Layer.sync(ClaudeSdk, () => {
    const open = Effect.fn("ClaudeSdk.open")(function* (
      options: ChildOptions,
      onToolCall: ToolHandler
    ) {
      const refused = refuseBuiltinTools(options);

      if (Option.isSome(refused)) {
        return yield* new ClaudeStartError({
          message:
            "Claude bridge refused to start a child with Claude Code tools of its own; every tool must be pi's.",
          reason: "Refused",
        });
      }

      const input = yield* openPromptStream;
      const run: Runner = yield* FiberSet.makeRuntimePromise();
      const mcp = toolServer(options, onToolCall, run);

      const child = yield* Effect.try({
        try: (): Query =>
          query({
            prompt: promptIterable(input, run),
            options: sdkOptions(options, mcp),
          }),
        catch: (cause) =>
          new ClaudeStartError({
            message: `Claude Code did not start: ${thrownText(cause)}`,
            reason: "SpawnFailed",
            cause,
          }),
      });

      const close = Effect.sync(() => {
        child.close();
      });

      yield* Effect.addFinalizer(() =>
        Effect.andThen(input.fail("Claude Code child closed."), close)
      );

      const events = Stream.fromAsyncIterable(
        child,
        (cause) =>
          new ClaudeQueryError({
            message: `Claude Code child failed: ${thrownText(cause)}`,
            cause,
          })
      ).pipe(
        Stream.map((message) => decodeClaudeEvent(message)),
        Stream.filter(Option.isSome),
        Stream.map((event) => event.value)
      );

      return {
        events,
        input,
        interrupt: Effect.ignore(
          Effect.tryPromise(async () => await child.interrupt())
        ),
        close,
      };
    });

    const fork = Effect.fn("ClaudeSdk.fork")(function* (
      sessionId: string,
      upTo: Option.Option<string>,
      cwd: string
    ) {
      const result = yield* Effect.tryPromise({
        try: async () =>
          await forkSession(
            sessionId,
            Option.match(upTo, {
              onNone: () => ({ dir: cwd }),
              onSome: (upToMessageId) => ({ dir: cwd, upToMessageId }),
            })
          ),
        catch: (cause) =>
          new ClaudeSessionError({
            message: `Forking Claude Code session ${sessionId} failed: ${thrownText(cause)}`,
            operation: "fork",
            sessionId,
            cause,
          }),
      });

      return result.sessionId;
    });

    const entries = Effect.fn("ClaudeSdk.entries")(function* (
      sessionId: string,
      cwd: string
    ) {
      const messages = yield* Effect.tryPromise({
        try: async () => await getSessionMessages(sessionId, { dir: cwd }),
        catch: (cause) =>
          new ClaudeSessionError({
            message: `Reading Claude Code session ${sessionId} failed: ${thrownText(cause)}`,
            operation: "read",
            sessionId,
            cause,
          }),
      });

      return messages.map(sessionEntry);
    });

    return ClaudeSdk.of({
      open,
      fork,
      entries,
      probe: realProbe,
      sdkVersion: sdkVersion(),
    });
  });

  /** A scripted Claude Code; needs `ClaudeSdkScripts`. */
  static readonly layerTest = Layer.effect(
    ClaudeSdk,
    Effect.gen(function* () {
      const fake = yield* ClaudeSdkScripts;
      const started = yield* Ref.make(0);
      const forks = yield* Ref.make(0);

      const updateRun = (index: number, change: (run: FakeRun) => FakeRun) =>
        Ref.update(fake.runs, (runs) =>
          runs.map((run, at) => (at === index ? change(run) : run))
        );

      const record = (sessionId: string, entry: SessionEntry) =>
        Ref.update(fake.sessions, (sessions) =>
          new Map(sessions).set(sessionId, [
            ...(sessions.get(sessionId) ?? []),
            entry,
          ])
        );

      const open = Effect.fn("ClaudeSdk.open")(function* (
        options: ChildOptions,
        onToolCall: ToolHandler
      ) {
        const refused = refuseBuiltinTools(options);

        if (Option.isSome(refused)) {
          return yield* new ClaudeStartError({
            message:
              "Claude bridge refused to start a child with Claude Code tools of its own; every tool must be pi's.",
            reason: "Refused",
          });
        }

        const index = yield* Ref.getAndUpdate(started, (n) => n + 1);
        const script = fake.scripts[index];

        if (script === undefined) {
          return yield* new ClaudeStartError({
            message: `No script for child ${index + 1}.`,
            reason: "SpawnFailed",
          });
        }

        yield* Ref.update(fake.runs, (runs) => [
          ...runs,
          { options, interrupted: 0, closed: 0 },
        ]);

        const input = yield* openPromptStream;

        const out = yield* Queue.unbounded<
          ClaudeEvent,
          ClaudeQueryError | Cause.Done
        >();

        const closed = yield* Deferred.make<true>();

        // Claude Code reads its stdin on its own, whatever the script is doing; so does this pump.
        const written = yield* Queue.unbounded<PromptMessage, Cause.Done>();
        const writtenLog = yield* Ref.make<ReadonlyArray<PromptMessage>>([]);

        const pump = yield* Effect.forkDetach(
          Effect.gen(function* () {
            let next = yield* input.take;

            while (Option.isSome(next)) {
              const message = next.value;

              yield* Ref.update(writtenLog, (log) => [...log, message]);
              yield* Queue.offer(written, message);
              next = yield* input.take;
            }

            yield* Queue.end(written);
          })
        );

        const io: FakeIO = {
          options,
          nextPrompt: Effect.option(Queue.take(written)),
          written: Ref.get(writtenLog),
          callTool: (name, toolUseId, signal) =>
            onToolCall({
              toolUseId,
              name,
              signal: Option.fromNullishOr(signal),
            }),
          emit: (...events) => Effect.asVoid(Queue.offerAll(out, events)),
          record,
          die: (message) =>
            Effect.asVoid(Queue.fail(out, new ClaudeQueryError({ message }))),
          stopReading: Fiber.interrupt(pump),
        };

        const fiber = yield* Effect.forkDetach(
          Effect.raceFirst(
            Effect.andThen(script(io), Queue.end(out)),
            Deferred.await(closed)
          )
        );

        const close = Effect.gen(function* () {
          yield* updateRun(index, (run) => ({
            ...run,
            closed: run.closed + 1,
          }));
          yield* Deferred.succeed(closed, true);
          yield* Queue.end(out);
        });

        yield* Effect.addFinalizer(() =>
          Effect.andThen(input.fail("Claude Code child closed."), close).pipe(
            Effect.andThen(Fiber.interrupt(fiber)),
            Effect.andThen(Fiber.interrupt(pump))
          )
        );

        return {
          events: Stream.fromQueue(out),
          input,
          interrupt: updateRun(index, (run) => ({
            ...run,
            interrupted: run.interrupted + 1,
          })),
          close,
        };
      });

      const fork = Effect.fn("ClaudeSdk.fork")(function* (
        sessionId: string,
        upTo: Option.Option<string>,
        _cwd: string
      ) {
        yield* Ref.update(fake.forks, (all) => [...all, { sessionId, upTo }]);

        const sessions = yield* Ref.get(fake.sessions);
        const chain = sessions.get(sessionId) ?? [];

        const cut = Option.match(upTo, {
          onNone: () => chain.length,
          onSome: (uuid) => chain.findIndex((entry) => entry.uuid === uuid) + 1,
        });

        const n = yield* Ref.getAndUpdate(forks, (count) => count + 1);
        const forked = `fork-${n + 1}-of-${sessionId}`;

        yield* Ref.update(fake.sessions, (all) =>
          new Map(all).set(forked, chain.slice(0, cut))
        );

        return forked;
      });

      const entries = Effect.fn("ClaudeSdk.entries")(function* (
        sessionId: string,
        _cwd: string
      ) {
        const sessions = yield* Ref.get(fake.sessions);

        return sessions.get(sessionId) ?? [];
      });

      const probe = Effect.fn("ClaudeSdk.probe")(function* (
        options: ProbeOptions
      ) {
        const index = yield* Ref.getAndUpdate(fake.probed, (all) => [
          ...all,
          options,
        ]).pipe(Effect.map((all) => all.length));

        const answer =
          fake.probes[Math.min(index, fake.probes.length - 1)] ??
          Effect.fail(
            new ClaudeProbeError({ message: "No scripted usage probe." })
          );

        return yield* answer;
      });

      return ClaudeSdk.of({
        open,
        fork,
        entries,
        probe,
        sdkVersion: "scripted",
      });
    })
  );
}
