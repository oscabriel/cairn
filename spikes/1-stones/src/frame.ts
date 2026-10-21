// Copied unchanged from cairn-v1 apps/cloud-sandbox/src/frame.ts, commit 1a5cd4a56e84bfb187940428d144b584d2e084b0.
// The relay's framing over one WebSocket, shared by the Beelink's pipe (relay/pipe.ts) and the CloudSandbox Durable
// Object (src/sandbox.ts). pi-env's own framed protocol rides inside it untouched: the relay carries bytes, never
// parses them. Plain TypeScript with no Node or Workers types, so both sides and the tests import it.
//
// - Binary messages: one channel byte, then at most CHUNK_BYTES of data. Channel 0 is the daemon's stdin (Beelink to
//   cloud), 1 its stdout and 2 its stderr (cloud to Beelink). Nothing else is valid in a binary message.
// - Text messages: one JSON control object.
//   - Beelink to cloud, exactly once and first: `{ "type": "start", "v": 1, "args": ["serve", "--token", <32 hex>] }`.
//     These are the arguments pi-env's Connection appends to the relay's command. The cloud side prepends its own
//     fixed daemon path, so nothing the Beelink sends picks the program: the same fixed-template rule as docker's.
//   - Beelink to cloud, any time after start: `{ "type": "eof" }`, the daemon's stdin ended.
//   - Cloud to Beelink: `{ "type": "exit", "code": <int> }` when the daemon exits, and
//     `{ "type": "error", "message": <string> }` when the cloud side gives up (start refused, container lost). The
//     cloud side closes the socket after either.

export const PROTOCOL_VERSION = 1;
/** The largest data chunk in one binary message (the brief's 64 KiB). */
export const CHUNK_BYTES = 64 * 1024;
/** Longest control message accepted; a start frame is about 90 bytes. */
export const CONTROL_MAX_BYTES = 4096;

export const STDIN = 0;
export const STDOUT = 1;
export const STDERR = 2;
export type Channel = typeof STDIN | typeof STDOUT | typeof STDERR;

/** A Cairn sandbox id: 12 lowercase hex, as the docker backend's (apps/server/src/sandbox/Docker.ts `ID`). */
export const SANDBOX_ID = /^[0-9a-f]{12}$/;
/** pi-env's Connection token: `randomBytes(16).toString("hex")`. */
export const DAEMON_TOKEN = /^[0-9a-f]{32}$/;

export type Control =
	| { readonly type: "start"; readonly v: number; readonly args: readonly ["serve", "--token", string] }
	| { readonly type: "eof" }
	| { readonly type: "exit"; readonly code: number }
	| { readonly type: "error"; readonly message: string };

export class FrameError extends Error {
	override readonly name = "FrameError";
}

/** Splits `data` into binary messages on `channel`, each at most CHUNK_BYTES of data. Empty data makes none. */
export const encodeData = (channel: Channel, data: Uint8Array): Uint8Array[] => {
	const out: Uint8Array[] = [];
	for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
		const part = data.subarray(offset, Math.min(offset + CHUNK_BYTES, data.length));
		const message = new Uint8Array(1 + part.length);
		message[0] = channel;
		message.set(part, 1);
		out.push(message);
	}
	return out;
};

/** Reads one binary message. Throws FrameError on an unknown channel, an empty chunk or an oversized one. */
export const decodeData = (message: Uint8Array): { readonly channel: Channel; readonly data: Uint8Array } => {
	if (message.length < 2) throw new FrameError("empty data frame");
	if (message.length > 1 + CHUNK_BYTES) throw new FrameError(`data frame over ${CHUNK_BYTES} bytes`);
	const channel = message[0];
	if (channel !== STDIN && channel !== STDOUT && channel !== STDERR) throw new FrameError(`unknown channel ${channel}`);
	return { channel, data: message.subarray(1) };
};

export const encodeControl = (control: Control): string => JSON.stringify(control);

/** The start frame for the arguments pi-env's Connection appended. Throws FrameError for any other arguments. */
export const startFrame = (args: readonly string[]): string => encodeControl({ type: "start", v: PROTOCOL_VERSION, args: startArgs(args) });

/** Checks a start frame's arguments: exactly `serve --token <32 hex>`. */
export const startArgs = (args: readonly unknown[]): readonly ["serve", "--token", string] => {
	const [serve, flag, token] = args;
	if (args.length !== 3 || serve !== "serve" || flag !== "--token" || typeof token !== "string" || !DAEMON_TOKEN.test(token)) {
		throw new FrameError("start arguments must be exactly serve --token <32 hex>");
	}
	return ["serve", "--token", token];
};

/** Parses one control message strictly: unknown types, extra keys and wrong shapes all throw FrameError. */
export const decodeControl = (text: string): Control => {
	if (text.length > CONTROL_MAX_BYTES) throw new FrameError("control frame too long");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new FrameError("control frame is not JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FrameError("control frame is not an object");
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort().join(",");
	switch (record.type) {
		case "start": {
			if (keys !== "args,type,v") throw new FrameError("start frame has the wrong keys");
			if (record.v !== PROTOCOL_VERSION) throw new FrameError(`unsupported relay protocol ${String(record.v)}`);
			if (!Array.isArray(record.args)) throw new FrameError("start args must be an array");
			return { type: "start", v: PROTOCOL_VERSION, args: startArgs(record.args) };
		}
		case "eof":
			if (keys !== "type") throw new FrameError("eof frame has the wrong keys");
			return { type: "eof" };
		case "exit":
			if (keys !== "code,type" || !Number.isInteger(record.code)) throw new FrameError("exit frame needs an integer code");
			return { type: "exit", code: record.code as number };
		case "error":
			if (keys !== "message,type" || typeof record.message !== "string") throw new FrameError("error frame needs a message");
			return { type: "error", message: record.message };
		default:
			throw new FrameError(`unknown control frame ${JSON.stringify(record.type)}`);
	}
};

/** The exit code the Beelink's pipe exits with when the socket closes without an exit frame. */
export const LOST_EXIT_CODE = 255;
