// Spike 11, part A: does a stone start from a snapshot of a real project in under 5 s (Stone start target)?
//
//   node restore.ts prepare          make the base and delta bundles from Cairn's own main, on the Beelink
//   node restore.ts build            one new stone: clone, Node 26, pnpm install, then the box is ready to capture
//   node restore.ts capture          the one snapshot, recorded in runs/base.json and in the object
//   node restore.ts bare <n>         control: n stones from the plain image, on the same path
//   node restore.ts seq <n> [size]   n stones from the snapshot, one at a time
//   node restore.ts burst <n> [size] n stones from the snapshot at once
//   node restore.ts sweep            stop every stone this spike started that is still running
//
// A trial's clock runs from the launch command to the first tool call after the stone has its commits and branch.
// The tree check after it is what stops a fast restore of an empty disk from passing.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { connect, control, stoneEnv } from "./stone.ts";

const RUNS = join(import.meta.dirname, "runs");
const CAIRN = join(import.meta.dirname, "../..");
const REPO = join(RUNS, "repo.git");
const BASE_BUNDLE = join(RUNS, "base.bundle");
const DELTA_BUNDLE = join(RUNS, "delta.bundle");
const BASE_JSON = join(RUNS, "base.json");
const STONES = join(RUNS, "stones.jsonl");
const TRIALS = join(RUNS, "trials.jsonl");
const BUILDER = "ba5e00000011";
const TIP = "a160935";
const BEHIND = 20;
const DEFAULT_SIZE = "standard-2";
const MIN_FILES = 100_000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const note = (id: string) => appendFileSync(STONES, `${JSON.stringify({ id, at: new Date().toISOString() })}\n`);
const now = () => performance.now();

type Env = ReturnType<typeof stoneEnv>;
const sh = async (env: Env, command: string): Promise<string> => {
	const output: string[] = [];
	const result = await env.exec(command, { onOutput: (text: string) => output.push(text) } as never, context);
	const text = output.join("").trim();
	if (!result.ok) {
		const error = (result as { error?: unknown }).error;
		throw new Error(`${command.slice(0, 60)}: ${JSON.stringify(error)} ${error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : ""} ${text.slice(-300)}`);
	}
	return text;
};

const TOOLS = "export HOME=/cairn/home PATH=/cairn/node/bin:/cairn/bin:/usr/local/bin:/usr/bin:/bin COREPACK_HOME=/cairn/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/cairn/pnpm";

const prepare = () => {
	mkdirSync(RUNS, { recursive: true });
	if (!existsSync(REPO)) execFileSync("git", ["clone", "--quiet", "--bare", CAIRN, REPO]);
	const git = (...args: string[]) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
	git("update-ref", "refs/heads/tip", TIP);
	git("update-ref", "refs/heads/base", `${TIP}~${BEHIND}`);
	git("bundle", "create", "--quiet", BASE_BUNDLE, "refs/heads/base");
	git("bundle", "create", "--quiet", DELTA_BUNDLE, "refs/heads/tip", "^refs/heads/base");
	console.log(JSON.stringify({ base: git("rev-parse", "refs/heads/base"), tip: git("rev-parse", "refs/heads/tip"), baseBytes: readFileSync(BASE_BUNDLE).length, deltaBytes: readFileSync(DELTA_BUNDLE).length }));
};

/** Runs on the stone, detached, so an eviction during the install cannot end it. */
const SETUP = () => `#!/bin/sh
set -eu
${TOOLS}
mkdir -p /cairn/home /cairn/bin /cairn/corepack /cairn/pnpm
cd /cairn
# The image's Node 24: the official Node 26 binary needs libatomic.so.1, which the image lacks (see NOTES.md).
node --version
corepack enable --install-directory /cairn/bin pnpm
git clone --quiet --branch base /cairn/base.bundle /cairn/workspace/cairn
cd /cairn/workspace/cairn
git config user.name Cairn
git config user.email cairn@localhost
# No build scripts: the tree's size and shape are what this measures, and the image has no compilers.
CI=1 pnpm install --frozen-lockfile --ignore-scripts --store-dir /cairn/pnpm-store
du -sh /cairn/workspace/cairn /cairn/pnpm-store
find /cairn/workspace/cairn | wc -l
`;

const build = async () => {
	note(BUILDER);
	// A retry starts on a fresh disk, and the object refuses to build over a capture it already holds.
	if ((await control(BUILDER)).snapshot) throw new Error("this builder already captured its one snapshot");
	await control(BUILDER, "stop");
	const t0 = now();
	await control(BUILDER, "start", { instance: DEFAULT_SIZE, internet: true });
	const connection = connect(BUILDER);
	const env = stoneEnv(BUILDER, connection);
	const write = async (path: string, bytes: Uint8Array) => {
		const result = await env.writeFile(path, bytes, context);
		if (!result.ok) throw new Error(`${path}: ${JSON.stringify(result)}`);
	};
	await write("/cairn/base.bundle", readFileSync(BASE_BUNDLE));
	await write("/cairn/setup.sh", new TextEncoder().encode(SETUP()));
	await sh(env, "setsid nohup sh -c 'sh /cairn/setup.sh; echo $? > /cairn/setup.exit' > /cairn/setup.log 2>&1 < /dev/null &");
	for (;;) {
		await sleep(10_000);
		// The exit file is the only signal: a pgrep for the script matches this very command.
		const exit = await sh(env, "cat /cairn/setup.exit 2>/dev/null || true");
		const seconds = Math.round((now() - t0) / 1000);
		console.log(`${seconds}s ${(await sh(env, "tail -n 1 /cairn/setup.log")).slice(0, 160)}`);
		if (exit === "0") break;
		if (exit !== "") throw new Error(`setup exited ${exit}:\n${await sh(env, "tail -n 40 /cairn/setup.log")}`);
		if (seconds > 1500) throw new Error("setup passed 25 minutes");
	}
	console.log(await sh(env, "tail -n 8 /cairn/setup.log; rm -f /cairn/base.bundle /cairn/setup.sh; df -h /cairn | tail -n 1"));
	connection.close();
	console.log(JSON.stringify({ buildSeconds: Math.round((now() - t0) / 1000) }));
};

const capture = async () => {
	const status = await control(BUILDER);
	if (status.snapshot) {
		writeFileSync(BASE_JSON, JSON.stringify(status.snapshot));
		console.log("already captured", JSON.stringify(status.snapshot));
		return;
	}
	const t0 = now();
	const record = await control(BUILDER, "snapshot", { name: "s11-cairn" });
	writeFileSync(BASE_JSON, JSON.stringify(record));
	console.log(JSON.stringify({ ...record, captureSeconds: +((now() - t0) / 1000).toFixed(1) }));
	await control(BUILDER, "stop");
};

const trial = async (mode: "bare" | "snapshot", size: string, label: string) => {
	const id = randomBytes(6).toString("hex");
	note(id);
	const record = { label, mode, size, id, at: new Date().toISOString() } as Record<string, unknown>;
	const connection = connect(id);
	const env = stoneEnv(id, connection);
	try {
		const t0 = now();
		const snapshotId = mode === "snapshot" ? (JSON.parse(readFileSync(BASE_JSON, "utf8")) as { id: string }).id : undefined;
		const phases = await control(id, "start", { instance: size, internet: false, ...(snapshotId ? { snapshotId } : {}) });
		const started = now();
		Object.assign(record, phases);
		await sh(env, "true");
		const hello = now();
		if (mode === "snapshot") {
			const written = await env.writeFile("/cairn/delta.bundle", readFileSync(DELTA_BUNDLE), context);
			if (!written.ok) throw new Error(JSON.stringify(written));
			const delta = now();
			await sh(env, `${TOOLS}; cd /cairn/workspace/cairn && git fetch --quiet /cairn/delta.bundle refs/heads/tip && git switch --quiet -c stone/${id} FETCH_HEAD`);
			record.fetchSwitchMs = Math.round(now() - delta);
			record.deltaWriteMs = Math.round(delta - hello);
		}
		await sh(env, "true");
		const done = now();
		Object.assign(record, { startMs: Math.round(started - t0), helloMs: Math.round(hello - started), totalMs: Math.round(done - t0), ok: true });
		if (mode === "snapshot") {
			const timed = async (name: string, command: string) => {
				const t = now();
				const text = await sh(env, `${TOOLS}; cd /cairn/workspace/cairn && ${command}`);
				record[`${name}Ms`] = Math.round(now() - t);
				return text;
			};
			record.head = await timed("revParse", "git rev-parse HEAD");
			await timed("gitStatus", "git status --short | wc -l");
			await timed("importEffect", `cd apps/server && node -e "import('effect').then(()=>0)"`);
			record.files = Number(await timed("findFiles", "find . | wc -l"));
			if (Number(record.files) < MIN_FILES) throw new Error(`only ${String(record.files)} files came back`);
		}
	} catch (cause) {
		Object.assign(record, { ok: false, error: String(cause).slice(0, 400) });
	} finally {
		connection.close();
		await control(id, "stop").catch((cause: unknown) => {
			record.stopError = String(cause).slice(0, 200);
		});
	}
	appendFileSync(TRIALS, `${JSON.stringify(record)}\n`);
	return record;
};

const quantile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(p * values.length))];
const summarize = (rows: Record<string, unknown>[]) => {
	const ok = rows.filter((row) => row.ok);
	const stat = (key: string) => {
		const values = ok.map((row) => row[key]).filter((v): v is number => typeof v === "number");
		return values.length === 0 ? undefined : { p50: quantile(values, 0.5), p95: quantile(values, 0.95), max: Math.max(...values) };
	};
	console.log(JSON.stringify({ n: rows.length, ok: ok.length, errors: rows.filter((row) => !row.ok).map((row) => row.error), total: stat("totalMs"), start: stat("startMs"), hello: stat("helloMs"), fetchSwitch: stat("fetchSwitchMs"), gitStatus: stat("gitStatusMs"), importEffect: stat("importEffectMs"), findFiles: stat("findFilesMs"), files: ok[0]?.files }, null, 1));
};

const sweep = async () => {
	const ids = existsSync(STONES) ? [...new Set(readFileSync(STONES, "utf8").trim().split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { id: string }).id))] : [];
	const stopped = [];
	for (const id of ids) if ((await control(id, "stop").catch(() => ({ stopped: false }))).stopped) stopped.push(id);
	console.log(JSON.stringify({ known: ids.length, stopped }));
};

const [command, count, size] = process.argv.slice(2);
const n = Number(count ?? 1);
const label = `${command}-${new Date().toISOString()}`;
if (command === "prepare") prepare();
else if (command === "build") await build();
else if (command === "capture") await capture();
else if (command === "bare") {
	const rows = [];
	for (let i = 0; i < n; i++) rows.push(await trial("bare", size ?? DEFAULT_SIZE, label));
	summarize(rows);
} else if (command === "seq") {
	const rows = [];
	for (let i = 0; i < n; i++) {
		rows.push(await trial("snapshot", size ?? DEFAULT_SIZE, label));
		console.log(JSON.stringify(rows.at(-1)).slice(0, 220));
	}
	summarize(rows);
} else if (command === "burst") summarize(await Promise.all(Array.from({ length: n }, () => trial("snapshot", size ?? DEFAULT_SIZE, label))));
else if (command === "sweep") await sweep();
else throw new Error(`unknown command ${String(command)}`);
process.exit(0);
