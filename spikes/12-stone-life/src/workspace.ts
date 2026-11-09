// The start wait (`untilStarted`, the "starting" pattern, its budget and poll) is copied from acoyfellow/coil,
// src/computer.ts, commit e142d668ccd43e4b3648a579c0318ad04d266e26, by way of cairn-v1 apps/cloud-sandbox/src/sandbox.ts.
// Changed there: it waits on a sandbox-shim `stat` of the daemon as well as `setInactivityTimeout`. The rest of this
// file is Cairn's own, cut down from v1's CloudSandbox for spike 1, then given options on start, and for spike 12 a cut to R2 and an alarm.
//
// MIT License
//
// Copyright (c) 2026 Jordan Coeyman
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// Workspace: one Durable Object per stone, owning that stone's container (`ctx.container`, Sandbox SDK 1.0's model).
// The Worker has already checked Access and the shared secret before anything reaches it.
//
// - `fetch` takes a relay WebSocket (`/pipe/<id>`) and runs one pi-env daemon for it (src/pump.ts). A pipe only
//   attaches: it never starts a container. `start()` starts it from the stack's one image with no internet.
// - `status()`, `stop()` and `evict()` are RPC from the Worker. `evict()` is the spike's test hook: it flushes and
//   calls `ctx.abort()`, which throws away this instance as a platform eviction would.
import { DurableObject } from "cloudflare:workers";
import { Files } from "@cloudflare/sandbox";
import type { StonesEnv } from "./env.ts";
import { SANDBOX_ID } from "./frame.ts";
import { IMAGE_KEY } from "./image.ts";
import { DAEMON_PATH, serveRelay, type DaemonProcess, type Relay } from "./pump.ts";

const INACTIVITY_MS = 15 * 60_000;
const MAX_PIPES = 4;
const READY_WAIT_MS = 180_000;
const READY_POLL_MS = 1_000;
const STARTING = /not been started|not running|starting/i;
const DAEMON_ENV = {
	HOME: "/tmp",
	PATH: "/usr/local/bin:/usr/bin:/bin",
	LANG: "C.UTF-8",
	GIT_AUTHOR_NAME: "Cairn",
	GIT_AUTHOR_EMAIL: "cairn@localhost",
	GIT_COMMITTER_NAME: "Cairn",
	GIT_COMMITTER_EMAIL: "cairn@localhost",
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const untilStarted = async <A>(attempt: () => Promise<A>): Promise<A> => {
	const deadline = Date.now() + READY_WAIT_MS;
	for (;;) {
		try {
			return await attempt();
		} catch (cause) {
			if (!STARTING.test(String(cause)) || Date.now() >= deadline) throw cause;
			await pause(READY_POLL_MS);
		}
	}
};

export type Instance = "standard-1" | "standard-2" | "standard-3" | "standard-4";
export type StartOptions = { readonly instance: Instance; readonly internet: boolean; readonly snapshotId?: string };
export type CutInput = { readonly repo: string; readonly key: string; readonly wrongSha?: boolean };
export type CutResult = { readonly key: string; readonly size: number; readonly sha256: string; readonly bundleMs: number; readonly putMs: number };
export type ArmInput = { readonly everyMs: number; readonly safetyCut?: CutInput };
export type WorkspaceStatus = { readonly running: boolean; readonly pipes: number; readonly born: number; readonly alarmsFired: number };

const ARM_KEY = "arm";
const FIRED_KEY = "alarmsFired";

export class Workspace extends DurableObject<StonesEnv> {
	readonly #pipes = new Set<Relay>();
	#starting: Promise<Container> | undefined;
	#phases: { readonly firstAnswerMs: number; readonly shimMs: number } | undefined;
	/** When this instance was made: a new value after an eviction. */
	readonly #born = Date.now();

	constructor(ctx: DurableObjectState, env: StonesEnv) {
		super(ctx, env);
		// The inactivity timeout belongs to the instance, so a new one sets it again (research 02).
		if (ctx.container?.running) void ctx.container.setInactivityTimeout(INACTIVITY_MS).catch(() => {});
	}

	#ensure(stoneId: string, start: StartOptions | false): Promise<Container> {
		const container = this.ctx.container;
		if (!container) return Promise.reject(new Error("this Durable Object has no container binding"));
		if (container.running && !this.#starting) return Promise.resolve(container);
		if (!start && !container.running && !this.#starting) return Promise.reject(new Error("the container is not running"));
		this.#starting ??= (async () => {
			if (!container.running) {
				if (!start) throw new Error("the container is not running");
				const shared = { enableInternet: start.internet, instance: start.instance, labels: { app: "cairn", stone: stoneId } };
				if (start.snapshotId !== undefined) {
					container.start({ ...shared, containerSnapshot: { id: start.snapshotId } });
				} else {
					const image = container.images[IMAGE_KEY];
					if (!image) throw new Error(`no ${IMAGE_KEY} image is bound to this class`);
					container.start({ ...shared, image });
				}
			}
			const begun = Date.now();
			await untilStarted(() => container.setInactivityTimeout(INACTIVITY_MS));
			const answered = Date.now();
			const daemon = await untilStarted(() => new Files(container).stat(DAEMON_PATH));
			this.#phases = { firstAnswerMs: answered - begun, shimMs: Date.now() - answered };
			if (daemon.type !== "file") throw new Error(`${DAEMON_PATH} is not a file in the image`);
			return container;
		})().finally(() => {
			this.#starting = undefined;
		});
		return this.#starting;
	}

	async #launch(stoneId: string, argv: readonly string[]): Promise<DaemonProcess> {
		const container = await this.#ensure(stoneId, false);
		const process = await untilStarted(() =>
			container.exec([...argv], { cwd: "/workspace", env: DAEMON_ENV, stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
		);
		return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, exitCode: process.exitCode, kill: () => process.kill() };
	}

	override async fetch(request: Request): Promise<Response> {
		const [, area, stoneId, ...rest] = new URL(request.url).pathname.split("/");
		if (area !== "pipe" || !stoneId || !SANDBOX_ID.test(stoneId) || rest.length > 0) return new Response("Not found\n", { status: 404 });
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket\n", { status: 426 });
		if (this.#pipes.size >= MAX_PIPES) return new Response("Too many pipes to this stone\n", { status: 429 });
		const { 0: client, 1: server } = new WebSocketPair();
		server.accept();
		server.binaryType = "arraybuffer";
		const relay = serveRelay(
			{ send: (message) => server.send(message), close: (code, reason) => server.close(code, reason) },
			(argv) => this.#launch(stoneId, argv),
			(text) => console.log(`stone ${stoneId}: ${text}`),
		);
		this.#pipes.add(relay);
		const closed = () => {
			this.#pipes.delete(relay);
			relay.onClose();
		};
		server.addEventListener("message", (event) => relay.onMessage(event.data));
		server.addEventListener("close", closed);
		server.addEventListener("error", closed);
		return new Response(null, { status: 101, webSocket: client });
	}

	async start(stoneId: string, options: StartOptions): Promise<{ readonly firstAnswerMs: number; readonly shimMs: number } | undefined> {
		await this.#ensure(stoneId, options);
		return this.#phases;
	}

	/**
	 * One cut, made by this object with no brain needed: bundle every ref in the stone's repo, then put it in R2 under
	 * the bundle's own sha256, so a torn or wrong upload stores nothing.
	 */
	async cut(input: CutInput): Promise<CutResult> {
		const container = this.ctx.container;
		if (!container?.running) throw new Error("the container is not running");
		const t0 = Date.now();
		const shell = await container.exec(["sh", "-c", `cd ${input.repo} && git bundle create -q /cairn/cut.bundle --all && sha256sum /cairn/cut.bundle | cut -d' ' -f1 && stat -c %s /cairn/cut.bundle`], { env: DAEMON_ENV });
		const { stdout, stderr, exitCode } = await shell.output();
		const decoder = new TextDecoder();
		if (exitCode !== 0) throw new Error(`bundle failed: ${decoder.decode(stderr).slice(0, 300)}`);
		const [sha256 = "", sizeText = "0"] = decoder.decode(stdout).trim().split("\n");
		const size = Number(sizeText);
		const bundled = Date.now();
		const body = (await new Files(container).readFile("/cairn/cut.bundle")).body;
		if (!body) throw new Error("the bundle has no body");
		const sized = new FixedLengthStream(size);
		const piped = body.pipeTo(sized.writable);
		const put = this.env.RESULTS.put(input.key, sized.readable, { sha256: input.wrongSha ? "0".repeat(64) : sha256 });
		await Promise.all([piped, put]);
		return { key: input.key, size, sha256, bundleMs: bundled - t0, putMs: Date.now() - bundled };
	}

	/** Arms the object's alarm: `everyMs` re-arms it, and `safetyCut` makes its first firing cut with no brain present. */
	async arm(input: ArmInput): Promise<Record<string, never>> {
		await this.ctx.storage.put(ARM_KEY, input);
		await this.ctx.storage.setAlarm(Date.now() + input.everyMs);
		return {};
	}

	override async alarm(): Promise<void> {
		const armed = await this.ctx.storage.get<ArmInput>(ARM_KEY);
		if (!armed) return;
		await this.ctx.storage.put(FIRED_KEY, ((await this.ctx.storage.get<number>(FIRED_KEY)) ?? 0) + 1);
		const container = this.ctx.container;
		if (!container?.running) return;
		await container.setInactivityTimeout(INACTIVITY_MS);
		if (armed.safetyCut) {
			await this.cut(armed.safetyCut);
			await this.ctx.storage.put(ARM_KEY, { everyMs: armed.everyMs });
		}
		await this.ctx.storage.setAlarm(Date.now() + armed.everyMs);
	}

	async status(): Promise<WorkspaceStatus> {
		return { running: this.ctx.container?.running ?? false, pipes: this.#pipes.size, born: this.#born, alarmsFired: (await this.ctx.storage.get<number>(FIRED_KEY)) ?? 0 };
	}

	/** Throws this instance away, as an eviction would. The container is left as it is. */
	async evict(): Promise<void> {
		await this.ctx.storage.sync();
		this.ctx.abort("evicted by the spike");
	}

	async stop(): Promise<boolean> {
		for (const relay of this.#pipes) relay.shutdown("the stone stopped");
		this.#pipes.clear();
		const container = this.ctx.container;
		if (!container?.running) return false;
		await container.destroy();
		return true;
	}
}
