// Spike 4: approvals as durable records.
//   node brain.ts <runDir> [submit <token>]
//
// One pi-durable conversation whose scripted model calls `executor_call` once, to navigate Cairn's
// playwright to this brain's own /hit/<token> page, so every navigation that really runs is counted
// in <runDir>/hits.log, outside pi-durable's store.
//
// The tool is gated: before calling Executor it commits an approval record (the `cairn.approvals`
// session document) and waits until a host commit answers it or it expires. When the answer is accept, the
// tool marks the record `started`, calls Executor, and answers Executor's own approval prompt for
// the same call at once, so Executor's 10 minute window never meets a person.
//
// The approvals page is served on 127.0.0.1:3774. Env: SPIKE_MODE=full-access skips the gate,
// SPIKE_EXPIRY_MS sets the approval's lifetime, SPIKE_HOLD_STARTED_MS pauses after `started`,
// SPIKE_HOLD_ASKED_MS after Executor asks and SPIKE_HOLD_CALLED_MS after it answered, for the judge's kills.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { connect, text } from "./executor.ts";

const [dirArg, command, token] = process.argv.slice(2);
if (!dirArg) throw new Error("usage: brain.ts <runDir> [submit <token>]");
const dir = resolve(dirArg);
mkdirSync(dir, { recursive: true });
const context = BACKGROUND_CONTEXT;
const mode = process.env.SPIKE_MODE ?? "approval-required";
const expiryMs = Number(process.env.SPIKE_EXPIRY_MS ?? 24 * 3600_000);
const holdStarted = Number(process.env.SPIKE_HOLD_STARTED_MS ?? 0);
const holdAsked = Number(process.env.SPIKE_HOLD_ASKED_MS ?? 0);
const holdCalled = Number(process.env.SPIKE_HOLD_CALLED_MS ?? 0);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const say = (kind: string, data?: unknown) => {
	const line = JSON.stringify({ t: Date.now(), pid: process.pid, kind, data });
	console.log(line);
	appendFileSync(join(dir, "events.log"), `${line}\n`);
};

// The approval record. Session-scoped so the phone's queue lists every conversation's approvals.
type Decision = "accept" | "decline";
type Approval = {
	id: string;
	conversationId: string;
	toolTaskId: number;
	tool: string;
	summary: string;
	status: "pending" | "accepted" | "declined" | "expired" | "cancelled";
	askedAt: number;
	expiresAt: number;
	answeredAt?: number;
	// The effect sandwich: `started` is committed before Executor is called, `done` after.
	run?: "started" | "done";
	executorRequestId?: string;
};
const Approvals = defineDoc<{ items: Record<string, Approval> }>({
	kind: "cairn.approvals",
	version: 1,
	scope: "session",
	initial: () => ({ items: {} }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

// Wait in memory until the record leaves `pending` or expires. A restart reruns the (replay-safe) tool,
// which finds its record and waits again; pi-durable 1.3.0 has no durable sleep or external wait.
const awaitAnswer = async (api: any, approvalId: string, ctx: any): Promise<Approval["status"]> => {
	const watch = await api.watchDoc(Approvals, ctx);
	const status = () => (watch?.value?.items?.[approvalId] as Approval | undefined)?.status;
	try {
		return await new Promise((settle, fail) => {
			const item = watch?.value?.items?.[approvalId] as Approval | undefined;
			if (item === undefined) return fail(new Error("no approval record"));
			if (item.status !== "pending") return settle(item.status);
			const expire = setTimeout(async () => {
				const expired = await api.commit(async (tx: any) => {
					const current = (await tx.doc(Approvals)).items[approvalId];
					if (current.status === "pending") { current.status = "expired"; current.answeredAt = Date.now(); }
					return current.status;
				}, ctx).catch(fail);
				settle(expired);
			}, Math.max(0, item.expiresAt - Date.now()));
			ctx.signal?.addEventListener?.("abort", () => { clearTimeout(expire); fail(new Error("aborted")); });
			watch.start(async () => {
				const now = status();
				if (now !== undefined && now !== "pending") { clearTimeout(expire); settle(now); }
			});
		});
	} finally {
		await watch?.stop();
	}
};

// The answer, from the phone or the judge: one commit. The waiting tool sees it through its watch.
const answer = async (approvalId: string, decision: Decision) => {
	const result = await harness.commit(async (tx) => {
		const item = (await tx.doc(Approvals)).items[approvalId];
		if (item === undefined || item.status !== "pending") return { changed: false, item: item && { ...item } };
		item.status = decision === "accept" ? "accepted" : "declined";
		item.answeredAt = Date.now();
		return { changed: true, item: { ...item } };
	}, context);
	say("answered", { approvalId, decision, changed: result.changed, status: result.item?.status });
	return result;
};

const navigate = async (approval: Approval | undefined, url: string, setRequestId: (id: string) => Promise<void>) => {
	const client = await connect();
	try {
		const path = 'tools["cairn-bridges"].playwright.browser_navigate';
		const first: any = (await client.callTool("call", { calls: { path, input: { url } } })).structuredContent;
		say("executor_call", { status: first?.status, requestId: first?.requestId });
		let body = first;
		if (first?.status === "approval-required") {
			// Cairn already has the user's answer for this call (or full access): answer Executor's prompt now.
			await setRequestId(first.requestId);
			if (holdAsked > 0) { say("holding", { after: "asked", ms: holdAsked }); await sleep(holdAsked); }
			const resumed = await client.callTool("resume", { requestId: first.requestId, response: { action: "accept" } });
			body = resumed.structuredContent ?? JSON.parse(text(resumed));
			say("executor_resume", { status: body?.status });
		}
		return JSON.stringify(body).slice(0, 600);
	} finally {
		await client.close().catch(() => {});
	}
};

const executorCall = defineTool({
	name: "executor_call",
	description: "Open a URL in Cairn's browser through Executor.",
	parameters: Type.Object({ url: Type.String() }),
	// Safe to rerun: the record makes the wait idempotent and the `started` mark stops a second effect.
	replay: "safe",
	execute: async ({ url }, api, ctx) => {
		const approvalId = `call-${api.taskId}`;
		let approval: Approval | undefined;
		if (mode !== "full-access") {
			approval = await api.commit(async (tx) => {
				const doc = await tx.doc(Approvals);
				const existing = doc.items[approvalId];
				if (existing !== undefined) return { ...existing };
				const askedAt = Date.now();
				const expiresAt = askedAt + expiryMs;
				doc.items[approvalId] = { id: approvalId, conversationId: String(api.conversationId), toolTaskId: Number(api.taskId), tool: "executor_call", summary: `Open ${url}`, status: "pending", askedAt, expiresAt };
				return { ...doc.items[approvalId] };
			}, ctx);
			say("approval_waiting", { approvalId, status: approval.status });
			const decision = await awaitAnswer(api, approvalId, ctx);
			say("approval_settled", { approvalId, decision });
			if (decision !== "accepted") return { output: [{ type: "text", text: `Not run: the approval was ${decision}.` }], isError: true } as never;
		}
		// Intent: committed before the effect. A rerun that finds it never calls Executor again.
		const key = approvalId;
		const prior = await api.commit(async (tx) => {
			const doc = await tx.doc(Approvals);
			const item = (doc.items[key] ??= { id: key, conversationId: String(api.conversationId), toolTaskId: Number(api.taskId), tool: "executor_call", summary: `Open ${url}`, status: "accepted", askedAt: Date.now(), expiresAt: Date.now() });
			const before = item.run;
			item.run ??= "started";
			return before;
		}, ctx);
		if (prior !== undefined) {
			say("rerun_after_start", { approvalId: key, prior });
			return { output: [{ type: "text", text: "Interrupted after it started, so it may have run. Not retried." }], isError: true } as never;
		}
		if (holdStarted > 0) { say("holding", { after: "started", ms: holdStarted }); await sleep(holdStarted); }
		const result = await navigate(approval, url, async (requestId) => {
			await api.commit(async (tx) => { (await tx.doc(Approvals)).items[key]!.executorRequestId = requestId; }, ctx);
		});
		if (holdCalled > 0) { say("holding", { after: "called", ms: holdCalled }); await sleep(holdCalled); }
		await api.commit(async (tx) => { (await tx.doc(Approvals)).items[key]!.run = "done"; }, ctx);
		say("tool_done", { approvalId: key });
		return { output: [{ type: "text", text: result }] };
	},
});

// Scripted model: call the tool once, then report what it said. Stateless, so it behaves the same after a restart.
const faux = fauxProvider({ provider: "faux", models: [{ id: "script" }] });
const script = (ctx: any) => {
	const last = ctx.messages[ctx.messages.length - 1];
	if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`tool said: ${last.content.map((c: any) => c.text).join("")}`));
	const asked = [...ctx.messages].reverse().find((m: any) => m.role === "user");
	const url = String(typeof asked.content === "string" ? asked.content : asked.content.map((c: any) => c.text).join("")).split(" ").pop();
	return fauxAssistantMessage(fauxToolCall("executor_call", { url }, { id: "call_1" }), { stopReason: "toolUse" });
};
faux.setResponses(Array.from({ length: 64 }, () => script));
const models = createModels();
models.setProvider(faux.provider);

const registry = createRegistry();
registry.install(defineExtension({ name: "cairn-approvals", tools: [executorCall] }));
const storage = await openNodeSqliteStorage(join(dir, "store.sqlite"));
const harness = await Harness.open(storage, {
	models,
	registry,
	onReport: (error, info) => say("report", { type: info.type, error: String(error).slice(0, 300) }),
}, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "script" } } });
say("open", { mode });

// Boot sweep, before anything runs again:
//  - an Executor approval recorded for a call that never finished is declined, so a late accept can't run it.
const boot = await harness.snapshot(Approvals, context);
const inspection: any = await harness.inspect(context);
say("inspect", JSON.stringify(inspection).slice(0, 1500));
for (const item of Object.values(boot?.items ?? {})) {
	if (item.run === "started" && item.executorRequestId !== undefined) {
		const client = await connect();
		const declined = await client.callTool("resume", { requestId: item.executorRequestId, response: { action: "decline" } });
		say("orphan_declined", { approvalId: item.id, result: text(declined).slice(0, 200) });
		await client.close();
	}
}
harness.resume();

const page = (items: Approval[]) => `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Cairn approvals</title>
<style>body{font:16px system-ui;margin:1rem;max-width:40rem}li{margin:1rem 0;padding:1rem;border:1px solid #ccc;border-radius:.5rem;list-style:none}button{font-size:1.1rem;padding:.6rem 1.2rem;margin-right:.5rem}</style>
<h1>Cairn approvals</h1><ul style=padding:0>${items.map((item) => `<li><b>${item.summary}</b><br><small>${item.id} · ${item.status}${item.run ? ` · ${item.run}` : ""} · asked ${new Date(item.askedAt).toLocaleTimeString()}</small>${item.status === "pending" ? `<form method=post action=/answer><input type=hidden name=id value="${item.id}"><button name=decision value=accept>Approve</button><button name=decision value=decline>Decline</button></form>` : ""}</li>`).join("") || "<li>Nothing waiting.</li>"}</ul>`;

const hitsPath = join(dir, "hits.log");
const pageKeyPath = join(resolve(dir, ".."), "page.key");
const pageKey = existsSync(pageKeyPath) ? readFileSync(pageKeyPath, "utf8").trim() : undefined;
const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", "http://localhost");
	// Through Caddy the page needs the spike's key (it has no Tailscale sign-in yet); the judge uses loopback.
	if (request.headers["x-forwarded-for"] !== undefined) {
		const cookie = /(?:^|; )s4key=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
		const key = url.searchParams.get("key") ?? cookie;
		if (pageKey === undefined || key !== pageKey) { response.writeHead(403).end("forbidden"); return; }
		if (cookie !== pageKey) response.setHeader("set-cookie", `s4key=${pageKey}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400`);
	}
	if (url.pathname.startsWith("/hit/")) {
		appendFileSync(hitsPath, `${JSON.stringify({ t: Date.now(), token: url.pathname.slice(5) })}\n`);
		say("hit", url.pathname.slice(5));
		response.end("<title>hit</title>counted");
		return;
	}
	if (url.pathname === "/answer" && request.method === "POST") {
		let body = "";
		for await (const chunk of request) body += chunk;
		const form = new URLSearchParams(body);
		await answer(form.get("id") ?? "", form.get("decision") === "accept" ? "accept" : "decline");
		response.writeHead(303, { location: "/" }).end();
		return;
	}
	const doc = await harness.snapshot(Approvals, context);
	const items = Object.values(doc?.items ?? {}).sort((a, b) => b.askedAt - a.askedAt);
	if (url.pathname === "/state") {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ items, hits: existsSync(hitsPath) ? readFileSync(hitsPath, "utf8").trim().split("\n").filter(Boolean).length : 0 }));
		return;
	}
	response.setHeader("content-type", "text/html");
	response.end(page(items));
});
server.listen(3774, "127.0.0.1", () => say("listening", 3774));

if (command === "submit" && token) {
	const submission = await root.submit({ type: "input", requestId: `s4:${token}`, content: `Open http://127.0.0.1:3774/hit/${token}` }, context);
	say("submitted", submission.id);
}
// Report the conversation's tool results as they settle, whether or not this run submitted.
void root.waitForIdle(context).then(async () => {
	for (const message of (await root.context(context)).messages as any[]) {
		if (message.role === "toolResult") say("tool_result", { isError: message.isError, text: message.content.map((c: any) => c.text ?? c.type).join("").slice(0, 300) });
	}
	say("idle");
});
