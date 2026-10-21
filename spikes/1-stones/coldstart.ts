// node coldstart.ts [n]: n new stones, each timed from `start` to the first exec over the relay, then stopped.
// Then one detached process across an eviction: does it outlive the Durable Object instance that started it?
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { control, stoneEnv } from "./stone.ts";
const n = Number(process.argv[2] ?? 5);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const rows = [];
for (let i = 0; i < n; i++) {
	const id = randomBytes(6).toString("hex");
	const t0 = performance.now();
	await control(id, "start");
	const t1 = performance.now();
	const env = stoneEnv(id);
	const r = await env.exec(["true"], {}, context);
	const t2 = performance.now();
	rows.push({ id, startMs: Math.round(t1 - t0), firstExecMs: Math.round(t2 - t1), totalMs: Math.round(t2 - t0), ok: r.ok });
	env.connection.close();
	await control(id, "stop");
}
console.log(JSON.stringify(rows));
const id = randomBytes(6).toString("hex");
await control(id, "start");
const env = stoneEnv(id);
const out: string[] = [];
const sh = async (c: string) => { out.length = 0; const r = await env.exec(c, { onOutput: (s: string) => out.push(s) } as never, context); return r.ok ? out.join("").trim() : `error ${JSON.stringify(r.error)}`; };
await sh("setsid nohup sh -c 'sleep 25; echo done > /workspace/detached' > /dev/null 2>&1 < /dev/null &");
await sh("nohup sh -c 'sleep 25; echo done > /workspace/attached' > /dev/null 2>&1 < /dev/null &");
await control(id, "evict");
await sleep(30_000);
console.log(JSON.stringify({ detached: await sh("cat /workspace/detached 2>&1"), nohupChild: await sh("cat /workspace/attached 2>&1") }));
env.connection.close();
await control(id, "stop");
process.exit(0);
