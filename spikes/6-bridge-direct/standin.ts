// Spike 6 (direct): load pi-claude-bridge at upstream main, unmodified, as a pi-ai provider for
// pi-durable 1.4.0, through a stand-in for pi-coding-agent's extension API.
// Ported from cairn-v1 spikes/01-bridge/bridge.ts at 1a5cd4a56e84bfb187940428d144b584d2e084b0 (Cairn's
// own code). Changed: the bridge loads from runs/upstream (fetch-upstream.sh); the SDK's query is
// wrapped through upstream's own __test.setQuery only to observe each child (its options, its hook
// events, how many run at once), never to change what the bridge asks for, except
// `includeHookEvents`, which only adds hook events to the stream.
import { createProvider, type Model, type Provider, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { query } from "@anthropic-ai/claude-agent-sdk";
import bridgeExtension, { __test } from "./runs/upstream/src/index.ts";
import { toBridgeContext } from "./runs/upstream/src/transcript.ts";

type Handler = (event: any, ctx: any) => unknown;
type ProviderConfig = { models: any[]; streamSimple: (model: any, context: any, options?: any) => any };

export type Observed = {
	onChild?: (info: { settingSources: unknown; envHasAnthropic: boolean; live: number }) => void;
	onChildEnd?: (live: number) => void;
	onHook?: (event: unknown) => void;
	log?: (line: string) => void;
};

let live = 0;

export function loadBridge(cwd: string, observed: Observed = {}): { provider: Provider; touched: Set<string> } {
	const log = observed.log ?? (() => {});
	__test.setQuery(((params: any) => {
		const options = { ...params.options, includeHookEvents: true };
		live++;
		observed.onChild?.({
			settingSources: params.options?.settingSources ?? "default",
			envHasAnthropic: Object.keys(params.options?.env ?? process.env).some((k) => k.startsWith("ANTHROPIC_")),
			live,
		});
		const q = query({ ...params, options });
		const iterator = q[Symbol.asyncIterator]();
		let ended = false;
		const end = () => { if (!ended) { ended = true; live--; observed.onChildEnd?.(live); } };
		const wrapped = Object.create(q);
		wrapped[Symbol.asyncIterator] = () => ({
			next: async () => {
				const r = await iterator.next();
				if (r.done) end();
				else if (r.value?.type === "system" && String(r.value.subtype).startsWith("hook_")) observed.onHook?.({ subtype: r.value.subtype, hook: r.value.hook_event ?? r.value.hook_name });
				return r;
			},
			return: async (v: any) => { end(); return iterator.return ? iterator.return(v) : { done: true, value: v }; },
		});
		wrapped.close = () => { end(); q.close(); };
		wrapped.interrupt = () => q.interrupt();
		return wrapped;
	}) as any);

	const handlers = new Map<string, Handler[]>();
	const touched = new Set<string>();
	let config: ProviderConfig | undefined;
	const known: Record<string, unknown> = {
		on: (event: string, handler: Handler) => { touched.add(`on:${event}`); handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerProvider: (id: string, c: ProviderConfig) => { touched.add(`registerProvider:${id}`); config = c; },
		registerTool: () => touched.add("registerTool"),
	};
	const api = new Proxy(known, {
		get(target, key) {
			if (typeof key === "string" && !(key in target)) touched.add(`?${key}`);
			return target[key as string];
		},
	});
	bridgeExtension(api as any);
	if (!config) throw new Error("bridge registered no provider");
	const bridgeConfig = config;

	const fire = (event: string, payload: unknown, sessionId: string, systemPrompt?: string) => {
		const ctx = {
			cwd,
			mode: "rpc",
			hasUI: false,
			ui: { notify: (message: string, level: string) => log(`notify ${level}: ${message}`) },
			sessionManager: { getSessionId: () => sessionId },
			getSystemPrompt: () => systemPrompt,
			modelRegistry: { getProvider: () => undefined },
		};
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};

	// Upstream main binds each later run's signal; the first generation's signal is still aborted by
	// pi-durable with "Task N invocation has ended" when it parks on its tool call. Left as it is: the
	// point is to measure the bridge unmodified.
	const started = new Set<string>();
	const streamSimple = (model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) => {
		const sessionId = options?.sessionId ?? "none";
		if (!started.has(sessionId)) {
			started.add(sessionId);
			fire("session_start", { reason: "startup" }, sessionId);
		}
		const systemPrompt = toBridgeContext(context as any).systemPrompt;
		if (systemPrompt) fire("before_agent_start", { systemPrompt, systemPromptOptions: { customPrompt: systemPrompt } }, sessionId, systemPrompt);
		return bridgeConfig.streamSimple(model, context, options);
	};

	const provider = createProvider({
		id: "claude-bridge",
		name: "Claude (bridge, direct)",
		auth: { apiKey: { name: "claude CLI login", resolve: async () => ({ auth: { apiKey: "not-used" }, source: "claude CLI" }) } },
		models: bridgeConfig.models.map((m) => ({ ...m, provider: "claude-bridge", api: "claude-bridge", baseUrl: "claude-bridge" })),
		api: { stream: streamSimple as any, streamSimple: streamSimple as any },
	});
	return { provider, touched };
}
