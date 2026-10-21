// node bench.ts <stoneId> [runs]: exec round trips from the Beelink, file transfer, and the link alone.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { connect, control, stoneEnv } from "./stone.ts";

const id = process.argv[2] ?? "b0b0b0b0b0b0";
const runs = Number(process.argv[3] ?? 200);
const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const stat = (xs: number[]) => ({ n: xs.length, p50: +q(xs, 0.5).toFixed(1), p95: +q(xs, 0.95).toFixed(1), max: +Math.max(...xs).toFixed(1) });
const time = async (f: () => Promise<unknown>) => { const t = performance.now(); await f(); return performance.now() - t; };

const trace = await (await fetch("https://cairn-s1-stones.oscargabriel.workers.dev/cdn-cgi/trace")).text();
console.log("edge", trace.match(/colo=\w+/)?.[0]);
await control(id, "start");
const connection = connect(id);
const env = stoneEnv(id, connection);
await connection.info();
const out: Record<string, unknown> = {};
const ok = async (p: Promise<{ ok: boolean }>) => { const r = await p; if (!r.ok) throw new Error(JSON.stringify(r)); };
for (let i = 0; i < 10; i++) await ok(env.exec(["true"], {}, context));
const argv: number[] = [], shell: number[] = [], stat1: number[] = [], status: number[] = [];
for (let i = 0; i < runs; i++) argv.push(await time(() => ok(env.exec(["true"], {}, context))));
for (let i = 0; i < runs; i++) shell.push(await time(() => ok(env.exec("true", {}, context))));
for (let i = 0; i < runs; i++) stat1.push(await time(() => ok(env.fileInfo("/workspace", context))));
for (let i = 0; i < 30; i++) status.push(await time(() => control(id)));
out.execArgv = stat(argv); out.execShell = stat(shell); out.fileInfo = stat(stat1); out.httpsStatusCall = stat(status);
const mb10 = new Uint8Array(10 * 1024 * 1024).map((_, i) => (i * 7) & 255);
const w: number[] = [], r: number[] = [];
for (let i = 0; i < 5; i++) { w.push(await time(() => ok(env.writeFile("/workspace/blob", mb10, context)))); r.push(await time(() => ok(env.readBinaryFile("/workspace/blob", context)))); }
out.write10MB = stat(w); out.read10MB = stat(r);
console.log(JSON.stringify(out, null, 1));
connection.close();
