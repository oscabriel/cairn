// Copied unchanged from cairn-v1 apps/cloud-sandbox/src/pump.ts, commit 1a5cd4a56e84bfb187940428d144b584d2e084b0.
// The cloud side of the relay: one WebSocket from the Beelink's pipe, one pi-env daemon process in the container.
// The socket's first message must be the start frame; its arguments are checked and the fixed daemon path is put in
// front of them here, so the Beelink never names the program. Stdin data that arrives while the container is still
// starting is queued in order behind the launch (pi-env sends its hello the moment it spawns the relay). The exit
// frame goes out only after the daemon's stdout and stderr have both drained, so no output is lost behind it.
//
// Only web-standard types, so the tests drive it in Node with a fake process.
import { decodeControl, decodeData, encodeControl, encodeData, FrameError, STDERR, STDIN, STDOUT, type Channel } from "./frame.ts";

/** Where the image puts pi-env's static daemon (container/Dockerfile), the same path as the docker backend's. */
export const DAEMON_PATH = "/opt/pi-env/pi-env";

export type DaemonProcess = {
	readonly stdin: WritableStream<Uint8Array> | null;
	readonly stdout: ReadableStream<Uint8Array> | null;
	readonly stderr: ReadableStream<Uint8Array> | null;
	readonly exitCode: Promise<number>;
	readonly kill: () => void;
};

/** The accepted server end of the socket. */
export type Peer = {
	readonly send: (message: string | Uint8Array) => void;
	readonly close: (code: number, reason: string) => void;
};

export type Relay = {
	readonly onMessage: (data: string | ArrayBuffer | Uint8Array) => void;
	/** The socket closed or failed: the daemon is killed. */
	readonly onClose: () => void;
	/** Ends the relay from this side (a stop): kills the daemon and closes the socket. */
	readonly shutdown: (reason: string) => void;
};

const bytes = (data: ArrayBuffer | Uint8Array): Uint8Array => (data instanceof Uint8Array ? data : new Uint8Array(data));

/** WebSocket close codes: 1000 normal, 1008 policy (a bad frame), 1011 internal (start failed, container lost). */
const NORMAL = 1000;
const POLICY = 1008;
const INTERNAL = 1011;

export const serveRelay = (peer: Peer, launch: (argv: readonly string[]) => Promise<DaemonProcess>, log: (text: string) => void = () => {}): Relay => {
	let state: "waiting" | "running" | "done" = "waiting";
	let process: DaemonProcess | undefined;
	let launched: Promise<WritableStreamDefaultWriter<Uint8Array> | undefined> = Promise.resolve(undefined);
	let stdinChain: Promise<void> = Promise.resolve();
	let stdinEnded = false;

	const finish = (control: { type: "exit"; code: number } | { type: "error"; message: string } | undefined, code: number, reason: string) => {
		if (state === "done") return;
		state = "done";
		try {
			process?.kill();
		} catch {}
		try {
			if (control) peer.send(encodeControl(control));
			peer.close(code, reason);
		} catch {}
	};

	const send = (channel: Channel, chunk: Uint8Array) => {
		if (state !== "running") return;
		for (const message of encodeData(channel, chunk)) peer.send(message);
	};

	const drain = async (stream: ReadableStream<Uint8Array> | null, channel: Channel) => {
		if (!stream) return;
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value.length > 0) send(channel, value);
		}
	};

	const start = (args: readonly string[]) => {
		state = "running";
		launched = launch([DAEMON_PATH, ...args]).then((started) => {
			process = started;
			if (state === "done") {
				started.kill();
				return undefined;
			}
			// Output first, exit after: both streams end before the exit frame goes out.
			void Promise.all([drain(started.stdout, STDOUT), drain(started.stderr, STDERR), started.exitCode]).then(
				([, , exitCode]) => finish({ type: "exit", code: exitCode }, NORMAL, "daemon exited"),
				(error: unknown) => finish({ type: "error", message: `daemon output lost: ${String(error)}` }, INTERNAL, "daemon output lost"),
			);
			return started.stdin?.getWriter();
		});
		launched.catch((error: unknown) => {
			log(`daemon did not start: ${String(error)}`);
			finish({ type: "error", message: `the daemon did not start: ${error instanceof Error ? error.message : String(error)}` }, INTERNAL, "start failed");
		});
	};

	/** Queued behind the launch and every earlier write, so stdin keeps its order. */
	const writeStdin = (data: Uint8Array) => {
		stdinChain = stdinChain.then(async () => {
			const writer = await launched.catch(() => undefined);
			if (!writer || state !== "running") return;
			await writer.write(data);
		});
		stdinChain.catch(() => finish({ type: "error", message: "the daemon's stdin closed" }, INTERNAL, "stdin closed"));
	};

	const endStdin = () => {
		if (stdinEnded) return;
		stdinEnded = true;
		stdinChain = stdinChain.then(async () => {
			const writer = await launched.catch(() => undefined);
			await writer?.close();
		});
		stdinChain.catch(() => {});
	};

	const refuse = (error: unknown) => {
		const message = error instanceof FrameError ? error.message : String(error);
		log(`relay refused a frame: ${message}`);
		finish({ type: "error", message }, POLICY, "bad frame");
	};

	return {
		onMessage: (data) => {
			if (state === "done") return;
			try {
				if (typeof data === "string") {
					const control = decodeControl(data);
					if (state === "waiting") {
						if (control.type !== "start") throw new FrameError("the first frame must be start");
						start(control.args);
						return;
					}
					if (control.type === "eof" && !stdinEnded) return endStdin();
					throw new FrameError(`unexpected ${control.type} frame`);
				}
				if (state === "waiting") throw new FrameError("the first frame must be start");
				if (stdinEnded) throw new FrameError("stdin data after eof");
				const { channel, data: chunk } = decodeData(bytes(data));
				if (channel !== STDIN) throw new FrameError("only stdin travels to the daemon");
				writeStdin(new Uint8Array(chunk));
			} catch (error) {
				refuse(error);
			}
		},
		onClose: () => finish(undefined, NORMAL, "closed"),
		shutdown: (reason) => finish({ type: "error", message: reason }, NORMAL, reason),
	};
};
