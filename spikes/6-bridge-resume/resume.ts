// Spike 6 (resume), judge J3: does the Agent SDK's own resume (resume + resumeSessionAt, and
// forkSession) continue a Claude Code session after its child was killed, per model?
//   node resume.ts <model> [trials=2]
// Variants, each `trials` times:
//   e1  kill while the tool call is held; resume at the tool_use assistant uuid, result as prompt text
//   e2  kill during the answer after the tool returned; resume at Claude Code's own tool_result entry
//   e3  as e1 with forkSession: a new session file
//   e4  as e1 with no result in the prompt: does the model rerun the tool?
// The tool appends to a marker file on every call, so a rerun shows. One JSON line per run goes to
// runs/<model>.ndjson and stdout. The bridge itself never runs here: this measures the SDK cut alone.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, getSessionMessages, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const model = process.argv[2] ?? "claude-haiku-5-5";
const trials = Number(process.argv[3] ?? "2");
const runsDir = join(import.meta.dirname, "runs");
mkdirSync(runsDir, { recursive: true });

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
	if (v === undefined || k.startsWith("ANTHROPIC_") || k.startsWith("CAIRN_") || k === "CLAUDE_CODE_OAUTH_TOKEN") continue;
	env[k] = v;
}
Object.assign(env, { ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_FORK_SUBAGENT: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });

// About 5K tokens of append, so a cache hit is visible against a cold write.
const ledger = Array.from({ length: 320 }, (_, i) =>
	`Ledger line ${String(i).padStart(4, "0")}: account ${(i * 7919) % 10007} moved ${(i * 31) % 997} units to bucket ${i % 13}.`,
).join("\n");

type Usage = { read: number; write: number };

function base(cwd: string, marker: string, held: boolean, onCall: () => void) {
	const mark = tool("mark", "Append a line to the marker file and return a token.", { line: z.string() }, async ({ line }) => {
		appendFileSync(marker, `${line}\n`);
		onCall();
		if (held) await new Promise(() => {});
		return { content: [{ type: "text", text: `TOKEN-${line.toUpperCase()}-42` }] };
	});
	return {
		cwd,
		env,
		model: `${model}[1m]`,
		tools: [],
		settingSources: [],
		strictMcpConfig: true,
		settings: { disableAllHooks: true, includeGitInstructions: false, autoMemoryEnabled: false },
		permissionMode: "bypassPermissions" as const,
		allowDangerouslySkipPermissions: true,
		includePartialMessages: true,
		systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: `You keep this ledger:\n${ledger}` },
		mcpServers: { spike: createSdkMcpServer({ name: "spike", version: "1.0.0", alwaysLoad: true, tools: [mark] }) },
	};
}

function promptOf(text: string) {
	let release: () => void = () => {};
	const done = new Promise<void>((resolve) => { release = resolve; });
	async function* gen() {
		yield { type: "user" as const, message: { role: "user" as const, content: text }, parent_tool_use_id: null };
		await done;
	}
	return { stream: gen(), release };
}

const ASK = "Call the mark tool exactly once with line set to \"alpha\". When it returns, reply with exactly the token it returned and nothing else.";

async function firstLeg(variant: string, cwd: string, marker: string) {
	let sessionId = "";
	let toolUseUuid = "";
	let toolCalled = false;
	const held = variant !== "e2";
	const prompt = promptOf(ASK);
	const q = query({ prompt: prompt.stream, options: base(cwd, marker, held, () => { toolCalled = true; }) });
	let killed = false;
	for await (const m of q as AsyncIterable<any>) {
		if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
		if (m.type === "assistant" && m.message.content.some((b: any) => b.type === "tool_use")) toolUseUuid = m.uuid;
		if (held && toolCalled && toolUseUuid) { killed = true; break; }
		// e2: the tool returned; kill at the first text of the answer.
		if (!held && toolCalled && m.type === "stream_event" && m.event?.type === "content_block_delta" && m.event.delta?.type === "text_delta") { killed = true; break; }
		if (m.type === "result") break;
	}
	q.close();
	prompt.release();
	return { sessionId, toolUseUuid, killed };
}

async function resumeLeg(variant: string, cwd: string, marker: string, first: { sessionId: string; toolUseUuid: string }) {
	let at = first.toolUseUuid;
	let text = "[Your session was interrupted while the mark tool ran. Its result was: TOKEN-ALPHA-42. Continue the task from there.]";
	if (variant === "e4") text = "Continue.";
	if (variant === "e2") {
		const entries = await getSessionMessages(first.sessionId, { dir: cwd });
		const result = entries.find((e: any) => e.type === "user" && Array.isArray(e.message?.content) && e.message.content.some((b: any) => b.type === "tool_result"));
		at = result?.uuid ?? first.toolUseUuid;
		text = "[Your session was interrupted and resumed. What precedes this ends with the tool result you were waiting for. Continue the task from there.]";
	}
	const prompt = promptOf(text);
	const options = { ...base(cwd, marker, false, () => {}), resume: first.sessionId, resumeSessionAt: at, ...(variant === "e3" ? { forkSession: true } : {}) };
	const started = Date.now();
	const q = query({ prompt: prompt.stream, options });
	let sessionId = "";
	let answer = "";
	let usage: Usage = { read: 0, write: 0 };
	let error = "";
	for await (const m of q as AsyncIterable<any>) {
		if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
		if (m.type === "assistant") for (const b of m.message.content) if (b.type === "text") answer += b.text;
		if (m.type === "result") {
			usage = { read: m.usage?.cache_read_input_tokens ?? 0, write: m.usage?.cache_creation_input_tokens ?? 0 };
			if (m.is_error) error = String(m.result ?? m.subtype);
			break;
		}
	}
	q.close();
	prompt.release();
	return { sessionId, answer, usage, error, at, seconds: (Date.now() - started) / 1000 };
}

const variants = ["e1", "e2", "e3", "e4"];
const out = join(runsDir, `${model}.ndjson`);
for (const variant of variants) {
	for (let trial = 1; trial <= trials; trial++) {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), `cairn-j3-${variant}-`)));
		const marker = join(cwd, "marker.txt");
		writeFileSync(marker, "");
		const first = await firstLeg(variant, cwd, marker);
		const resumed = await resumeLeg(variant, cwd, marker, first);
		const toolRuns = readFileSync(marker, "utf8").split("\n").filter(Boolean).length;
		const ratio = resumed.usage.write === 0 ? Infinity : resumed.usage.read / resumed.usage.write;
		const sameOrForked = variant === "e3" ? resumed.sessionId !== "" && resumed.sessionId !== first.sessionId : resumed.sessionId === first.sessionId;
		const usesResult = /TOKEN-ALPHA-42/.test(resumed.answer);
		const pass = first.killed && sameOrForked && ratio >= 10 && toolRuns === 1 && (variant === "e4" || usesResult);
		const line = { model, variant, trial, pass, killed: first.killed, firstSession: first.sessionId, resumedSession: resumed.sessionId, at: resumed.at, cacheRead: resumed.usage.read, cacheWrite: resumed.usage.write, ratio: Number.isFinite(ratio) ? Math.round(ratio * 10) / 10 : "inf", toolRuns, usesResult, answer: resumed.answer.slice(0, 160), error: resumed.error, seconds: resumed.seconds };
		appendFileSync(out, `${JSON.stringify(line)}\n`);
		console.log(JSON.stringify(line));
	}
}
