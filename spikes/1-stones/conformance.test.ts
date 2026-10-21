// Spike 1: pi-durable's ExecutionEnv conformance suite against a deployed stone, driven from the Beelink over the
// relay (Beelink, WSS through Access to workers.dev, the Workspace Durable Object, the container's pi-env daemon).
//   STONE=<12 hex> npx vitest run conformance.test.ts
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, control, stoneEnv } from "./stone.ts";

const stoneId = process.env.STONE ?? "c0c0c0c0c0c0";
const connection = connect(stoneId);
let started = 0;
let cases = 0;

beforeAll(async () => {
	started = Date.now();
	await control(stoneId, "start");
	await connection.info();
	console.log(`stone ${stoneId} up and connected in ${Date.now() - started} ms`);
}, 300_000);

afterAll(() => {
	console.log(`suite wall time ${Date.now() - started} ms`);
	connection.close();
});

registerEnvConformance(
	{ describe, expect, it },
	"RemoteExecutionEnv in a Cloudflare container, over the relay from the Beelink",
	async (use) => {
		const cwd = `/workspace/case-${process.pid}-${(cases += 1)}`;
		const root = stoneEnv(stoneId, connection);
		const made = await root.createDir(cwd, { recursive: true }, context);
		if (!made.ok) throw new Error(`createDir ${cwd}: ${JSON.stringify(made.error)}`);
		try {
			await use(stoneEnv(stoneId, connection, cwd));
		} finally {
			await root.remove(cwd, { recursive: true, force: true }, context);
		}
	},
	{ listFiles: true },
);
