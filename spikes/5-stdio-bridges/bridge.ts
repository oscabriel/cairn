// Spike 5: call a bridge directly, bypassing Executor.
//   node bridge.ts <server> list
//   node bridge.ts <server> <tool> '<json arguments>'
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const key = readFileSync(`${homedir()}/.config/cairn/bridges.key`, "utf8").trim();
const [server, command, args] = process.argv.slice(2);
const transport = new StreamableHTTPClientTransport(new URL(`http://172.17.0.1:3776/${server}/mcp`), {
	requestInit: { headers: { Authorization: `Bearer ${key}` } },
});
const client = new Client({ name: "cairn-spike-5-direct", version: "0" });
const started = performance.now();
await client.connect(transport);
const connected = performance.now();
if (command === "list") {
	for (const tool of (await client.listTools()).tools) console.log(`${tool.name}: ${tool.description?.split("\n")[0]}`);
} else if (command) {
	const result = await client.callTool({ name: command, arguments: JSON.parse(args ?? "{}") });
	for (const part of result.content as { type: string; text?: string }[]) console.log((part.text ?? JSON.stringify(part)).slice(0, 1500));
}
const done = performance.now();
console.error(`connect ${Math.round(connected - started)} ms, call ${Math.round(done - connected)} ms`);
await transport.terminateSession();
await client.close();
