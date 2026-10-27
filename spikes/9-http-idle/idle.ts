// Spike 9: does Node's default HTTP timeout cut a quiet provider stream in the brain?
//   node spikes/9-http-idle/idle.ts [--quiet=330000] [--trickle=240000] [--dispatcher=brain]
//                                   [--cases=completions-body,codex-ws-body] [--label=name]
//
// A fake provider on an ephemeral loopback port, and pi-ai's own provider code pointed at it with
// the stream options pi-durable passes (Cairn's `HarnessSettings` over pi's defaults: transport
// `auto`, `maxRetryDelayMs` 60000, no `timeoutMs`, no `maxRetries`). No real provider, no
// credentials: the codex token is a made-up JWT carrying only an account id claim.
//
// Each case is one request:
// - `<path>-body`: headers and a first chunk at once, then nothing for `--quiet` ms, then the rest.
// - `<path>-headers`: nothing at all for `--quiet` ms, then the whole answer.
// - `completions-trickle`: one chunk every `--trickle` ms, three gaps, so the stream outlives the
//   timeout while no single gap does.
//
// Paths: `raw` (plain `fetch`, to name undici's error), `completions` (pi-ai `openai-completions`
// as the opencode-go provider calls it, through the openai SDK), `anthropic` (pi-ai
// `anthropic-messages`, opencode-go's Claude models, through the Anthropic SDK), `codex-sse` and
// `codex-ws` (pi-ai `openai-codex-responses` with transport `sse` and `auto`).
//
// `--dispatcher`:
// - `brain` (default): import pi-coding-agent first, as `PiModelSource` does when its layer is
//   built. That import loads npm undici, whose module body installs a default `Agent` as the
//   global dispatcher, so the brain's `fetch` runs on it.
// - `node`: import nothing extra; Node's bundled undici and its own default dispatcher.
// - `pi:<ms>`: also call pi-coding-agent's `configureHttpDispatcher(<ms>)`, as pi's CLI does with
//   its `httpIdleTimeoutMs` setting (0 disables both timeouts).
//
// Prints one JSON line per case and appends it to runs/<label>.ndjson.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = ""] = arg.replace(/^--/, "").split("=");
    return [key, value] as const;
  })
);

const QUIET_MS = Number(args.get("quiet") ?? 330_000);
const TRICKLE_MS = Number(args.get("trickle") ?? 240_000);
const DISPATCHER = args.get("dispatcher") ?? "brain";
const LABEL = args.get("label") ?? `${DISPATCHER.replace(":", "-")}-${QUIET_MS}`;

const ALL_CASES = [
  "raw-body",
  "raw-headers",
  "completions-body",
  "completions-headers",
  "completions-trickle",
  "anthropic-body",
  "anthropic-headers",
  "codex-sse-body",
  "codex-sse-headers",
  "codex-ws-body",
  "codex-ws-headers",
];
const CASES = args.get("cases")?.split(",") ?? ALL_CASES;

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, "../..");
const codingAgent = path.join(
  root,
  "apps/server/node_modules/@earendil-works/pi-coding-agent/dist"
);

// The dispatcher before any provider code runs, as in the brain.
const dispatcherSymbol = Symbol.for("undici.globalDispatcher.2");
const nodeFetch = globalThis.fetch;

if (DISPATCHER !== "node") {
  await import(path.join(codingAgent, "index.js"));
}

if (DISPATCHER.startsWith("pi:")) {
  const { configureHttpDispatcher } = await import(
    path.join(codingAgent, "core/http-dispatcher.js")
  );

  configureHttpDispatcher(Number(DISPATCHER.slice(3)));
}

const globalDispatcher = (globalThis as Record<symbol, unknown>)[dispatcherSymbol];

const environment = {
  node: process.version,
  bundledUndici: process.versions.undici,
  dispatcher: DISPATCHER,
  globalDispatcher:
    globalDispatcher === undefined
      ? "none (Node's bundled default)"
      : (globalDispatcher as object).constructor.name,
  fetchReplaced: globalThis.fetch !== nodeFetch,
  quietMs: QUIET_MS,
  trickleMs: TRICKLE_MS,
};

console.log(JSON.stringify({ environment }));

const { streamSimple: completionsStream } = await import(
  "@earendil-works/pi-ai/api/openai-completions"
);
const { streamSimple: anthropicStream } = await import(
  "@earendil-works/pi-ai/api/anthropic-messages"
);
const { streamSimple: codexStream } = await import(
  "@earendil-works/pi-ai/api/openai-codex-responses"
);
const { withOpenCodeSessionHeader } = await import(
  "@earendil-works/pi-ai/providers/opencode-headers"
);
const { OPENCODE_GO_MODELS } = await import(
  "@earendil-works/pi-ai/providers/opencode-go.models"
);
const { OPENAI_CODEX_MODELS } = await import(
  "@earendil-works/pi-ai/providers/openai-codex.models"
);
const { isRetryableAssistantError } = await import("@earendil-works/pi-ai/utils/retry");

const opencode = withOpenCodeSessionHeader({
  stream: completionsStream,
  streamSimple: completionsStream,
});
const opencodeAnthropic = withOpenCodeSessionHeader({
  stream: anthropicStream,
  streamSimple: anthropicStream,
});

// ---------------------------------------------------------------------------------------------
// The fake provider

const started = Date.now();
const since = (from: number) => Date.now() - from;
const serverLog: Array<Record<string, unknown>> = [];
const timers = new Set<NodeJS.Timeout>();

const later = (ms: number, run: () => void) => {
  const timer = setTimeout(() => {
    timers.delete(timer);
    run();
  }, ms);

  timers.add(timer);
};

const note = (caseId: string, event: string, extra: Record<string, unknown> = {}) =>
  serverLog.push({ case: caseId, event, atMs: since(started), ...extra });

const sse = (data: unknown, event?: string) =>
  `${event === undefined ? "" : `event: ${event}\n`}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

const completionsChunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  sse({
    id: "chatcmpl-spike",
    object: "chat.completion.chunk",
    created: 1,
    model: "spike",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish === null
      ? {}
      : { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
  });

const anthropicFrames = {
  head: [
    sse(
      {
        type: "message_start",
        message: {
          id: "msg_spike",
          type: "message",
          role: "assistant",
          model: "spike",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
      "message_start"
    ),
    sse(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      "content_block_start"
    ),
    sse(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } },
      "content_block_delta"
    ),
  ].join(""),
  tail: [
    sse(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
      "content_block_delta"
    ),
    sse({ type: "content_block_stop", index: 0 }, "content_block_stop"),
    sse(
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      "message_delta"
    ),
    sse({ type: "message_stop" }, "message_stop"),
  ].join(""),
};

const codexEvents = {
  head: [
    { type: "response.created", response: { id: "resp_spike", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_spike", role: "assistant", content: [] },
    },
    { type: "response.output_text.delta", output_index: 0, delta: "hello " },
  ],
  tail: [
    { type: "response.output_text.delta", output_index: 0, delta: "world" },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_spike",
        role: "assistant",
        content: [{ type: "output_text", text: "hello world" }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_spike",
        status: "completed",
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    },
  ],
};

/** The first and last part of each path's answer. */
const framesFor = (kind: string): { head: string; tail: string; type: string } => {
  if (kind === "anthropic") return { ...anthropicFrames, type: "text/event-stream" };

  if (kind.startsWith("codex")) {
    return {
      head: codexEvents.head.map((event) => sse(event)).join(""),
      tail: codexEvents.tail.map((event) => sse(event)).join(""),
      type: "text/event-stream",
    };
  }

  if (kind === "completions") {
    return {
      head: completionsChunk({ role: "assistant", content: "hello " }),
      tail: completionsChunk({ content: "world" }) + completionsChunk({}, "stop") + sse("[DONE]"),
      type: "text/event-stream",
    };
  }

  return { head: "hello ", tail: "world", type: "text/plain" };
};

/** `/<case>/...`: the case id and its path and mode. */
const routeOf = (url: string) => {
  const caseId = url.split("/")[1] ?? "";
  const mode = caseId.slice(caseId.lastIndexOf("-") + 1);

  return { caseId, kind: caseId.slice(0, caseId.lastIndexOf("-")), mode };
};

const onRequest = (req: IncomingMessage, res: ServerResponse) => {
  const { caseId, kind, mode } = routeOf(req.url ?? "");

  note(caseId, "request", { method: req.method, url: req.url });
  req.socket.once("close", () => note(caseId, "socket-closed"));
  req.resume();

  const { head, tail, type } = framesFor(kind);
  const headers = { "content-type": type, "cache-control": "no-store" };
  const write = (chunk: string, label: string) => {
    if (res.destroyed || res.writableEnded) {
      note(caseId, `${label}-not-sent`, { reason: "client gone" });
      return false;
    }

    res.write(chunk);
    note(caseId, `${label}-sent`);
    return true;
  };

  // The codex WebSocket cases fall back to SSE when the socket fails before its first event;
  // that fallback gets a plain, prompt answer.
  if (kind === "codex-ws" || mode === "fallback") {
    res.writeHead(200, headers);
    write(head + tail, "whole");
    res.end();
    return;
  }

  if (mode === "headers") {
    later(QUIET_MS, () => {
      if (res.destroyed) return note(caseId, "headers-not-sent", { reason: "client gone" });

      res.writeHead(200, headers);
      write(head + tail, "whole");
      res.end();
    });
    return;
  }

  res.writeHead(200, headers);
  res.flushHeaders();
  write(head, "head");

  if (mode === "trickle") {
    const step = (left: number) =>
      later(TRICKLE_MS, () => {
        if (left > 1) {
          if (write(kind === "completions" ? completionsChunk({ content: "." }) : ".", "trickle"))
            step(left - 1);
          return;
        }

        if (write(tail, "tail")) res.end();
      });

    step(3);
    return;
  }

  later(QUIET_MS, () => {
    if (write(tail, "tail")) res.end();
  });
};

// A minimal WebSocket server: the handshake, then unmasked text frames.
const wsFrame = (text: string) => {
  const payload = Buffer.from(text);
  const length = payload.length;
  const head =
    length < 126
      ? Buffer.from([0x81, length])
      : length < 65_536
        ? Buffer.from([0x81, 126, length >> 8, length & 0xff])
        : Buffer.concat([Buffer.from([0x81, 127]), Buffer.alloc(8)]);

  if (length >= 65_536) head.writeBigUInt64BE(BigInt(length), 2);

  return Buffer.concat([head, payload]);
};

const onUpgrade = (req: IncomingMessage, socket: Socket) => {
  const { caseId, mode } = routeOf(req.url ?? "");

  note(caseId, "ws-upgrade-request");
  socket.once("close", () => note(caseId, "ws-socket-closed"));
  socket.on("error", () => {});

  const accept = createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  const handshake = () => {
    if (socket.destroyed) return note(caseId, "ws-handshake-not-sent", { reason: "client gone" });

    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    note(caseId, "ws-handshake-sent");

    // The client's first frame is `response.create`; answer it.
    socket.once("data", () => {
      note(caseId, "ws-request-frame");

      for (const event of codexEvents.head) socket.write(wsFrame(JSON.stringify(event)));
      note(caseId, "ws-head-sent");

      later(mode === "headers" ? 0 : QUIET_MS, () => {
        if (socket.destroyed) return note(caseId, "ws-tail-not-sent", { reason: "client gone" });

        for (const event of codexEvents.tail) socket.write(wsFrame(JSON.stringify(event)));
        note(caseId, "ws-tail-sent");
      });
    });
  };

  if (mode === "headers") later(QUIET_MS, handshake);
  else handshake();
};

const server = createServer(onRequest);

server.on("upgrade", onUpgrade);
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 1_000;

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------------------------------------
// The clients

const describeError = (error: unknown): Record<string, unknown> => {
  if (!(error instanceof Error)) return { value: String(error) };

  const cause = (error as { cause?: unknown }).cause;

  return {
    name: error.name,
    constructor: error.constructor.name,
    message: error.message,
    ...("code" in error ? { code: error.code } : {}),
    ...(cause === undefined ? {} : { cause: describeError(cause) }),
  };
};

const rawCase = async (caseId: string) => {
  const from = Date.now();
  let firstByteMs: number | undefined;
  let text = "";

  try {
    const response = await fetch(`${base}/${caseId}/`);
    const headersMs = since(from);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      firstByteMs ??= since(from);
      text += decoder.decode(value, { stream: true });
    }

    return { outcome: "completed", headersMs, firstByteMs, endMs: since(from), text };
  } catch (error) {
    return { outcome: "error", firstByteMs, endMs: since(from), text, error: describeError(error) };
  }
};

const fakeCodexToken = () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_spike" } }),
    "spike",
  ].join(".");
};

const firstModel = (models: Record<string, { api: string }>, api: string) => {
  const found = Object.values(models).find((model) => model.api === api);

  if (found === undefined) throw new Error(`No ${api} model in the catalog`);
  return found;
};

const piCase = async (caseId: string) => {
  const kind = caseId.slice(0, caseId.lastIndexOf("-"));
  const baseUrl = `${base}/${caseId}`;
  const context = {
    systemPrompt: "spike",
    messages: [{ role: "user", content: "say hello", timestamp: Date.now() }],
  };
  // What pi-durable hands pi-ai: Cairn's `stream` settings over pi's defaults, plus its own keys.
  const streamOptions = {
    transport: kind === "codex-sse" ? "sse" : "auto",
    maxRetryDelayMs: 60_000,
    sessionId: `spike-${caseId}-${Date.now()}`,
    signal: new AbortController().signal,
  };

  const [streamFn, model, apiKey] =
    kind === "completions"
      ? [
          opencode.streamSimple,
          firstModel(OPENCODE_GO_MODELS, "openai-completions"),
          "sk-spike-not-a-key",
        ]
      : kind === "anthropic"
        ? [
            opencodeAnthropic.streamSimple,
            firstModel(OPENCODE_GO_MODELS, "anthropic-messages"),
            "sk-spike-not-a-key",
          ]
        : [codexStream, firstModel(OPENAI_CODEX_MODELS, "openai-codex-responses"), fakeCodexToken()];

  const from = Date.now();
  const timeline: Array<{ type: string; atMs: number }> = [];
  let last = "";

  const events = streamFn({ ...model, baseUrl }, context, { ...streamOptions, apiKey });

  for await (const event of events) {
    // Every delta is not worth a line; the first of each type and every terminal event are.
    if (event.type !== last || event.type === "done" || event.type === "error") {
      timeline.push({ type: event.type, atMs: since(from) });
    }
    last = event.type;
  }

  const message = await events.result();
  const text = message.content
    .filter((block: { type: string }) => block.type === "text")
    .map((block: { text: string }) => block.text)
    .join("");

  return {
    provider: model.provider,
    api: model.api,
    model: model.id,
    endMs: since(from),
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    retryable: message.stopReason === "error" ? isRetryableAssistantError(message) : undefined,
    text,
    diagnostics: message.diagnostics,
    timeline,
  };
};

const outDir = path.join(here, "runs");

mkdirSync(outDir, { recursive: true });

const runCase = async (caseId: string) => {
  const result = caseId.startsWith("raw-") ? await rawCase(caseId) : await piCase(caseId);
  const line = {
    label: LABEL,
    case: caseId,
    ...result,
    server: serverLog.filter((entry) => entry.case === caseId),
    environment,
    at: new Date().toISOString(),
  };

  console.log(JSON.stringify(line));
  appendFileSync(path.join(outDir, `${LABEL}.ndjson`), `${JSON.stringify(line)}\n`);
};

// Every case at once: they share the clock, so a long run takes one quiet period, not eleven.
await Promise.all(CASES.map(runCase));

for (const timer of timers) clearTimeout(timer);
server.closeAllConnections();
server.close();
// pi-ai keeps a codex WebSocket open per session for reuse; nothing else is left to wait for.
process.exit(0);
