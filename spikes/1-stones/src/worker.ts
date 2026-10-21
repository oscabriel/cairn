// The stones Worker for spike 1, on its workers.dev hostname only, behind an Access application that admits only the
// Beelink's service token. Every request must also carry the shared secret as a bearer token; the Worker checks
// Access's JWT again and the secret before any Durable Object sees the request. Cut down from cairn-v1
// apps/cloud-sandbox/src/worker.ts. Routes:
// - `GET /pipe/<id>`, a WebSocket upgrade: one pi-env daemon in stone <id>'s container (src/pump.ts).
// - `GET /stone/<id>`: `{ running, pipes, born }`.
// - `POST /stone/<id>/start`: starts the container if it is not running. `{}`.
// - `POST /stone/<id>/stop`: closes the stone's pipes and destroys its container. `{ stopped }`.
// - `POST /stone/<id>/evict`: throws the Durable Object's instance away (`ctx.abort()`). `{ evicted }`.
import { AccessDenied, accessConfig, verifyServiceToken } from "./access-jwt.ts";
import { bearerMatches } from "./auth.ts";
import type { StonesEnv } from "./env.ts";
import { SANDBOX_ID } from "./frame.ts";

export { Workspace } from "./workspace.ts";
export { Computer } from "./computer.ts";
import { getWorkspace } from "@cloudflare/computer";

/** `/computer/<id>/grep` `{ pattern, path }` and `/computer/<id>/write` `{ path, content }`, `/computer/<id>/read?path=`. */
const computer = async (env: StonesEnv, id: string, op: string, request: Request): Promise<Response> => {
	using ws = await getWorkspace(env.COMPUTER.getByName(id));
	const t = performance.now();
	if (op === "grep") {
		const { pattern, path } = (await request.json()) as { pattern: string; path: string };
		const hits = await ws.fs.grep(pattern, path);
		return Response.json({ hits: hits.length, ms: performance.now() - t });
	}
	if (op === "write") {
		const { path, content } = (await request.json()) as { path: string; content: string };
		await ws.fs.writeFile(path, content);
		return Response.json({ ms: performance.now() - t });
	}
	const text = await ws.fs.readFile(new URL(request.url).searchParams.get("path") ?? "/", "utf8");
	return Response.json({ bytes: String(text).length, ms: performance.now() - t });
};

const notFound = () => new Response("Not found\n", { status: 404 });
const unauthorized = () => new Response("Unauthorized\n", { status: 401 });

const authorize = async (request: Request, env: StonesEnv): Promise<Response | undefined> => {
	const config = accessConfig(env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
	if (!config || !env.RELAY_CLIENT_ID || !env.RELAY_SECRET) return new Response("Relay not configured\n", { status: 503 });
	if (!(await bearerMatches(request.headers.get("Authorization"), env.RELAY_SECRET))) return unauthorized();
	try {
		await verifyServiceToken(request.headers.get("Cf-Access-Jwt-Assertion"), config, env.RELAY_CLIENT_ID);
	} catch (error) {
		if (error instanceof AccessDenied) return unauthorized();
		throw error;
	}
	return undefined;
};

export default {
	async fetch(request: Request, env: StonesEnv): Promise<Response> {
		const [, area, stoneId, op, ...rest] = new URL(request.url).pathname.split("/");
		if (!stoneId || !SANDBOX_ID.test(stoneId) || rest.length > 0) return notFound();
		const pipe = area === "pipe" && op === undefined && request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket";
		if (area === "computer" && op !== undefined && ["grep", "write", "read"].includes(op)) {
			const refused = await authorize(request, env);
			return refused ?? computer(env, stoneId, op, request).catch((error: unknown) => new Response(`${String(error)}\n${(error as Error)?.stack ?? ""}\n`, { status: 500 }));
		}
		const control = area === "stone" && ((op === undefined && request.method === "GET") || (op !== undefined && ["start", "stop", "evict"].includes(op) && request.method === "POST"));
		if (!pipe && !control) return notFound();
		const refused = await authorize(request, env);
		if (refused) return refused;
		const stub = env.WORKSPACE.getByName(stoneId);
		if (pipe) return stub.fetch(request);
		if (op === undefined) return Response.json(await stub.status());
		if (op === "start") {
			await stub.start(stoneId);
			return Response.json({});
		}
		if (op === "stop") return Response.json({ stopped: await stub.stop() });
		try {
			await stub.evict();
		} catch {
			// The abort ends the call with an error: that is the eviction.
		}
		return Response.json({ evicted: true });
	},
} satisfies ExportedHandler<StonesEnv>;
