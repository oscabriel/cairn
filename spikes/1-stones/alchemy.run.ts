// Spike 1's stack, throwaway: `./deploy.sh`, on the `default` profile in ~/.alchemy. Ported from cairn-v1
// apps/cloud-sandbox/alchemy.run.ts. One Worker with the Workspace Durable Object, whose class has one container
// image: the stone base image Actions built and pushed (images/stone), deployed as-is by digest, so nothing here
// runs Docker.
//
// The Worker answers only on its workers.dev hostname, behind an Access application that admits only the Beelink's
// service token. Never a gneiss.run name: the LAN's Pi-hole answers *.gneiss.run with the Beelink itself. Version
// preview URLs stay off, so no other hostname reaches the Worker around Access.
//
// The relay's credentials go from Alchemy's state and the deploy's env to a 0600 file on the Beelink, never to the
// output.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Redacted } from "effect";
import { IMAGE_KEY } from "./src/image.ts";

const WORKER_NAME = "cairn-s1-stones";
const WORKERS_SUBDOMAIN = process.env.WORKERS_SUBDOMAIN ?? "oscargabriel";
const RELAY_HOST = `${WORKER_NAME}.${WORKERS_SUBDOMAIN}.workers.dev`;
const credentialsFile = join(homedir(), ".config/cairn/stones-s1.json");

const RelayCredentialsFile = Alchemy.Action(
	"Cairn.StonesRelayFile",
	Effect.fn(function* (input: {
		path: string;
		clientId: string;
		clientSecret: Redacted.Redacted<string> | undefined;
		secret: Redacted.Redacted<string>;
	}) {
		if (input.clientSecret === undefined) return yield* Effect.fail(new Error("the service token has no secret in state: rotate it"));
		const body = {
			url: `wss://${RELAY_HOST}`,
			clientId: input.clientId,
			clientSecret: Redacted.value(input.clientSecret),
			secret: Redacted.value(input.secret),
		};
		yield* Effect.sync(() => {
			mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
			writeFileSync(input.path, `${JSON.stringify(body, null, 1)}\n`, { mode: 0o600 });
			chmodSync(input.path, 0o600);
		});
		return { path: input.path };
	}),
);

export default Alchemy.Stack(
	"CairnS1",
	{ providers: Cloudflare.providers(), state: Cloudflare.state() },
	Effect.gen(function* () {
		const token = yield* Cloudflare.Access.ServiceToken("StonesRelay", { name: "cairn-s1-stones-relay" });
		const allowRelay = yield* Cloudflare.Access.Policy("StonesRelayOnly", {
			name: "The Beelink's stones relay (spike 1)",
			decision: "non_identity",
			include: [{ serviceToken: token.serviceTokenId }],
		});
		const relayApp = yield* Cloudflare.Access.Application("StonesRelayApp", {
			type: "self_hosted",
			name: "Cairn stones relay (spike 1)",
			domain: RELAY_HOST,
			destinations: [{ type: "public", uri: RELAY_HOST }],
			policies: [allowRelay],
		});

		const image = yield* Config.String("STONE_IMAGE");
		const stone = Cloudflare.Container(IMAGE_KEY, { schedulingPolicy: "durable_object", image });

		yield* Cloudflare.Worker("Stones", {
			main: "./src/worker.ts",
			compatibility: { flags: ["nodejs_compat"], date: "2026-10-01" },
			name: WORKER_NAME,
			workersDev: { enabled: true, previewsEnabled: false },
			env: {
				WORKSPACE: Cloudflare.DurableObject("Workspace", { containers: [stone] }),
				COMPUTER: Cloudflare.DurableObject("Computer"),
				RELAY_SECRET: Config.Redacted("RELAY_SECRET"),
				ACCESS_TEAM_DOMAIN: Config.String("ACCESS_TEAM_DOMAIN"),
				ACCESS_AUD: relayApp.aud,
				RELAY_CLIENT_ID: token.clientId,
			},
		});

		const secret = yield* Config.Redacted("RELAY_SECRET");
		yield* RelayCredentialsFile({ path: credentialsFile, clientId: token.clientId, clientSecret: token.clientSecret, secret });

		return { relay: `wss://${RELAY_HOST}` };
	}),
);
