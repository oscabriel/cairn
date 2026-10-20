// Spike 0: does Claude Code defer a bridged MCP tool behind tool search? ALWAYS_LOAD=1 sets alwaysLoad on the server.
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const alwaysLoad = process.env.ALWAYS_LOAD === "1";
const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ANTHROPIC_")));
env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
env.ENABLE_CLAUDEAI_MCP_SERVERS = "0";
const pi = createSdkMcpServer({
	name: "pi",
	alwaysLoad,
	tools: [
		tool("codemode", "Run a JavaScript program against the workspace tools and return its result.", { code: z.string() }, async () => ({
			content: [{ type: "text", text: "42" }],
		})),
	],
});
const toolUses: string[] = [];
let initTools: string[] = [];
const started = performance.now();
for await (const m of query({
	prompt: "Use the codemode tool to run `return 6*7` and reply with only its result.",
	options: { model: "claude-sonnet-5-5", env, tools: [], settingSources: [], settings: { disableAllHooks: true }, strictMcpConfig: true, persistSession: false, mcpServers: { pi }, allowedTools: ["mcp__pi__codemode"], maxTurns: 4 },
})) {
	if (m.type === "system" && m.subtype === "init") initTools = m.tools;
	if (m.type === "assistant") for (const c of m.message.content) if (c.type === "tool_use") toolUses.push(c.name);
	if (m.type === "result") console.log(JSON.stringify({ alwaysLoad, initTools, toolUses, turns: m.num_turns, ms: Math.round(performance.now() - started), result: m.subtype === "success" ? m.result : m.subtype }));
}
