// The reach stage's machine edits on a Caddyfile shaped like the live one (the reach note's reading
// of `~/caddy/conf/Caddyfile` and `ops/cairn/caddy-route.sh`'s Cairn route): each edit lands where
// it must, a second run changes nothing, and a missing anchor refuses instead of guessing.

import { Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  composeMount,
  importPorch,
  ownerOnly,
  porchPorts,
  renamePlans,
  streamCloseDelay,
} from "./reach-edits.ts";
import type { Edited } from "./reach-edits.ts";

const SNIPPETS = "/home/u/.config/porchlight/caddy";

const LIVE_CADDYFILE = `{
	email owner@example.com
}

*.gneiss.run {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}

	# Cairn brain (local to Beelink; ops/cairn in the cairn repo)
	@cairn host code.gneiss.run
	handle @cairn {
		forward_auth 127.0.0.1:3774 {
			uri /_cairn/auth
			header_up X-Cairn-Peer {remote_host}
			copy_headers X-Cairn-User
			lb_try_duration 3s
			lb_try_interval 250ms
		}
		reverse_proxy 127.0.0.1:3774 {
			header_up -X-Cairn-Peer
			lb_try_duration 3s
			lb_try_interval 250ms
		}
	}

	# Agent-generated HTML plans/reports
	@plans host plans.gneiss.run
	handle @plans {
		root * /home/u/Developer/agent-artifacts
		header Cache-Control "no-cache"
		file_server browse
	}

	@t3 host t3.gneiss.run
	handle @t3 {
		reverse_proxy 127.0.0.1:3773
	}

	@jellyfin host tv.gneiss.run
	handle @jellyfin {
		reverse_proxy 127.0.0.1:8096 {
			stream_close_delay 1m
		}
	}

	map {host} {dev_port} {
		3001.gneiss.run 3001
		default ""
	}
	@dev vars_regexp {dev_port} ^\\d+$
	handle @dev {
		reverse_proxy 127.0.0.1:{dev_port}
	}

	handle {
		respond "Service not found" 404
	}
}
`;

const COMPOSE = `services:
  caddy:
    build: .
    container_name: caddy
    network_mode: host
    volumes:
      - ./conf:/etc/caddy:ro
      - caddy_data:/data
volumes:
  caddy_data:
`;

const ok = (result: Result.Result<Edited, string>) => {
  if (Result.isFailure(result)) {
    throw new Error(result.failure);
  }

  return result.success;
};

const allEdits = (text: string) =>
  ok(
    streamCloseDelay(
      ok(importPorch(ok(renamePlans(ok(ownerOnly(text)).text)).text, SNIPPETS))
        .text
    )
  ).text;

describe("reach Caddyfile edits", () => {
  it("guards plans and every portal name at the site level, first in the block", () => {
    const { text } = ok(ownerOnly(LIVE_CADDYFILE));
    const lines = text.split("\n");
    const site = lines.indexOf("*.gneiss.run {");

    expect(lines[site + 3]).toBe(
      "\t@cairn_owner_only expression `{host} == 'plans.gneiss.run' || {host}.matches('^[a-z0-9-]+--[a-z0-9-]+\\\\.gneiss\\\\.run$')`"
    );
    expect(lines[site + 4]).toBe(
      "\tforward_auth @cairn_owner_only 127.0.0.1:3774 {"
    );
    expect(text).toContain("\t\theader_up X-Cairn-Peer {remote_host}\n");
  });

  it("renames the hand-written @plans and leaves no @plans behind", () => {
    const { text } = ok(renamePlans(LIVE_CADDYFILE));

    expect(text).toContain("\t@owner_plans host plans.gneiss.run\n");
    expect(text).toContain("\thandle @owner_plans {\n");
    expect(text).not.toMatch(/@plans\b/u);
  });

  it("imports porch's snippet just above the final catch-all", () => {
    const { text } = ok(importPorch(LIVE_CADDYFILE, SNIPPETS));

    expect(text).toContain(
      `\timport ${SNIPPETS}/porches.caddy\n\timport ${SNIPPETS}/errors.caddy\n\n\thandle {\n\t\trespond "Service not found" 404`
    );
    expect(text).not.toContain("fallback.caddy");
  });

  it("adds stream_close_delay to the WebSocket proxies only", () => {
    const { text } = ok(streamCloseDelay(LIVE_CADDYFILE));

    expect(text).toContain(
      "\t\treverse_proxy 127.0.0.1:3774 {\n\t\t\tstream_close_delay 5m\n\t\t\theader_up -X-Cairn-Peer"
    );
    expect(text).toContain(
      "\t\treverse_proxy 127.0.0.1:3773 {\n\t\t\tstream_close_delay 5m\n\t\t}\n"
    );
    // jellyfin already had a delay; the forward_auth and the dev table are not WebSocket proxies.
    expect(text).toContain("\t\t\tstream_close_delay 1m\n");
    expect(text).not.toContain(
      "stream_close_delay 1m\n\t\t\tstream_close_delay"
    );
    expect(text.match(/stream_close_delay 5m/gu)).toHaveLength(2);
  });

  it("leaves the dev table alone and says what it did per handle", () => {
    const { text, notes } = ok(streamCloseDelay(LIVE_CADDYFILE));

    expect(text).toContain("\t\treverse_proxy 127.0.0.1:{dev_port}\n");
    expect(notes).toContain("@cairn: 1 added, 0 already set");
    expect(notes).toContain("@jellyfin: 0 added, 1 already set");
    expect(notes).toContain(
      "@ha: no handle in the *.gneiss.run block, skipped"
    );
  });

  it("every edit is idempotent", () => {
    const once = allEdits(LIVE_CADDYFILE);

    expect(allEdits(once)).toBe(once);
    expect(once.split("{")).toHaveLength(once.split("}").length);
  });

  it("refuses when an anchor is missing", () => {
    expect(Result.isFailure(ownerOnly("example.com {\n}\n"))).toBeTruthy();
    expect(
      Result.isFailure(
        importPorch("*.gneiss.run {\n\trespond 404\n}\n", SNIPPETS)
      )
    ).toBeTruthy();
    expect(
      Result.isFailure(
        renamePlans("*.gneiss.run {\n\troute @plans {\n\t}\n}\n")
      )
    ).toBeTruthy();
  });
});

describe("reach compose and porch config edits", () => {
  it("mounts the snippet folder read-only beside ./conf, once", () => {
    const { text } = ok(composeMount(COMPOSE, SNIPPETS));

    expect(text).toContain(
      `      - ./conf:/etc/caddy:ro\n      - ${SNIPPETS}:${SNIPPETS}:ro\n      - caddy_data:/data`
    );
    expect(ok(composeMount(text, SNIPPETS)).text).toBe(text);
    expect(
      Result.isFailure(composeMount("services: {}\n", SNIPPETS))
    ).toBeTruthy();
  });

  it("sets porch's port range and keeps the rest of its config", () => {
    const config = JSON.stringify({
      artifacts: "/home/u/Developer/agent-artifacts",
      domain: "gneiss.run",
      ports: { range: [3001, 3999] },
      proxy: { kind: "caddy", reload: "true" },
    });

    const { text } = ok(porchPorts(config));

    expect(JSON.parse(text)).toStrictEqual({
      artifacts: "/home/u/Developer/agent-artifacts",
      domain: "gneiss.run",
      ports: { range: [3100, 3699] },
      proxy: { kind: "caddy", reload: "true" },
    });
    expect(ok(porchPorts(text)).text).toBe(text);
  });
});
