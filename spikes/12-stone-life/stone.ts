// The Beelink's end of spike 12 (cut from spike 11): a stone's ExecutionEnv (pi-env's RemoteExecutionEnv over the relay), and the
// Worker's control routes. The relay's credentials come from the 0600 file the stack wrote, and never appear in
// an argument: pi-env's Connection spawns relay/pipe.ts with the file's path only.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";

export const CREDENTIALS = join(homedir(), ".config/cairn/stones-s12.json");
const PIPE = join(import.meta.dirname, "relay/pipe.ts");

type Credentials = { url: string; clientId: string; clientSecret: string; secret: string };
const credentials = (): Credentials => JSON.parse(readFileSync(CREDENTIALS, "utf8")) as Credentials;

export const connect = (stoneId: string, onLog?: (text: string) => void) =>
	new Connection({ command: ["node", PIPE, "--credentials", CREDENTIALS, stoneId], ...(onLog ? { onLog } : {}) });

export const stoneEnv = (stoneId: string, connection = connect(stoneId), cwd = "/workspace") =>
	new RemoteExecutionEnv({ connection, id: `stone:${stoneId}`, cwd, watch: { pollIntervalMs: 100 } });

const link = () => {
	const c = credentials();
	return { base: c.url.replace(/^wss:/, "https:"), headers: { "CF-Access-Client-Id": c.clientId, "CF-Access-Client-Secret": c.clientSecret, Authorization: `Bearer ${c.secret}` } };
};

/** The object store's own routes, which never wake a stone's object: a head, a delete, and the bytes. */
export const objectHead = async (key: string): Promise<{ size: number; sha256: string } | null> => {
	const { base, headers } = link();
	return ((await (await fetch(`${base}/stone/000000000000/head?key=${encodeURIComponent(key)}`, { headers })).json()) as { object: { size: number; sha256: string } | null }).object;
};
export const objectDelete = async (key: string) => {
	const { base, headers } = link();
	await fetch(`${base}/stone/000000000000/delete?key=${encodeURIComponent(key)}`, { method: "POST", headers });
};
export const objectBytes = async (key: string): Promise<Response> => {
	const { base, headers } = link();
	return await fetch(`${base}/stone/000000000000/download?key=${encodeURIComponent(key)}`, { headers });
};

export const control = async (stoneId: string, op?: string, body?: unknown): Promise<Record<string, unknown>> => {
	const c = credentials();
	const base = c.url.replace(/^wss:/, "https:");
	const response = await fetch(`${base}/stone/${stoneId}${op ? `/${op}` : ""}`, {
		method: op ? "POST" : "GET",
		headers: { "CF-Access-Client-Id": c.clientId, "CF-Access-Client-Secret": c.clientSecret, Authorization: `Bearer ${c.secret}`, "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(900_000),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${op ?? "status"}: ${response.status} ${text.slice(0, 300)}`);
	return JSON.parse(text) as Record<string, unknown>;
};
