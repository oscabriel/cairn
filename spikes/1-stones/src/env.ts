// The Worker's bindings, as alchemy.run.ts declares them. Keep the two in step.
import type { Computer } from "./computer.ts";
import type { Workspace } from "./workspace.ts";

export interface StonesEnv {
	readonly WORKSPACE: DurableObjectNamespace<Workspace>;
	/** The @cloudflare/computer evaluation (src/computer.ts). */
	readonly COMPUTER: DurableObjectNamespace<Computer>;
	/** The relay's shared secret, 64 hex: the bearer token on every request. The Beelink holds it in a 0600 file. */
	readonly RELAY_SECRET: string;
	/** `https://<team>.cloudflareaccess.com`, the relay application's `aud`, and the relay service token's client id. */
	readonly ACCESS_TEAM_DOMAIN: string;
	readonly ACCESS_AUD: string;
	readonly RELAY_CLIENT_ID: string;
}
