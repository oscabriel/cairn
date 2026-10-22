// Spike 6 (direct) worker: pi-durable conversations on the unmodified upstream bridge.
// Ported from cairn-v1 spikes/01-bridge/worker.ts at 1a5cd4a56e84bfb187940428d144b584d2e084b0.
//   node --import tsx worker.ts start  <dir>   one conversation, submit the task, wait
//   node --import tsx worker.ts resume <dir>   reopen the same store, resume, wait, print the transcript
//   node --import tsx worker.ts pair   <dir>   two conversations at once; reports how many children run
// MARK_SLEEP_MS holds the tool open so a driver can kill -9 while Claude's call is held.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTool, Harness, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const [mode, dir] = process.argv.slice(2);
if (!["start", "resume", "pair"].includes(mode ?? "") || !dir) throw new Error("usage: worker.ts start|resume|pair <dir>");
mkdirSync(join(dir, "workspace"), { recursive: true });
// Upstream reads and, for its TUI notices, writes claude-bridge.json under pi's agent dir: keep it here.
mkdirSync(join(dir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");

const context = BACKGROUND_CONTEXT;
const sleepMs = Number(process.env.MARK_SLEEP_MS ?? 0);
const modelId = process.env.MODEL ?? "claude-haiku-5-5";
const say = (kind: string, data: unknown) => console.log(JSON.stringify({ t: Date.now(), pid: process.pid, kind, data }));

const before = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null;
const { loadBridge } = await import("./standin.ts");
let peak = 0;
const { provider, touched } = loadBridge(join(dir, "workspace"), {
	onChild: (info) => { peak = Math.max(peak, info.live); say("child", info); },
	onChildEnd: (live) => say("child_end", { live }),
	onHook: (event) => say("hook", event),
	log: (line) => say("bridge", line),
});
say("env", { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: { before, after: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null } });
const models = createModels();
models.setProvider(provider);

const mark = defineTool({
	name: "mark",
	description: "Record a mark with the given id. Each call has a real side effect, so call it once per id.",
	parameters: Type.Object({ id: Type.String() }),
	execute: async (args) => {
		appendFileSync(join(dir, "marks.log"), `${Date.now()} ${process.pid} ${args.id}\n`);
		say("tool_ran", args);
		if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
		return { output: [{ type: "text", text: `mark ${args.id} recorded; the code word is ${args.id.toUpperCase()}-7` }] };
	},
});
const registry = createRegistry();
registry.install(defineExtension({
	name: "spike",
	tools: [mark],
	sections: [section("preamble", () => "You are a terse assistant in a test harness. If a tool call fails or is interrupted, never call it again; report what happened instead.", { tag: false })],
}));

const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "store.sqlite")), { models, registry }, context);
say("touched", [...touched]);
const pad = Array.from({ length: Number(process.env.PAD_LINES ?? 0) }, (_, i) => `Ledger line ${i}: account ${(i * 7919) % 10007} moved ${(i * 104729) % 9973} units to bin ${i % 97}.`).join("\n");
const task = (id: string) => `Call the mark tool once with id '${id}'. Then reply with only the code word it returned.`;
const content = (id: string) => (pad ? `<ledger>\n${pad}\n</ledger>\n\nIgnore the ledger. ${task(id)}` : task(id));

async function run(name: string, id: string) {
	const conversation = await harness.root(context, { agent: { model: { provider: "claude-bridge", modelId } } }).then(async (root) =>
		name === "root" ? root : harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "claude-bridge", modelId } } }, context));
	const submission = await conversation.submit({ type: "input", requestId: `spike-6-${name}`, content: content(id) }, context);
	const settled = await submission.wait(context);
	say("settled", { name, status: settled.status });
	const view = await conversation.context(context);
	for (const message of view.messages as any[]) {
		if (message.role !== "assistant") continue;
		say("assistant", {
			name,
			stopReason: message.stopReason,
			usage: message.usage && { input: message.usage.input, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite },
			text: message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""),
			toolCalls: message.content.filter((c: any) => c.type === "toolCall").map((c: any) => c.name),
			error: message.errorMessage,
		});
	}
}

if (mode === "resume") harness.resume();
if (mode === "pair") await Promise.all([run("root", "alpha"), run("second", "beta")]);
else await run("root", "alpha");
say("peak_children", peak);
await harness.close(context);
process.exit(0);
