// Copied unchanged from cairn-v1 apps/cloud-sandbox/relay/pipe.ts, commit 1a5cd4a56e84bfb187940428d144b584d2e084b0.
// The Beelink's end of a cloud sandbox's relay: the command pi-env's Connection spawns in place of `docker exec`.
//
//   node relay/pipe.ts --credentials <file> <sandboxId> serve --token <32 hex>
//
// Connection appends `serve --token <hex>`; those three arguments go to the Worker as the start frame and pick nothing
// else there. This process bridges its stdin and stdout to the WebSocket's binary frames (src/frame.ts) and the
// daemon's stderr to its own stderr, which Connection hands to `onLog`. It exits with the daemon's exit code, or 255
// when the socket goes without one, which Connection reports as a lost connection.
//
// The credentials file is the one the stack writes (alchemy.run.ts), 0600 and owned by this user:
// `{ url, clientId, clientSecret, secret }`. The Access service token goes in Access's own headers, and the shared
// secret as a bearer token. None of them is ever an argument, so none shows in `ps`.
import { lstatSync, readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { decodeControl, decodeData, encodeControl, encodeData, FrameError, LOST_EXIT_CODE, SANDBOX_ID, startArgs, startFrame, STDERR, STDIN, STDOUT } from "../src/frame.ts";

export type Credentials = { readonly url: string; readonly clientId: string; readonly clientSecret: string; readonly secret: string };

/** Reads the relay's credentials. A file that is a link, not ours, not 0600 or not the right shape throws. */
export const readCredentials = (path: string): Credentials => {
	const stat = lstatSync(path);
	if (!stat.isFile()) throw new Error(`${path}: the credentials file must be a regular file, not a link`);
	if (stat.uid !== process.getuid?.()) throw new Error(`${path}: the credentials file belongs to uid ${stat.uid}`);
	if ((stat.mode & 0o077) !== 0) throw new Error(`${path}: the credentials file must be 0600`);
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	const { url, clientId, clientSecret, secret } = parsed;
	if (typeof url !== "string" || typeof clientId !== "string" || typeof clientSecret !== "string" || typeof secret !== "string") {
		throw new Error(`${path}: expected { url, clientId, clientSecret, secret }`);
	}
	if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error(`${path}: the secret must be 64 hex`);
	const parsedUrl = new URL(url);
	// Plain ws only to this host, for a local test Worker.
	const local = parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost";
	if (!(parsedUrl.protocol === "wss:" || (parsedUrl.protocol === "ws:" && local))) throw new Error(`${path}: the relay url must be wss://`);
	return { url: url.replace(/\/+$/, ""), clientId, clientSecret, secret };
};

/** The handshake headers: Access's service token, then the Worker's own shared secret. */
export const relayHeaders = (credentials: Credentials): Record<string, string> => ({
	"CF-Access-Client-Id": credentials.clientId,
	"CF-Access-Client-Secret": credentials.clientSecret,
	Authorization: `Bearer ${credentials.secret}`,
});

export const pipeUrl = (credentials: Credentials, sandboxId: string): string => {
	if (!SANDBOX_ID.test(sandboxId)) throw new Error(`not a sandbox id: ${JSON.stringify(sandboxId)}`);
	return `${credentials.url}/pipe/${sandboxId}`;
};

/** What the bridge needs of a WebSocket; Node's own (undici) fits, and the tests pass a fake. */
export type RelaySocket = {
	readonly readyState: number;
	readonly bufferedAmount: number;
	binaryType: string;
	send(data: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { readonly data: unknown }) => void) | null;
	onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
};

/** Stdin is paused while this much is waiting in the socket, so a big write does not pile up in memory. */
export const HIGH_WATER_BYTES = 1024 * 1024;
const DRAIN_POLL_MS = 5;

/**
 * Runs one relay session over an unopened socket. Resolves with the exit code this process should exit with. Stdin is
 * read only after the socket opens and the start frame is out.
 */
export const bridge = (socket: RelaySocket, args: readonly string[], io: { stdin: Readable; stdout: Writable; stderr: Writable }): Promise<number> => {
	const start = startFrame(args);
	socket.binaryType = "arraybuffer";
	return new Promise<number>((resolve) => {
		let settled = false;
		let poll: ReturnType<typeof setInterval> | undefined;
		const settle = (code: number, why?: string) => {
			if (settled) return;
			settled = true;
			if (poll) clearInterval(poll);
			io.stdin.pause();
			io.stdin.off("data", onData);
			io.stdin.off("end", onEnd);
			if (why) io.stderr.write(`cloud sandbox relay: ${why}\n`);
			try {
				socket.close(1000, "done");
			} catch {}
			resolve(code);
		};
		const onData = (chunk: Buffer) => {
			for (const message of encodeData(STDIN, chunk)) socket.send(message);
			if (socket.bufferedAmount > HIGH_WATER_BYTES && !poll) {
				io.stdin.pause();
				poll = setInterval(() => {
					if (socket.bufferedAmount > HIGH_WATER_BYTES) return;
					clearInterval(poll);
					poll = undefined;
					if (!settled) io.stdin.resume();
				}, DRAIN_POLL_MS);
			}
		};
		const onEnd = () => {
			if (!settled) socket.send(encodeControl({ type: "eof" }));
		};
		socket.onopen = () => {
			socket.send(start);
			io.stdin.on("data", onData);
			io.stdin.on("end", onEnd);
			io.stdin.resume();
		};
		socket.onmessage = (event) => {
			if (settled) return;
			try {
				const { data } = event;
				if (typeof data === "string") {
					const control = decodeControl(data);
					if (control.type === "exit") return settle(control.code);
					if (control.type === "error") return settle(LOST_EXIT_CODE, control.message);
					throw new FrameError(`unexpected ${control.type} frame from the cloud`);
				}
				const message = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : undefined;
				if (!message) throw new FrameError("unknown message type");
				const { channel, data: chunk } = decodeData(message);
				if (channel === STDOUT) io.stdout.write(chunk);
				else if (channel === STDERR) io.stderr.write(chunk);
				else throw new FrameError("stdin data from the cloud");
			} catch (error) {
				settle(LOST_EXIT_CODE, error instanceof Error ? error.message : String(error));
			}
		};
		socket.onclose = (event) => settle(LOST_EXIT_CODE, `the socket closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`);
		socket.onerror = () => settle(LOST_EXIT_CODE, "the socket failed");
	});
};

/** Parses `--credentials <file> <sandboxId> serve --token <hex>`. Throws on anything else. */
export const parseArgs = (argv: readonly string[]): { readonly credentials: string; readonly sandboxId: string; readonly daemonArgs: readonly string[] } => {
	const [flag, credentials, sandboxId, ...daemonArgs] = argv;
	if (flag !== "--credentials" || !credentials || !sandboxId) throw new Error("usage: pipe.ts --credentials <file> <sandboxId> serve --token <hex>");
	if (!SANDBOX_ID.test(sandboxId)) throw new Error(`not a sandbox id: ${JSON.stringify(sandboxId)}`);
	return { credentials, sandboxId, daemonArgs: startArgs(daemonArgs) };
};

const main = async () => {
	let code: number;
	try {
		const { credentials: path, sandboxId, daemonArgs } = parseArgs(process.argv.slice(2));
		const credentials = readCredentials(path);
		process.stdin.pause();
		// Node's WebSocket (undici) takes handshake headers in its options, which the DOM type does not declare.
		const socket = new WebSocket(pipeUrl(credentials, sandboxId), { headers: relayHeaders(credentials) } as unknown as string[]) as unknown as RelaySocket;
		const ended = bridge(socket, daemonArgs, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
		// Connection's teardown kills this process: close the socket first, so the cloud side kills its daemon now.
		for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
			process.once(signal, () => {
				try {
					socket.close(1000, "relay stopped");
				} catch {}
				process.exit(LOST_EXIT_CODE);
			});
		}
		code = await ended;
	} catch (error) {
		process.stderr.write(`cloud sandbox relay: ${error instanceof Error ? error.message : String(error)}\n`);
		code = LOST_EXIT_CODE;
	}
	// Let stdout flush before exiting.
	process.stdout.write("", () => process.exit(code));
};

if (import.meta.main) void main();
