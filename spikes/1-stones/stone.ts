// The Beelink's end of spike 1: a stone's ExecutionEnv (pi-env's RemoteExecutionEnv over the relay), and the
// Worker's control routes. The relay's credentials come from the 0600 file the stack wrote, and never appear in
// an argument: pi-env's Connection spawns relay/pipe.ts with the file's path only.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";

export const CREDENTIALS = join(homedir(), ".config/cairn/stones-s1.json");
const PIPE = join(import.meta.dirname, "relay/pipe.ts");

type Credentials = { url: string; clientId: string; clientSecret: string; secret: string };
const credentials = (): Credentials => JSON.parse(readFileSync(CREDENTIALS, "utf8")) as Credentials;

export const connect = (stoneId: string, onLog?: (text: string) => void) =>
	new Connection({ command: ["node", PIPE, "--credentials", CREDENTIALS, stoneId], ...(onLog ? { onLog } : {}) });

export const stoneEnv = (stoneId: string, connection = connect(stoneId), cwd = "/workspace") =>
	new RemoteExecutionEnv({ connection, id: `stone:${stoneId}`, cwd, watch: { pollIntervalMs: 100 } });

export const control = async (stoneId: string, op?: "start" | "stop" | "evict"): Promise<Record<string, unknown>> => {
	const c = credentials();
	const base = c.url.replace(/^wss:/, "https:");
	const response = await fetch(`${base}/stone/${stoneId}${op ? `/${op}` : ""}`, {
		method: op ? "POST" : "GET",
		headers: { "CF-Access-Client-Id": c.clientId, "CF-Access-Client-Secret": c.clientSecret, Authorization: `Bearer ${c.secret}` },
		signal: AbortSignal.timeout(300_000),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${op ?? "status"}: ${response.status} ${text.slice(0, 300)}`);
	return JSON.parse(text) as Record<string, unknown>;
};
