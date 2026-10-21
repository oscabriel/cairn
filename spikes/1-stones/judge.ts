// Spike 1's eviction judge: node judge.ts. One new stone, three cases (brain.ts), one verdict line each.
//   inflight:  evict the Workspace while the stock bash tool (unsafe) runs a 20 s command on the stone.
//   between:   evict it while the turn is in a tool that doesn't touch the stone.
//   brainkill: kill -9 the brain while bash runs, then start it again.
// Pass: the turn finishes, the next bash works on the same container (same boot id, its files there), and the
// interrupted bash ran exactly once (one "start" mark) and was never rerun.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { connect, control, stoneEnv } from "./stone.ts";

const stoneId = process.env.STONE ?? randomBytes(6).toString("hex");
const root = join(import.meta.dirname, "runs", `judge-${Date.now()}`);
mkdirSync(root, { recursive: true });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const probeConnection = connect(stoneId);
const probe = stoneEnv(stoneId, probeConnection);

const sh = async (command: string): Promise<string> => {
	for (let attempt = 0; ; attempt++) {
		const out: string[] = [];
		const result = await probe.exec(command, { onOutput: (s: string) => out.push(s) } as never, context);
		if (result.ok) return out.join("");
		if (attempt >= 5) throw new Error(`probe: ${JSON.stringify(result.error)}`);
		await sleep(500);
	}
};
const events = (dir: string) =>
	existsSync(join(dir, "events.log"))
		? readFileSync(join(dir, "events.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { t: number; pid: number; kind: string; data: any })
		: [];
const brain = (dir: string, submit?: string): ChildProcess =>
	spawn("node", [join(import.meta.dirname, "brain.ts"), dir, stoneId, ...(submit ? ["submit", submit] : [])], { stdio: "ignore" });
const exited = (child: ChildProcess, ms: number) =>
	new Promise<boolean>((done) => {
		const timer = setTimeout(() => done(false), ms);
		child.once("exit", () => {
			clearTimeout(timer);
			done(true);
		});
	});
const until = async (what: string, test: () => Promise<boolean> | boolean, ms = 60_000) => {
	const deadline = Date.now() + ms;
	while (!(await test())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(200);
	}
};
const bootOf = (text: string) => /boot (\S+)/.exec(text)?.[1];

const t0 = Date.now();
await control(stoneId, "start");
console.log(JSON.stringify({ stone: stoneId, coldStartMs: Date.now() - t0 }));
const bootBefore = bootOf(await sh("echo boot $(cat /proc/sys/kernel/random/boot_id)"));
const verdicts: unknown[] = [];

for (const name of ["inflight", "between", "brainkill"] as const) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	let child = brain(dir, name);
	const bornBefore = (await control(stoneId)).born;
	let hitAt = 0;
	if (name === "between") {
		await until("the pause", () => events(dir).some((e) => e.kind === "pausing"));
	} else {
		await until("the first mark", async () => (await sh(`cat /workspace/marks-${name} 2>/dev/null || true`)).includes("start"));
	}
	await sleep(1500);
	if (name === "brainkill") {
		hitAt = Date.now();
		child.kill("SIGKILL");
		await exited(child, 5000);
		await sleep(1000);
		child = brain(dir);
	} else {
		hitAt = Date.now();
		await control(stoneId, "evict");
	}
	const finished = await exited(child, 120_000);
	const log = events(dir);
	const results = log.filter((e) => e.kind === "tool_result").map((e) => e.data as { tool: string; isError: boolean; text: string });
	const doneAt = log.find((e) => e.kind === "final")?.t ?? 0;
	const marks = await sh(`cat /workspace/marks-${name} 2>/dev/null || true`);
	const starts = marks.split("\n").filter((l) => l.startsWith("start")).length;
	const ends = marks.split("\n").filter((l) => l === "end").length;
	const last = results.at(-1);
	const bornAfter = (await control(stoneId)).born;
	const verdict = {
		case: name,
		finished,
		final: log.find((e) => e.kind === "final")?.data,
		firstResult: results[0],
		lastResult: last,
		starts,
		ends,
		sameContainer: last !== undefined && !last.isError && bootOf(last.text) === bootBefore,
		evicted: name === "brainkill" ? undefined : bornAfter !== bornBefore,
		turnDoneAfterMs: doneAt > 0 ? doneAt - hitAt : undefined,
		pass:
			finished &&
			last !== undefined &&
			!last.isError &&
			bootOf(last.text) === bootBefore &&
			(name === "between" || (starts === 1 && results[0]?.isError === true)) &&
			(name === "brainkill" || bornAfter !== bornBefore),
	};
	verdicts.push(verdict);
	console.log(JSON.stringify(verdict));
}

writeFileSync(join(root, "verdicts.json"), `${JSON.stringify({ stoneId, bootBefore, verdicts }, null, 1)}\n`);
probeConnection.close();
await control(stoneId, "stop");
const orphans = await new Promise<string>((done) => {
	const ps = spawn("pgrep", ["-af", "relay/pipe.ts"]);
	let out = "";
	ps.stdout.on("data", (d) => (out += d));
	ps.on("exit", () => done(out.trim()));
});
console.log(JSON.stringify({ orphanRelays: orphans === "" ? 0 : orphans.split("\n").length, pass: verdicts.every((v: any) => v.pass) }));
process.exit(0);
