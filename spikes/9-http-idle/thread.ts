// Spike 9, part two: what a thread records when the provider's stream is cut by the idle timeout.
//   node spikes/9-http-idle/thread.ts [--timeout=3000] [--quiet=6000]
//
// A bare pi-durable Harness on a scratch store (as judges/claude-live.ts opens one), with the
// brain's retry policy (pi's defaults, which the user's settings.json does not change: enabled,
// 3 retries, 2 s base delay) and Cairn's stream settings. Its one model is opencode-go's first
// `openai-completions` model, served by pi-ai's own provider code with its base URL on a fake
// server that sends a first chunk and then goes quiet. The dispatcher is pi-coding-agent's
// `configureHttpDispatcher(--timeout)`, so a 300 s cut is reproduced in seconds: idle.ts measures
// that the cut and its message are the same at 300 s under the brain's default dispatcher.
//
// Prints the transcript entries and the submission's settlement as JSON.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { withOpenCodeSessionHeader } from "@earendil-works/pi-ai/providers/opencode-headers";
import { OPENCODE_GO_MODELS } from "@earendil-works/pi-ai/providers/opencode-go.models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = ""] = arg.replace(/^--/, "").split("=");
    return [key, value] as const;
  })
);

const TIMEOUT_MS = Number(args.get("timeout") ?? 3_000);
const QUIET_MS = Number(args.get("quiet") ?? 6_000);

const here = path.dirname(new URL(import.meta.url).pathname);
const { configureHttpDispatcher } = await import(
  path.join(
    here,
    "../../apps/server/node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js"
  )
);

configureHttpDispatcher(TIMEOUT_MS);

const started = Date.now();
const since = () => Date.now() - started;
const requests: Array<{ atMs: number; closedAtMs?: number }> = [];

const chunk = (delta: Record<string, unknown>) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-spike",
    object: "chat.completion.chunk",
    created: 1,
    model: "spike",
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`;

const server = createServer((req, res) => {
  const request: { atMs: number; closedAtMs?: number } = { atMs: since() };

  requests.push(request);
  req.resume();
  req.socket.once("close", () => {
    request.closedAtMs = since();
  });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(chunk({ role: "assistant", content: `attempt ${requests.length} says hello ` }));
  // Never finishes: every attempt goes quiet past the timeout.
  setTimeout(() => res.destroyed || res.end(), QUIET_MS).unref();
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const { port } = server.address() as AddressInfo;
const template = Object.values(OPENCODE_GO_MODELS).find(
  (model) => model.api === "openai-completions"
)!;

process.env.SPIKE_API_KEY = "sk-spike-not-a-key";

const provider = createProvider({
  id: "spike-opencode",
  auth: {
    apiKey: {
      name: "spike",
      resolve: async () => ({ auth: { apiKey: "sk-spike-not-a-key" }, source: "spike" }),
    },
  } as never,
  models: [{ ...template, provider: "spike-opencode", baseUrl: `http://127.0.0.1:${port}/v1` }],
  api: { "openai-completions": withOpenCodeSessionHeader(openAICompletionsApi()) } as never,
});

const models = createModels();

models.setProvider(provider);

const root = mkdtempSync(path.join(tmpdir(), "cairn-spike9-"));
const storage = await openNodeSqliteStorage(path.join(root, "brain.sqlite"));
const context = BACKGROUND_CONTEXT;

// What `HarnessSettings` hands pi-durable when pi's settings.json sets no retry or timeout.
const settings = {
  stream: { transport: "auto" as const, maxRetryDelayMs: 60_000 },
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 },
  afterFailedRun: "keep" as const,
};

const harness = await Harness.open(storage, { models, registry: createRegistry(), settings }, context);

try {
  const conversation = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "spike-opencode", modelId: template.id }, cwd: root },
    },
    context
  );

  const submission = await conversation.submit(
    { type: "input", content: "say hello", requestId: "spike-1" },
    context
  );
  const settled = await submission.wait(context);

  await conversation.waitForIdle(context);

  const page = await conversation.entries({ order: "ascending" }, 100, undefined, context);
  const entries = page.items.map((record) => {
    const message = record.model?.[0] as
      | { role: string; stopReason?: string; errorMessage?: string; content?: unknown }
      | undefined;

    return {
      kind: record.kind,
      role: message?.role,
      stopReason: message?.stopReason,
      errorMessage: message?.errorMessage,
      content: message?.content,
    };
  });

  console.log(
    JSON.stringify(
      {
        timeoutMs: TIMEOUT_MS,
        quietMs: QUIET_MS,
        totalMs: since(),
        requests,
        settled,
        entries,
      },
      null,
      1
    )
  );
} finally {
  await harness.close(context);
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
}
