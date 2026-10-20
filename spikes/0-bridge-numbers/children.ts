// Spike 0: what one headless `claude` child costs, the way the bridge runs it.
//   node children.ts <n>     n concurrent children: one short turn each, then parked with the prompt stream open
// Prints one JSON line per event and a summary line. PARK_MS holds the parked state; MODEL picks the model.
// The bridge keeps a query parked across pi turns, so the parked RSS is the number that sets the child cap.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const n = Number(process.argv[2] ?? 1);
const model = process.env.MODEL ?? "claude-sonnet-5-5";
const parkMs = Number(process.env.PARK_MS ?? 5000);
const cwd = join(import.meta.dirname, "runs", "workspace");
mkdirSync(cwd, { recursive: true });

// The bridge's isolation: no user settings or hooks, no ANTHROPIC_* (so the CLI uses its own login), no extra traffic.
const env: Record<string, string | undefined> = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith("ANTHROPIC_")),
);
env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
env.ENABLE_CLAUDEAI_MCP_SERVERS = "0";
env.DISABLE_AUTO_COMPACT = "1";

const say = (kind: string, data: unknown) => console.log(JSON.stringify({ t: Math.round(performance.now()), kind, data }));

// Process tree from /proc: every descendant of this process, with its command name and RSS.
const procs = () => {
	const parent = new Map<number, number>();
	const comm = new Map<number, string>();
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			const close = stat.lastIndexOf(")");
			comm.set(Number(entry), stat.slice(stat.indexOf("(") + 1, close));
			parent.set(Number(entry), Number(stat.slice(close + 2).split(" ")[1]));
		} catch {}
	}
	const out: { pid: number; comm: string; rssMb: number }[] = [];
	for (const [pid] of parent) {
		let p: number | undefined = pid;
		while (p && p !== process.pid) p = parent.get(p);
		if (p !== process.pid || pid === process.pid) continue;
		try {
			const rss = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
			out.push({ pid, comm: comm.get(pid) ?? "?", rssMb: Math.round(Number(rss ?? 0) / 1024) });
		} catch {}
	}
	return out;
};

let phase: "starting" | "generating" | "parked" = "starting";
const peak = { starting: 0, generating: 0, parked: 0 };
const parkedSamples: number[][] = [];
const sampler = setInterval(() => {
	const tree = procs();
	const total = tree.reduce((sum, p) => sum + p.rssMb, 0);
	peak[phase] = Math.max(peak[phase], total);
	if (phase === "parked") parkedSamples.push(tree.map((p) => p.rssMb));
}, 100);

const runChild = async (i: number) => {
	let release!: () => void;
	const parked = new Promise<void>((resolve) => (release = resolve));
	async function* prompt() {
		yield {
			type: "user" as const,
			message: { role: "user" as const, content: `Reply with exactly the two words: ok ${i}` },
			parent_tool_use_id: null,
			session_id: "",
		};
		await parked;
	}
	const started = performance.now();
	const marks: Record<string, number> = {};
	let usage: unknown;
	const q = query({
		prompt: prompt(),
		options: {
			model,
			cwd,
			env,
			tools: [],
			settingSources: [],
			settings: { disableAllHooks: true },
			strictMcpConfig: true,
			persistSession: false,
			includePartialMessages: true,
		},
	});
	// Keep reading in the background: leaving the loop would close the query, and a parked child must stay open.
	let settle!: (value: { i: number; marks: Record<string, number>; usage: unknown; release: () => void }) => void;
	const settled = new Promise<{ i: number; marks: Record<string, number>; usage: unknown; release: () => void }>((resolve) => (settle = resolve));
	void (async () => {
		for await (const m of q) {
			const at = Math.round(performance.now() - started);
			if (m.type === "system" && m.subtype === "init") marks.initMs ??= at;
			if (m.type === "stream_event" && m.event.type === "content_block_delta") marks.firstTokenMs ??= at;
			if (m.type === "result") {
				marks.resultMs = at;
				usage = { ...m.usage, durationApiMs: m.duration_api_ms, subtype: m.subtype };
				settle({ i, marks, usage, release });
			}
		}
	})();
	return settled;
};

phase = "generating";
const results = await Promise.all(Array.from({ length: n }, (_, i) => runChild(i)));
for (const r of results) say("child", { i: r.i, ...r.marks, usage: r.usage });

phase = "parked";
const parkedTree = procs();
say("parked", { pids: parkedTree.map((p) => p.pid), tree: parkedTree });
await new Promise((resolve) => setTimeout(resolve, parkMs));
for (const r of results) r.release();
await new Promise((resolve) => setTimeout(resolve, 2000));
clearInterval(sampler);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const perProcParked = parkedSamples.flat();
const leftover = procs().filter((p) => p.comm.includes("claude"));
say("summary", {
	n,
	model,
	initMsMedian: median(results.map((r) => r.marks.initMs ?? Number.NaN)),
	firstTokenMsMedian: median(results.map((r) => r.marks.firstTokenMs ?? Number.NaN)),
	resultMsMedian: median(results.map((r) => r.marks.resultMs ?? Number.NaN)),
	processesParked: parkedTree.length,
	commsParked: [...new Set(parkedTree.map((p) => p.comm))],
	perProcessParkedMbMedian: median(perProcParked),
	perProcessParkedMbMax: Math.max(0, ...perProcParked),
	totalMbPeak: peak,
	leftoverAfterClose: leftover.length,
});
process.exit(0);
