// Spike 10: how long after Claude Code emits an assistant message (the event the bridge stamps a
// reply with) the message's uuid reaches the session's transcript on disk.
//   node lag.ts <model> [trials=4]
// Each trial asks for one call of an in-process MCP tool `mark` that returns at once. On the
// `assistant` event holding the tool_use, and again inside the tool's handler, it checks whether the
// event's uuid is in `~/.claude/projects/<escaped cwd>/<session>.jsonl`, then polls the file every
// 2 ms until it is. One JSON line per trial goes to runs/<model>.ndjson and stdout.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const model = process.argv[2] ?? "claude-haiku-5-5";
const trials = Number(process.argv[3] ?? "4");
const runsDir = join(import.meta.dirname, "runs");
mkdirSync(runsDir, { recursive: true });

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
	if (v === undefined || k.startsWith("ANTHROPIC_") || k.startsWith("CAIRN_") || k === "CLAUDE_CODE_OAUTH_TOKEN") continue;
	env[k] = v;
}
Object.assign(env, { ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_FORK_SUBAGENT: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });

const folderOf = (cwd: string) => join(homedir(), ".claude", "projects", cwd.replaceAll(/[/.]/g, "-"));
const onDisk = (cwd: string, sessionId: string, uuid: string) => {
	const file = join(folderOf(cwd), `${sessionId}.jsonl`);
	return existsSync(file) && readFileSync(file, "utf8").includes(`"uuid":"${uuid}"`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function trial(n: number) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "cairn-s10-")));
	let sessionId = "";
	let uuid = "";
	let eventAt = 0;
	let atHandler: boolean | undefined;
	let handlerMs: number | undefined;
	const mark = tool("mark", "Return a token.", { line: z.string() }, async () => {
		handlerMs = performance.now() - eventAt;
		atHandler = uuid === "" ? undefined : onDisk(cwd, sessionId, uuid);
		return { content: [{ type: "text" as const, text: "TOKEN-42" }] };
	});
	const q = query({
		prompt: 'Call the mark tool exactly once with line set to "alpha", then reply with the single word done.',
		options: {
			cwd,
			env,
			model,
			tools: [],
			settingSources: [],
			strictMcpConfig: true,
			settings: { disableAllHooks: true, includeGitInstructions: false, autoMemoryEnabled: false },
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			systemPrompt: { type: "preset", preset: "claude_code", append: "<cairn>Answer briefly.</cairn>" },
			mcpServers: { spike: createSdkMcpServer({ name: "spike", version: "1.0.0", alwaysLoad: true, tools: [mark] }) },
		},
	});
	let atEvent: boolean | undefined;
	let lagMs: number | undefined;
	for await (const m of q as AsyncIterable<any>) {
		if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
		if (m.type === "assistant" && uuid === "" && m.message.content.some((b: any) => b.type === "tool_use")) {
			uuid = m.uuid;
			eventAt = performance.now();
			atEvent = onDisk(cwd, sessionId, uuid);
			// Poll without blocking the loop for long; the SDK buffers the events behind us.
			const start = eventAt;
			while (!onDisk(cwd, sessionId, uuid) && performance.now() - start < 2000) await sleep(2);
			lagMs = Math.round(performance.now() - start);
		}
		if (m.type === "result") break;
	}
	q.close();
	rmSync(folderOf(cwd), { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
	return { model, trial: n, atEvent, lagMs, atHandler, handlerMs: handlerMs === undefined ? undefined : Math.round(handlerMs) };
}

const out = join(runsDir, `${model}.ndjson`);
for (let n = 1; n <= trials; n++) {
	const line = await trial(n);
	appendFileSync(out, `${JSON.stringify(line)}\n`);
	console.log(JSON.stringify(line));
}
