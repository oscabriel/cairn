// The stones Worker for spike 11, cut from spike 1's, on its workers.dev hostname only, behind an Access application that admits only the
// Beelink's service token. Every request must also carry the shared secret as a bearer token; the Worker checks
// Access's JWT again and the secret before any Durable Object sees the request. Cut down from cairn-v1
// apps/cloud-sandbox/src/worker.ts. Routes:
// - `GET /pipe/<id>`, a WebSocket upgrade: one pi-env daemon in stone <id>'s container (src/pump.ts).
// - `GET /stone/<id>`: `{ running, pipes, born }`.
// - `POST /stone/<id>/start` `{ instance, internet, snapshotId? }`: starts the container if it is not running. `{}`.
// - `POST /stone/<id>/snapshot` `{ name }`: captures this stone once, recording the result before answering.
// - `POST /stone/<id>/stop`: closes the stone's pipes and destroys its container. `{ stopped }`.
// - `POST /stone/<id>/evict`: throws the Durable Object's instance away (`ctx.abort()`). `{ evicted }`.
import { AccessDenied, accessConfig, verifyServiceToken } from "./access-jwt.ts";
import { bearerMatches } from "./auth.ts";
import type { StonesEnv } from "./env.ts";
import { SANDBOX_ID } from "./frame.ts";
import type { StartOptions } from "./workspace.ts";

export { Workspace } from "./workspace.ts";

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
		const control = area === "stone" && ((op === undefined && request.method === "GET") || (op !== undefined && ["start", "stop", "evict", "snapshot"].includes(op) && request.method === "POST"));
		if (!pipe && !control) return notFound();
		const refused = await authorize(request, env);
		if (refused) return refused;
		const stub = env.WORKSPACE.getByName(stoneId);
		if (pipe) return stub.fetch(request);
		if (op === undefined) return Response.json(await stub.status());
		if (op === "start") {
			return Response.json((await stub.start(stoneId, (await request.json()) as StartOptions)) ?? {});
		}
		if (op === "snapshot") {
			const { name } = (await request.json()) as { name: string };
			return Response.json(await stub.snapshot(name));
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
