// Spike 5: a tiny MCP client for Executor, authenticated with the phase 0 setup token.
//   node mcp.ts list                       list Executor's MCP tools
//   node mcp.ts <tool> '<json arguments>'  call one tool and print its result
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const env = Object.fromEntries(
	readFileSync(`${homedir()}/.config/cairn/phase-0.env`, "utf8")
		.split("\n")
		.filter((line) => line.includes("="))
		.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const transport = new StreamableHTTPClientTransport(new URL(`https://exec.gneiss.run/org/${env.EXECUTOR_ORG}/mcp`), {
	requestInit: { headers: { Authorization: `Bearer ${env.EXECUTOR_SETUP_TOKEN}` } },
});
const client = new Client({ name: "cairn-spike-5", version: "0" });
await client.connect(transport);
const [command, args] = process.argv.slice(2);
if (command === "list") {
	for (const tool of (await client.listTools()).tools) console.log(`${tool.name}: ${tool.description?.split("\n")[0]}`);
} else if (command) {
	const result = await client.callTool({ name: command, arguments: JSON.parse(args ?? "{}") });
	for (const part of result.content as { type: string; text?: string }[]) console.log(part.text ?? part);
}
await client.close();
