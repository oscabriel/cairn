// Spike 3: a workflow as a durable code-mode script.
//   node brain.ts <runDir> [submit <token>]
//
// The root conversation's scripted model writes one code-mode script, a four-node workflow:
//
//   const [scan, long, ok] = await Promise.all([agent scan, agent long, approve]);
//   const merged = await agent integrate(scan, long, ok);
//
// `agent` and `approve` are durable nested tool calls the script makes (callers: tools). `agent` runs a
// subagent conversation owned by its tool task; the subagent's own scripted model calls `work` (a
// quick, counted effect) or `job` (a long process in its own systemd user unit, so a brain kill
// doesn't end it). `approve` is spike 4's approval record. Every effect is counted in
// <runDir>/effects.log, outside pi-durable's store, so the judge can see a node that ran twice.
//
// The sandbox has no deadline (timeoutMs: Infinity): a workflow waits as long as its nodes take.
// Env: SPIKE_JOB_SECONDS (default 960) sets the long node's job. SPIKE_HOLD_NODE and SPIKE_HOLD_WORK_MS
// pause that node's `work` before its `started` memo, for the judge's kills.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { configure, createRegistry, defineDoc, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const [dirArg, command, token] = process.argv.slice(2);
if (!dirArg) throw new Error("usage: brain.ts <runDir> [submit <token>]");
const dir = resolve(dirArg);
mkdirSync(dir, { recursive: true });
const context = BACKGROUND_CONTEXT;
const jobSeconds = Number(process.env.SPIKE_JOB_SECONDS ?? 960);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const say = (kind: string, data?: unknown) => {
	const line = JSON.stringify({ t: Date.now(), pid: process.pid, kind, data });
	console.log(line);
	appendFileSync(join(dir, "events.log"), `${line}\n`);
};
const effect = (node: string, what: string) => appendFileSync(join(dir, "effects.log"), `${JSON.stringify({ t: Date.now(), node, what })}\n`);

// ---- approve: spike 4's record, answered by one host commit ----
type Approval = { id: string; summary: string; status: "pending" | "accepted" | "declined"; askedAt: number; answeredAt?: number };
const Approvals = defineDoc<{ items: Record<string, Approval> }>({
	kind: "cairn.approvals",
	version: 1,
	scope: "session",
	initial: () => ({ items: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});
const approve = defineTool({
	name: "approve",
	description: "Ask the user to approve a step of the workflow. Resolves with { approved, status }.",
	parameters: Type.Object({ summary: Type.String() }),
	structuredOutputSchema: Type.Object({ approved: Type.Boolean(), status: Type.String() }),
	callers: ["tools"],
	replay: "safe",
	execute: async ({ summary }, api, ctx) => {
		const id = `wf-${api.taskId}`;
		const asked = await api.commit(async (tx) => {
			const doc = await tx.doc(Approvals);
			if (doc.items[id] !== undefined) return false;
			doc.items[id] = { id, summary, status: "pending", askedAt: Date.now() };
			return true;
		}, ctx);
		// The approve node's effect is asking the user: once, whatever reruns read the answer again.
		if (asked) effect("approve", "asked");
		say("approval_waiting", { id });
		const watch = await api.watchDoc(Approvals, ctx);
		const status = await new Promise<string>((settle, fail) => {
			const now = () => watch?.value?.items?.[id]?.status;
			if (now() !== "pending") return settle(now()!);
			ctx.abortSignal?.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
			watch!.start(async () => { if (now() !== "pending") settle(now()!); });
		}).finally(() => watch?.stop());
		say("approval_settled", { id, status });
		return { output: [{ type: "text", text: status }], structuredOutput: { approved: status === "accepted", status } };
	},
});

// ---- work: a quick effect, at most once ----
const work = defineTool({
	name: "work",
	description: "Do this node's work.",
	parameters: Type.Object({ node: Type.String() }),
	callers: ["model"],
	replay: "safe",
	execute: async ({ node }, api, ctx) => {
		if ((await api.memo<boolean>("started", ctx)) === true) {
			return { output: [{ type: "text", text: "Interrupted after it started, so it may have run. Not retried." }], isError: true } as never;
		}
		const hold = Number(process.env.SPIKE_HOLD_WORK_MS ?? 0);
		if (hold > 0 && node === process.env.SPIKE_HOLD_NODE) { say("holding", { node, ms: hold }); await sleep(hold); }
		await api.memo("started", true, ctx);
		effect(node, "work");
		say("work", { node });
		return { output: [{ type: "text", text: JSON.stringify({ node, files: node.length * 7 }) }] };
	},
});

// ---- job: a long process in its own systemd user unit; a rerun reattaches ----
const job = defineTool({
	name: "job",
	description: "Run this node's long job and wait for it.",
	parameters: Type.Object({ node: Type.String() }),
	callers: ["model"],
	replay: "safe",
	execute: async ({ node }, api, ctx) => {
		const unit = `cairn-s3-job-${String(api.taskId)}-${process.env.SPIKE_RUN ?? "x"}`;
		const result = join(dir, `${unit}.result`);
		const active = () => {
			try { return execFileSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8" }).trim(); } catch (error: any) { return String(error.stdout ?? "").trim(); }
		};
		const started = await api.memo<string>("unit", ctx);
		if (started === undefined) {
			await api.memo("unit", unit, ctx);
			execFileSync("systemd-run", ["--user", `--unit=${unit}`, "--collect", "--quiet", "bash", "-c",
				`echo '${JSON.stringify({ t: 0, node, what: "job-start" })}' >> ${join(dir, "effects.log")}; sleep ${jobSeconds}; echo '{"node":"${node}","lines":4242}' > ${result}.tmp && mv ${result}.tmp ${result}`]);
			say("job_started", { node, unit, seconds: jobSeconds });
		} else {
			say("job_reattached", { node, unit, state: active() });
		}
		for (;;) {
			if (existsSync(result)) break;
			const state = active();
			if (state !== "active" && state !== "activating" && !existsSync(result)) {
				await sleep(500);
				if (existsSync(result)) break;
				return { output: [{ type: "text", text: `The job's unit ended without a result (${state}). Not retried.` }], isError: true } as never;
			}
			if (ctx.abortSignal?.aborted) {
				execFileSync("systemctl", ["--user", "stop", unit]);
				say("job_stopped", { node, unit });
				ctx.abortSignal.throwIfAborted();
			}
			await sleep(1000);
		}
		say("job_done", { node });
		return { output: [{ type: "text", text: readFileSync(result, "utf8").trim() }] };
	},
});

// ---- agent: a subagent conversation owned by the tool task, typed result ----
const agent = defineTool({
	name: "agent",
	description: "Run a subagent on one node of the workflow. Resolves with the node's JSON result.",
	parameters: Type.Object({ node: Type.String(), task: Type.String() }),
	structuredOutputSchema: Type.Object({ node: Type.String() }, { additionalProperties: true }),
	callers: ["tools"],
	replay: "safe",
	execute: async ({ node, task }, api, ctx) => {
		const child = await api.commit(async (tx) => {
			const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
			if (existing !== undefined) return existing.id;
			const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
			await configure(tx, created.id, { modelTools: [work, job] });
			return created.id;
		}, ctx);
		await api.details({ conversationId: child } as never, ctx);
		say("agent_running", { node, child });
		const handle = (await api.conversation(child, ctx))!;
		const submission = await handle.submit({ type: "input", content: `node:${node} ${task}`, requestId: `agent:${String(api.taskId)}` }, ctx);
		const settled = await submission.wait(ctx);
		if (settled.status !== "done") throw new Error(`Subagent ${node} ended ${settled.status}`);
		const answer: any = await api.commit(async (tx) => tx.entry(settled.answer), ctx);
		const text = (answer?.model?.[0]?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
		const value = JSON.parse(text);
		say("agent_done", { node, value });
		return { output: [{ type: "text", text }], structuredOutput: value };
	},
});

// ---- the scripted models ----
const workflow = `const [scan, long, ok] = await Promise.all([
  tools.agent({ node: "scan", task: "Count the files." }),
  tools.agent({ node: "long", task: "Run the long job." }),
  tools.approve({ summary: "Integrate the scan and the long job?" }),
]);
if (!ok.approved) return { stopped: ok.status, scan, long };
const merged = await tools.agent({ node: "integrate", task: JSON.stringify({ scan, long }) });
return { scan, long, ok, merged };`;
const faux = fauxProvider({ provider: "faux", models: [{ id: "script" }] });
const script = (ctx: any) => {
	const messages = ctx.messages as any[];
	const first = messages.find((m) => m.role === "user");
	const firstText = typeof first.content === "string" ? first.content : first.content.map((c: any) => c.text).join("");
	const last = messages[messages.length - 1];
	const node = /^node:(\w+)/.exec(firstText)?.[1];
	if (node === undefined) {
		if (last.role === "toolResult") return fauxAssistantMessage(fauxText(`workflow said: ${last.content.map((c: any) => c.text).join("")}`));
		return fauxAssistantMessage(fauxToolCall("codemode", { code: workflow }, { id: "wf_1" }), { stopReason: "toolUse" });
	}
	if (last.role === "toolResult") {
		const prior = last.content.map((c: any) => c.text).join("");
		let value: any;
		try { value = JSON.parse(prior); } catch { value = { error: prior }; }
		return fauxAssistantMessage(fauxText(JSON.stringify({ ...value, node })));
	}
	return fauxAssistantMessage(fauxToolCall(node === "long" ? "job" : "work", { node }, { id: `${node}_1` }), { stopReason: "toolUse" });
};
faux.setResponses(Array.from({ length: 500 }, () => script));
const models = createModels();
models.setProvider(faux.provider);

const registry = createRegistry();
const sandbox = new CodemodeSandbox({ timeoutMs: Number.POSITIVE_INFINITY });
const codemode = createCodemodeTool({ sandbox, models: false });
registry.install(defineExtension({ name: "codemode", tools: [codemode] }));
registry.install(defineExtension({ name: "cairn-workflow", tools: [agent, approve, work, job] }));
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "store.sqlite")), {
	models,
	registry,
	onReport: (error, info) => say("report", { type: info.type, error: String(error).slice(0, 300) }),
}, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "script" } } });
await root.configure({ modelTools: [codemode] }, context);
say("open", { jobSeconds, rss: process.memoryUsage().rss });
harness.resume();

createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", "http://localhost");
	if (url.pathname === "/answer" && request.method === "POST") {
		const id = url.searchParams.get("id") ?? "";
		const decision = url.searchParams.get("decision") === "accept" ? "accepted" : "declined";
		const changed = await harness.commit(async (tx) => {
			const item = (await tx.doc(Approvals)).items[id];
			if (item === undefined || item.status !== "pending") return false;
			item.status = decision;
			item.answeredAt = Date.now();
			return true;
		}, context);
		say("answered", { id, decision, changed });
		response.end(String(changed));
		return;
	}
	if (url.pathname === "/abort" && request.method === "POST") {
		say("aborting");
		await root.abort(context);
		response.end("aborted");
		return;
	}
	const doc = await harness.snapshot(Approvals, context);
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify({ approvals: Object.values(doc?.items ?? {}), rss: process.memoryUsage().rss }));
}).listen(3774, "127.0.0.1", () => say("listening", 3774));

if (command === "submit" && token) {
	const submission = await root.submit({ type: "input", requestId: `s3:${token}`, content: "Run the workflow." }, context);
	say("submitted", submission.id);
}
void root.waitForIdle(context).then(async () => {
	const messages = (await root.context(context)).messages as any[];
	const final = messages.filter((m) => m.role === "assistant").pop();
	say("final", final?.content?.map((c: any) => c.text ?? c.type).join("").slice(0, 2000));
	say("idle");
});
