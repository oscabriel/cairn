// The @cloudflare/computer evaluation: a Durable Object whose workspace is the package's SQLite filesystem, its stable
// core, with no execution backend. The worker-shell backend needs the `experimental` compatibility flag, which
// Cloudflare refuses for deployed Workers, and the container backend is experimental. The Worker reaches it at
// `/computer/<id>/*` behind the same Access and secret checks as the stones, so the Beelink measures both the same way.
import { DurableObject } from "cloudflare:workers";
import { withWorkspace } from "@cloudflare/computer";
import type { StonesEnv } from "./env.ts";

export class Computer extends withWorkspace(
	class extends DurableObject<StonesEnv> {},
	(self) => ({ storage: self.ctx.storage }),
) {}
