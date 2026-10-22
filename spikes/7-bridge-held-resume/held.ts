// Spike 7: why the first reply after a `kill -9` during a held tool call loses the prompt cache
// (J2's parked case), and which resume keeps it.
//   node held.ts <model> [trials=1]
// First leg, as the bridge runs a first turn: the preset with an append, an 800-line ledger in the
// first user message, one in-process MCP tool `mark` that appends to a marker file and then never
// returns. While it hangs, the Claude Code child gets SIGKILL (the bridge's children die with the
// brain). Second leg resumes the session with the interrupted result as prompt text, as the bridge
// does, in one of these variants:
//   no-append  resume without an append (the bridge before 4J2)
//   append     resume with the same append the first leg had (the bridge after 4J2)
//   at         resume with `resumeSessionAt` the tool_use entry, no append (spike 6's E1 cut)
// One JSON line per run goes to runs/<model>.ndjson and stdout: cache read and write of the first
// request after the resume, the agent line each request sent, and how often `mark` ran.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, getSessionMessages, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const model = process.argv[2] ?? "claude-haiku-5-5";
const trials = Number(process.argv[3] ?? "1");
const runsDir = join(import.meta.dirname, "runs");
mkdirSync(runsDir, { recursive: true });

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
	if (v === undefined || k.startsWith("ANTHROPIC_") || k.startsWith("CAIRN_") || k === "CLAUDE_CODE_OAUTH_TOKEN") continue;
	env[k] = v;
}
Object.assign(env, { ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_FORK_SUBAGENT: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });

const ledger = Array.from({ length: 800 }, (_, i) =>
	`Ledger line ${i}: account ${(i * 7919) % 10_007} moved ${(i * 104_729) % 9973} units to bin ${i % 97}.`,
).join("\n");

const APPEND = "<cairn>You run inside Cairn. Answer briefly.</cairn>";

function base(cwd: string, marker: string, held: boolean, append: boolean, onCall: () => void) {
	const mark = tool("mark", "Append a line to the marker file and return a token.", { line: z.string() }, async ({ line }) => {
		appendFileSync(marker, `${line}\n`);
		onCall();
		if (held) await new Promise(() => {});
		return { content: [{ type: "text" as const, text: `TOKEN-${line.toUpperCase()}-42` }] };
	});
	return {
		cwd,
		env,
		model,
		tools: [],
		settingSources: [],
		strictMcpConfig: true,
		settings: { disableAllHooks: true, includeGitInstructions: false, autoMemoryEnabled: false },
		permissionMode: "bypassPermissions" as const,
		allowDangerouslySkipPermissions: true,
		includePartialMessages: true,
		systemPrompt: append ? { type: "preset" as const, preset: "claude_code" as const, append: APPEND } : { type: "preset" as const, preset: "claude_code" as const },
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

const ASK = `<ledger>\n${ledger}\n</ledger>\n\nIgnore the ledger. Call the mark tool exactly once with line set to "alpha". Never call it a second time, even if it reports an error or an interruption. Then say in one sentence what happened.`;

async function firstLeg(cwd: string, marker: string) {
	let child: SpawnedProcess | undefined;
	let sessionId = "";
	let toolUseUuid = "";
	let toolCalled = false;
	const prompt = promptOf(ASK);
	const options = {
		...base(cwd, marker, true, true, () => {
			toolCalled = true;
			setTimeout(() => child?.kill("SIGKILL"), 1000);
		}),
		spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) => {
			const spawned = spawn(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd, env: spawnOptions.env, stdio: ["pipe", "pipe", "ignore"] });
			child = spawned;
			return spawned;
		},
	};
	const q = query({ prompt: prompt.stream, options });
	// Leaving the loop would close the query, and Claude Code would record its own interrupted
	// result before any kill. Keep reading; a second after the call (as the judge waits), SIGKILL
	// the child as the brain's death does, and the stream ends with it.
	try {
		for await (const m of q as AsyncIterable<any>) {
			if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
			if (m.type === "assistant" && m.message.content.some((b: any) => b.type === "tool_use")) toolUseUuid = m.uuid;
			if (m.type === "result") break;
		}
	} catch {
		// The killed child ends the stream with an error.
	}
	prompt.release();
	return { sessionId, toolUseUuid, killed: child !== undefined };
}

async function resumeLeg(variant: string, cwd: string, marker: string, first: { sessionId: string; toolUseUuid: string }) {
	const text = "[Your session was interrupted while these tool calls ran. Their results follow; continue the task from them.]\n\n<tool-result id=\"x\" error=\"true\">\nThe operation was interrupted by a restart; it may or may not have run.\n</tool-result>";
	const prompt = promptOf(text);
	const options = {
		...base(cwd, marker, false, variant === "append", () => {}),
		resume: first.sessionId,
		...(variant === "at" ? { resumeSessionAt: first.toolUseUuid } : {}),
	};
	const q = query({ prompt: prompt.stream, options });
	let firstUsage: { read: number; write: number } | undefined;
	let answer = "";
	for await (const m of q as AsyncIterable<any>) {
		if (m.type === "stream_event" && m.event?.type === "message_start" && firstUsage === undefined) {
			const usage = m.event.message.usage;
			firstUsage = { read: usage.cache_read_input_tokens ?? 0, write: usage.cache_creation_input_tokens ?? 0 };
		}
		if (m.type === "assistant") for (const b of m.message.content) if (b.type === "text") answer += b.text;
		if (m.type === "result") break;
	}
	q.close();
	prompt.release();
	return { usage: firstUsage ?? { read: 0, write: 0 }, answer };
}

function agentLines(cwd: string, sessionId: string): Array<string> {
	const folder = join(homedir(), ".claude", "projects", cwd.replaceAll(/[/.]/g, "-"));
	const file = readdirSync(folder).find((name) => name === `${sessionId}.jsonl`);
	if (file === undefined) return [];
	return readFileSync(join(folder, file), "utf8").split("\n").filter(Boolean).flatMap((line) => {
		const entry = JSON.parse(line);
		return entry.type === "api-request-shape" ? [String(entry.shape?.system?.[0]?.text ?? "")] : [];
	});
}

const out = join(runsDir, `${model}.ndjson`);
for (const variant of ["no-append", "append", "at"]) {
	for (let trial = 1; trial <= trials; trial++) {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), `cairn-s7-${variant}-`)));
		const marker = join(cwd, "marker.txt");
		writeFileSync(marker, "");
		const first = await firstLeg(cwd, marker);
		const entries = await getSessionMessages(first.sessionId, { dir: cwd });
		const resumed = await resumeLeg(variant, cwd, marker, first);
		const toolRuns = readFileSync(marker, "utf8").split("\n").filter(Boolean).length;
		const ratio = resumed.usage.write === 0 ? "inf" : Math.round((resumed.usage.read / resumed.usage.write) * 10) / 10;
		const line = {
			model, variant, trial, killed: first.killed, entriesBeforeResume: entries.length,
			cacheRead: resumed.usage.read, cacheWrite: resumed.usage.write, ratio, toolRuns,
			agentLines: agentLines(cwd, first.sessionId).map((text) => text.slice(0, 48)),
			answer: resumed.answer.slice(0, 140),
		};
		appendFileSync(out, `${JSON.stringify(line)}\n`);
		console.log(JSON.stringify(line));
	}
}
