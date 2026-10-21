// Spike 4: an MCP client on Cairn's own Executor grant (ops/executor/grant.ts made it).
// Only one process may hold the grant at a time: a refresh rotates the refresh token.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { adaptOAuthProvider, McpOAuthProvider } from "@earendil-works/pi-mcp/oauth";
import type { McpOAuthState } from "@earendil-works/pi-mcp/oauth";

const grantPath = `${homedir()}/.config/cairn/executor-grant.json`;

const stored = (): McpOAuthState => JSON.parse(readFileSync(grantPath, "utf8"));

export const connect = async () => {
	const { serverUrl } = stored();
	const oauth = new McpOAuthProvider({
		serverUrl,
		redirectUrl: "http://127.0.0.1:3774/callback",
		clientMetadata: { client_name: "Cairn" },
		store: {
			load: async () => stored(),
			save: async (state: McpOAuthState) => {
				const { serverUrl, clientInformation, tokens, tokensExpireAt } = state;
				writeFileSync(grantPath, `${JSON.stringify({ serverUrl, clientInformation, tokens, tokensExpireAt })}\n`, { mode: 0o600 });
			},
		},
		onRedirect: async () => {
			throw new Error("The grant needs consent again: run ops/wizards/phase-0.sh 9");
		},
	});
	const client = new McpClient({ name: "cairn-spike-4", version: "0" });
	await client.connect(new StreamableHttpTransport({ url: serverUrl, authProvider: adaptOAuthProvider(oauth) }));
	return client;
};

export const text = (result: { content: readonly { type: string; text?: string }[] }) =>
	result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("");

if (import.meta.main) {
	const client = await connect();
	const [tool, args] = process.argv.slice(2);
	const result = await client.callTool(tool ?? "describe", JSON.parse(args ?? "{}"));
	console.log(JSON.stringify(result.structuredContent ?? null, null, 1)?.slice(0, 4000));
	console.log(text(result).slice(0, 4000));
	await client.close();
}
