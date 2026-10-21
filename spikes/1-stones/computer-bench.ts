// node computer-bench.ts: @cloudflare/computer's filesystem (src/computer.ts) against the stone's daemon, from the
// Beelink, for the light work a stone's read, write and grep tools do. Computer calls are one HTTPS request each
// (Worker, then the Durable Object); the stone's go over the open relay.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { CREDENTIALS, control, stoneEnv } from "./stone.ts";
const c = JSON.parse(readFileSync(CREDENTIALS, "utf8"));
const base = c.url.replace(/^wss:/, "https:");
const headers = { "CF-Access-Client-Id": c.clientId, "CF-Access-Client-Secret": c.clientSecret, Authorization: `Bearer ${c.secret}`, "content-type": "application/json" };
const id = randomBytes(6).toString("hex");
const call = async (op: string, body?: object, query = "") => {
	const r = await fetch(`${base}/computer/${id}/${op}${query}`, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}) });
	if (!r.ok) throw new Error(`${op} ${r.status} ${(await r.text()).slice(0, 300)}`);
	return r.json() as Promise<Record<string, number>>;
};
const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * xs.length)]!;
const stat = (xs: number[]) => ({ p50: +q(xs, 0.5).toFixed(1), p95: +q(xs, 0.95).toFixed(1) });
const time = async (f: () => Promise<unknown>) => { const t = performance.now(); await f(); return performance.now() - t; };
const body = "export const x = 1;\n".repeat(200);
const out: Record<string, unknown> = {};
const cw: number[] = [], cr: number[] = [], inDo: number[] = [];
for (let i = 0; i < 100; i++) cw.push(await time(() => call("write", { path: `/f${i}.ts`, content: body })));
for (let i = 0; i < 100; i++) cr.push(await time(async () => inDo.push((await call("read", undefined, `?path=/f${i}.ts`)).ms)));
const grep: number[] = [];
for (let i = 0; i < 10; i++) grep.push(await time(() => call("grep", { pattern: "x = 1", path: "/" })));
out.computer = { write4KB: stat(cw), read4KB: stat(cr), readInsideDO: stat(inDo), grep100Files: stat(grep) };
await control(id, "start");
const env = stoneEnv(id);
await env.createDir("/workspace/src", { recursive: true }, context);
const sw: number[] = [], sr: number[] = [], sg: number[] = [];
for (let i = 0; i < 100; i++) sw.push(await time(() => env.writeFile(`/workspace/src/f${i}.ts`, body, context)));
for (let i = 0; i < 100; i++) sr.push(await time(() => env.readTextFile(`/workspace/src/f${i}.ts`, context)));
for (let i = 0; i < 10; i++) sg.push(await time(() => env.exec("grep -rl 'x = 1' /workspace/src | wc -l", {}, context)));
out.stone = { write4KB: stat(sw), read4KB: stat(sr), grep100Files: stat(sg) };
console.log(JSON.stringify(out, null, 1));
env.connection.close();
await control(id, "stop");
process.exit(0);
