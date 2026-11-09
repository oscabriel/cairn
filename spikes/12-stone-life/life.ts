// Spike 12: what a stone's life rests on. No snapshots here, so nothing is left behind that cannot be deleted.
//
//   node life.ts alarm              does a container outlive an eviction with no request after it, with and without an alarm?
//   node life.ts cut                one cut through R2 at 1 MiB (20 times), 100 MiB (3) and 1 GiB (1), fetched and checked at home
//   node life.ts evict              an eviction during the put: nothing partial may be stored
//   node life.ts badsum             a wrong checksum: nothing may be stored
//   node life.ts safety             a cut from the object's alarm, with no brain connected and no request
//   node life.ts sweep              stop every stone this spike started, and delete what it stored
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { connect, control, objectBytes, objectDelete, objectHead, stoneEnv } from "./stone.ts";

const RUNS = join(import.meta.dirname, "runs");
const STONES = join(RUNS, "stones.jsonl");
const KEYS = join(RUNS, "keys.jsonl");
const RESULTS = join(RUNS, "results.jsonl");
const REPO = "/cairn/workspace/repo";
const MINUTE = 60_000;
const SIZE = "standard-2";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const now = () => performance.now();
const record = (row: object) => {
	appendFileSync(RESULTS, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
	console.log(JSON.stringify(row));
};

type Env = ReturnType<typeof stoneEnv>;
const sh = async (env: Env, command: string): Promise<string> => {
	const output: string[] = [];
	const result = await env.exec(command, { onOutput: (text: string) => output.push(text) } as never, context);
	const text = output.join("").trim();
	if (!result.ok) throw new Error(`${command.slice(0, 80)}: ${JSON.stringify((result as { error?: unknown }).error)} ${text.slice(-300)}`);
	return text;
};

const begin = async () => {
	const id = randomBytes(6).toString("hex");
	appendFileSync(STONES, `${JSON.stringify({ id })}\n`);
	await control(id, "start", { instance: SIZE, internet: false });
	const connection = connect(id);
	return { id, connection, env: stoneEnv(id, connection) };
};

const makeRepo = async (env: Env, megabytes: number) => {
	await sh(env, `mkdir -p ${REPO} && cd ${REPO} && git init -q && head -c ${megabytes}M /dev/urandom > blob && git add blob && git -c user.name=s -c user.email=s@x commit -qm blob`);
};

const key = (name: string) => {
	const value = `s12/${name}-${randomBytes(4).toString("hex")}`;
	appendFileSync(KEYS, `${JSON.stringify({ key: value })}\n`);
	return value;
};

/** Case A: `ctx.abort()`, then silence. The first request after it is the check. */
const alarmCase = async (minutes: number, withAlarm: boolean) => {
	const { id, connection, env } = await begin();
	const boot = await sh(env, "cat /proc/sys/kernel/random/boot_id");
	await sh(env, "setsid nohup sh -c 'while true; do date +%s > /cairn/beat; sleep 5; done' > /dev/null 2>&1 < /dev/null &");
	connection.close();
	if (withAlarm) await control(id, "arm", { everyMs: MINUTE });
	await control(id, "evict");
	await sleep(minutes * MINUTE);
	const status = await control(id);
	const row: Record<string, unknown> = { test: "alarm", minutes, withAlarm, running: status.running, alarmsFired: status.alarmsFired };
	if (status.running) {
		const later = connect(id);
		const envLater = stoneEnv(id, later);
		row.sameBoot = (await sh(envLater, "cat /proc/sys/kernel/random/boot_id")) === boot;
		row.beatAgeSeconds = Number(await sh(envLater, "echo $(( $(date +%s) - $(cat /cairn/beat) ))"));
		later.close();
	}
	await control(id, "stop").catch(() => {});
	record(row);
};

const cutOnce = async (id: string, label: string) => {
	const name = key(label);
	const t0 = now();
	const cut = await control(id, "cut", { repo: REPO, key: name });
	const stored = now();
	const response = await objectBytes(name);
	if (!response.ok) throw new Error(`download ${response.status}`);
	const hash = createHash("sha256");
	let bytes = 0;
	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		hash.update(chunk);
		bytes += chunk.length;
	}
	const fetched = now();
	const matches = hash.digest("hex") === cut.sha256 && bytes === cut.size;
	await objectDelete(name);
	return { size: cut.size, bundleMs: cut.bundleMs, putMs: cut.putMs, cutMs: Math.round(stored - t0), fetchMs: Math.round(fetched - stored), totalMs: Math.round(fetched - t0), matches };
};

const cuts = async () => {
	for (const [megabytes, times] of [[1, 20], [100, 3], [1024, 1]] as const) {
		const { id, connection, env } = await begin();
		const t0 = now();
		await makeRepo(env, megabytes);
		console.log(`repo ${megabytes} MiB in ${Math.round(now() - t0)} ms`);
		for (let i = 0; i < times; i++) {
			try {
				record({ test: "cut", megabytes, ...(await cutOnce(id, `cut${megabytes}`)) });
			} catch (cause) {
				record({ test: "cut", megabytes, error: String(cause).slice(0, 300) });
			}
		}
		connection.close();
		await control(id, "stop");
	}
};

const evictDuringPut = async () => {
	const { id, connection, env } = await begin();
	await makeRepo(env, 100);
	for (const delay of [6000, 8000, 10000, 12000, 14000]) {
		const name = key("evict");
		const cutting = control(id, "cut", { repo: REPO, key: name }).then(() => "finished", (cause: unknown) => `ended: ${String(cause).slice(0, 90)}`);
		await sleep(delay);
		await control(id, "evict");
		const outcome = await cutting;
		const stored = await objectHead(name);
		// The bundle is about 100 MiB: anything stored must be all of it, and carry its checksum.
		record({ test: "evict", delay, outcome, stored });
		if (stored) await objectDelete(name);
		await sleep(2000);
	}
	const after = await cutOnce(id, "afterEvict");
	record({ test: "evict-then-cut", ...after });
	connection.close();
	await control(id, "stop");
};

const badChecksum = async () => {
	const { id, connection, env } = await begin();
	await makeRepo(env, 1);
	const name = key("badsum");
	const outcome = await control(id, "cut", { repo: REPO, key: name, wrongSha: true }).then(() => "stored", (cause: unknown) => `refused: ${String(cause).slice(0, 120)}`);
	const stored = await objectHead(name);
	record({ test: "badsum", outcome, stored, pass: stored === null });
	if (stored) await objectDelete(name);
	connection.close();
	await control(id, "stop");
};

const safety = async () => {
	const { id, connection, env } = await begin();
	await makeRepo(env, 10);
	const name = key("safety");
	await control(id, "arm", { everyMs: MINUTE, safetyCut: { repo: REPO, key: name } });
	connection.close();
	await control(id, "evict");
	const before = await objectHead(name);
	const t0 = now();
	let stored = null;
	while (stored === null && now() - t0 < 4 * MINUTE) {
		await sleep(5000);
		stored = await objectHead(name);
	}
	record({ test: "safety", storedBeforeAlarm: before, stored, seconds: Math.round((now() - t0) / 1000), pass: before === null && stored !== null });
	if (stored) await objectDelete(name);
	await control(id, "stop");
};

const sweep = async () => {
	const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, string>) : []);
	const stopped = [];
	for (const { id } of lines(STONES)) if (id && (await control(id, "stop").catch(() => ({ stopped: false }))).stopped) stopped.push(id);
	const left = [];
	for (const { key: name } of lines(KEYS)) {
		if (name && (await objectHead(name))) {
			left.push(name);
			await objectDelete(name);
		}
	}
	console.log(JSON.stringify({ stopped, deletedObjects: left }));
};

const command = process.argv[2];
if (command === "alarm") await Promise.all([1, 2, 5, 10].flatMap((minutes) => [alarmCase(minutes, true), alarmCase(minutes, false)]));
else if (command === "cut") await cuts();
else if (command === "evict") await evictDuringPut();
else if (command === "badsum") await badChecksum();
else if (command === "safety") await safety();
else if (command === "sweep") await sweep();
else throw new Error(`unknown command ${String(command)}`);
process.exit(0);
