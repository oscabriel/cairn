// Spike 1's brain: a pi-durable conversation on the Beelink whose arms are a stone on Cloudflare.
//   node brain.ts <runDir> <stoneId> [submit <case>]
//
// `HarnessOptions.env` returns the stone's RemoteExecutionEnv (stone.ts), and the registry has pi-durable's own
// bash tool, so `bash` is the stock one, `replay: "unsafe"`. A scripted model runs one case's tool calls:
//   inflight:  bash (mark, sleep 20, mark), then bash (check). The judge evicts the Workspace mid-sleep.
//   between:   pause (8 s, no arms), then bash (check). The judge evicts the Workspace during the pause.
//   brainkill: bash (mark, sleep 20, mark), then bash (check). The judge kills this process mid-sleep and starts it
//              again without `submit`.
// Every tool result and the final message go to <runDir>/events.log.
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { connect, stoneEnv } from "./stone.ts";

const [dirArg, stoneId, command, caseName] = process.argv.slice(2);
if (!dirArg || !stoneId) throw new Error("usage: brain.ts <runDir> <stoneId> [submit <case>]");
const dir = resolve(dirArg);
mkdirSync(dir, { recursive: true });
const say = (kind: string, data?: unknown) => {
	const line = JSON.stringify({ t: Date.now(), pid: process.pid, kind, data });
	console.log(line);
	appendFileSync(join(dir, "events.log"), `${line}\n`);
};

const connection = connect(stoneId, (text) => say("link", text.trim().slice(0, 300)));

const pause = defineTool({
	name: "pause",
	description: "Wait a few seconds without touching the stone.",
	parameters: Type.Object({ seconds: Type.Number() }),
	replay: "safe",
	execute: async ({ seconds }) => {
		say("pausing", seconds);
		await new Promise((done) => setTimeout(done, seconds * 1000));
		return { output: [{ type: "text", text: `paused ${seconds} s` }] };
	},
});

const mark = (name: string) =>
	`echo "start $(date +%s%N)" >> /workspace/marks-${name}; sleep 20; echo end >> /workspace/marks-${name}; echo slept`;
const check = (name: string) => `cat /workspace/marks-${name}; echo boot $(cat /proc/sys/kernel/random/boot_id)`;

const faux = fauxProvider({ provider: "faux", models: [{ id: "script" }] });
const script = (ctx: any) => {
	const messages = ctx.messages as any[];
	const first = messages.find((m) => m.role === "user");
	const name = (typeof first.content === "string" ? first.content : first.content.map((c: any) => c.text).join("")).trim();
	const results = messages.filter((m) => m.role === "toolResult").length;
	if (results === 0) {
		if (name === "between") return fauxAssistantMessage(fauxToolCall("pause", { seconds: 8 }, { id: "c1" }), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxToolCall("bash", { command: mark(name) }, { id: "c1" }), { stopReason: "toolUse" });
	}
	if (results === 1) return fauxAssistantMessage(fauxToolCall("bash", { command: check(name) }, { id: "c2" }), { stopReason: "toolUse" });
	return fauxAssistantMessage(fauxText(`done ${name}`));
};
faux.setResponses(Array.from({ length: 50 }, () => script));
const models = createModels();
models.setProvider(faux.provider);

const registry = createRegistry();
const bash = createBashTool();
registry.install(defineExtension({ name: "spike-1", tools: [bash, pause] }));
const harness = await Harness.open(
	await openNodeSqliteStorage(join(dir, "store.sqlite")),
	{
		models,
		registry,
		env: () => stoneEnv(stoneId, connection),
		onReport: (error, info) => say("report", { type: info.type, error: String(error).slice(0, 300) }),
	},
	context,
);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "script" } } });
await root.configure({ modelTools: [bash, pause] }, context);
say("open");
harness.resume();

if (command === "submit" && caseName) {
	const submission = await root.submit({ type: "input", requestId: `s1:${caseName}`, content: caseName }, context);
	say("submitted", submission.id);
}
await root.waitForIdle(context);
const messages = (await root.context(context)).messages as any[];
for (const m of messages.filter((m) => m.role === "toolResult")) {
	say("tool_result", { tool: m.toolName, isError: m.isError === true, text: m.content.map((c: any) => c.text ?? c.type).join("").slice(0, 600) });
}
say("final", messages.filter((m) => m.role === "assistant").pop()?.content?.map((c: any) => c.text ?? c.type).join(""));
say("idle");
connection.close();
await harness.close?.(context);
process.exit(0);
