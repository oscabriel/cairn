// Spike 5: open a bridge session, call one tool, then exit without ending the session,
// as a client killed mid-session would.
//   node hold.ts <server> <tool> '<json arguments>'
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const key = readFileSync(`${homedir()}/.config/cairn/bridges.key`, "utf8").trim();
const [server, tool, args] = process.argv.slice(2);
const transport = new StreamableHTTPClientTransport(new URL(`http://172.17.0.1:3776/${server}/mcp`), {
	requestInit: { headers: { Authorization: `Bearer ${key}` } },
});
const client = new Client({ name: "cairn-spike-5-hold", version: "0" });
await client.connect(transport);
await client.callTool({ name: tool ?? "", arguments: JSON.parse(args ?? "{}") });
console.log(transport.sessionId);
process.exit(0);
