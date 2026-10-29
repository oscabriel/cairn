// Does an open WebSocket survive a Caddy reload? (ADR 0038, docs/phase-2/notes/reach.md R2.) Every
// portal open and close reloads the Docker Caddy, and a reload cuts every upgraded connection
// (Cairn's own `/ws`, t3code's, Home Assistant's) unless the proxy sets `stream_close_delay`.
// Kept from the reach note's probe (`/tmp/reach-probe/reload/ws-probe.mjs`).
//
//   node judges/caddy-reload.ts [--image caddy-caddy:latest] [--porch <bin>]
//   node judges/caddy-reload.ts --live [--container caddy] [--require 127.0.0.1:3774,127.0.0.1:3773]
//
// Throwaway run (the default): two throwaway Caddy containers from the live image
// (`judges/lib/ThrowawayCaddy.ts`), each proxying a loopback backend that answers an Upgrade with
// 101 and ticks every 200 ms. The judge opens one upgraded connection through Caddy, reloads with
// the live command aimed at the container (or, with `--porch`, through `porch add`, whose reload
// command is that one, in a porch the judge owns), and counts ticks for six seconds after. It also
// adapts each config and runs the close-delay check `--live` uses.
//
// - control (no `stream_close_delay`): the connection must be cut and the config check must fail.
//   This is the judge failing on purpose: it proves both checks can fail.
// - delay (`stream_close_delay 30s`): the connection must survive with ticks still arriving, and
//   the config check must pass.
//
// Live run (`--live`, the wizard's reach stage, after the Caddyfile edit): read-only. It adapts the
// live Caddyfile inside the live container (`docker exec caddy caddy adapt`) and checks that every
// `reverse_proxy` to each required upstream (Cairn 3774 and t3code 3773 by default) sets
// `stream_close_delay`. It changes nothing and reloads nothing.
//
// Prints one JSON line and exits 0 on a pass, 1 otherwise.

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Console, Duration, Effect, Option } from "effect";

import {
  adaptIn,
  checkCloseDelay,
  DEFAULT_CADDY_IMAGE,
  freePort,
  runCommand,
  startCaddy,
  ThrowawayCaddyError,
} from "./lib/ThrowawayCaddy.ts";

const { values } = parseArgs({
  options: {
    image: { type: "string", default: DEFAULT_CADDY_IMAGE },
    porch: { type: "string" },
    live: { type: "boolean", default: false },
    container: { type: "string", default: "caddy" },
    require: { type: "string", default: "127.0.0.1:3774,127.0.0.1:3773" },
  },
});

const TICK_MS = 200;

const BEFORE = Duration.millis(1500);

const AFTER = Duration.millis(6000);

/** Ticks after the reload that count as surviving: half of what six seconds should bring. */
const SURVIVED_TICKS = 15;

// ── Live: the read-only config check ─────────────────────────────────────────────────────────────

const liveRun = Effect.gen(function* () {
  const required = values.require
    .split(",")
    .map((dial) => dial.trim())
    .filter((dial) => dial !== "");

  const config = yield* adaptIn(values.container);
  const verdict = checkCloseDelay(config, required);

  yield* Console.log(
    JSON.stringify({
      judge: "caddy-reload",
      mode: "live",
      container: values.container,
      pass: verdict.ok,
      findings: verdict.findings,
    })
  );

  return verdict.ok;
});

// ── Throwaway: the reload itself ─────────────────────────────────────────────────────────────────

/** A backend that upgrades every request and ticks every 200 ms, closed with the scope. */
const backendOn = (port: number) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((_request, response) => {
        response.end("ok");
      });

      server.on("upgrade", (_request, socket) => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
        );

        const timer = setInterval(() => {
          socket.write("tick\n");
        }, TICK_MS);

        socket.on("close", () => {
          clearInterval(timer);
        });
        socket.on("error", () => {
          clearInterval(timer);
        });
      });
      server.listen(port, "127.0.0.1", () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      })
  );

/** One upgraded connection through Caddy, counting the ticks that reach it. */
interface Upgraded {
  readonly ticks: () => number;
  readonly upgraded: () => boolean;
  /** When the connection closed, in ms since the epoch. */
  readonly closedAt: () => Option.Option<number>;
}

const upgradeThrough = (port: number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const socket = connect(port, "127.0.0.1");

      const seen = {
        ticks: 0,
        upgraded: false,
        closedAt: Option.none<number>(),
      };

      const closed = () => {
        if (Option.isNone(seen.closedAt)) {
          seen.closedAt = Option.some(Date.now());
        }
      };

      socket.on("data", (chunk: Buffer) => {
        const text = chunk.toString();

        if (text.includes(" 101 ")) {
          seen.upgraded = true;
        }

        seen.ticks += (text.match(/tick/gu) ?? []).length;
      });
      socket.on("close", closed);
      socket.on("error", closed);
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`
      );

      const upgraded: Upgraded = {
        ticks: () => seen.ticks,
        upgraded: () => seen.upgraded,
        closedAt: () => seen.closedAt,
      };

      return { socket, upgraded };
    }),
    ({ socket }) => Effect.sync(() => socket.destroy())
  );

interface Ports {
  readonly backend: number;
  readonly site: number;
  readonly porchSite: number;
  readonly admin: number;
}

const caddyfile = (
  ports: Ports,
  delay: boolean,
  mark: number,
  snippets: Option.Option<string>
) => {
  const lines = [
    "{",
    `\tadmin 127.0.0.1:${String(ports.admin)}`,
    "\tauto_https off",
    "\tpersist_config off",
    "}",
    "",
    `http://127.0.0.1:${String(ports.site)} {`,
    "\tbind 127.0.0.1",
    `\treverse_proxy 127.0.0.1:${String(ports.backend)} {`,
  ];

  if (delay) {
    lines.push("\t\tstream_close_delay 30s");
  }

  lines.push(
    "\t}",
    `\trespond /reload-mark-${String(mark)} "${String(mark)}"`,
    "}"
  );

  if (Option.isSome(snippets)) {
    lines.push(
      "",
      `http://*.example.test:${String(ports.porchSite)} {`,
      "\tbind 127.0.0.1",
      `\timport ${snippets.value}/porches.caddy`,
      "\thandle {",
      '\t\trespond "Service not found" 404',
      "\t}",
      "}"
    );
  }

  return `${lines.join("\n")}\n`;
};

/** A folder the judge owns, removed with the scope. */
const scratch = Effect.acquireRelease(
  Effect.sync(() =>
    realpathSync(mkdtempSync(path.join(tmpdir(), "cairn-caddy-reload-")))
  ),
  (root) =>
    Effect.sync(() => {
      rmSync(root, { recursive: true, force: true });
    })
);

const runVariant = (delay: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* scratch;
      const conf = path.join(root, "conf");
      const caddyfilePath = path.join(conf, "Caddyfile");
      mkdirSync(conf);

      const ports: Ports = {
        backend: yield* freePort,
        site: yield* freePort,
        porchSite: yield* freePort,
        admin: yield* freePort,
      };

      const porchBin = Option.fromNullishOr(values.porch);

      const porchEnv = {
        HOME: path.join(root, "home"),
        XDG_CONFIG_HOME: path.join(root, "cfg"),
        XDG_STATE_HOME: path.join(root, "state"),
      };

      const snippets = path.join(root, "cfg", "porchlight", "caddy");
      let mark = 0;

      yield* backendOn(ports.backend);
      writeFileSync(
        caddyfilePath,
        caddyfile(ports, delay, mark, Option.none())
      );

      const caddy = yield* startCaddy({
        conf,
        mounts: [root],
        waitPort: ports.site,
        image: values.image,
      });

      if (Option.isSome(porchBin)) {
        mkdirSync(path.join(root, "artifacts"));
        mkdirSync(porchEnv.HOME);

        const init = yield* runCommand(
          porchBin.value,
          [
            "init",
            "--domain",
            "example.test",
            "--artifacts",
            path.join(root, "artifacts"),
            "--caddyfile",
            caddyfilePath,
            "--reload",
            caddy.reloadCommand,
            "--json",
          ],
          porchEnv,
          root
        );

        if (init.status !== 0) {
          return yield* new ThrowawayCaddyError({
            message: `porch init failed: ${init.stderr.trim()}`,
          });
        }

        writeFileSync(
          caddyfilePath,
          caddyfile(ports, delay, mark, Option.some(snippets))
        );
        yield* caddy.reload;
      }

      const configCheckOk = checkCloseDelay(yield* caddy.adapt, [
        `127.0.0.1:${String(ports.backend)}`,
      ]).ok;

      const { upgraded } = yield* upgradeThrough(ports.site);
      yield* Effect.sleep(BEFORE);
      const ticksBefore = upgraded.ticks();
      const reloadAt = Date.now();

      let reloadOk: boolean;

      if (Option.isSome(porchBin)) {
        const added = yield* runCommand(
          porchBin.value,
          [
            "add",
            "reload-probe",
            `http://127.0.0.1:${String(ports.backend)}`,
            "--json",
          ],
          porchEnv,
          root
        );

        reloadOk =
          added.status === 0 && added.stdout.includes('"reloaded": true');
      } else {
        mark += 1;
        writeFileSync(
          caddyfilePath,
          caddyfile(ports, delay, mark, Option.none())
        );
        reloadOk = yield* caddy.reload.pipe(
          Effect.as(true),
          Effect.catchTag("ThrowawayCaddyError", (failure) =>
            Console.error(failure.message).pipe(Effect.as(false))
          )
        );
      }

      yield* Effect.sleep(AFTER);

      const ticksAfter = upgraded.ticks() - ticksBefore;
      const closedAt = upgraded.closedAt();

      return {
        variant: delay ? "delay" : "control",
        reloadedBy: Option.isSome(porchBin) ? "porch" : "docker-exec",
        reloadOk,
        upgraded: upgraded.upgraded(),
        ticksBefore,
        ticksAfter,
        closedAfterReloadMs: Option.getOrNull(
          Option.map(closedAt, (at) => at - reloadAt)
        ),
        survived:
          upgraded.upgraded() &&
          Option.isNone(closedAt) &&
          ticksAfter >= SURVIVED_TICKS,
        configCheckOk,
      };
    })
  );

const throwawayRun = Effect.gen(function* () {
  const control = yield* runVariant(false);
  const real = yield* runVariant(true);

  const controlFailed =
    control.reloadOk &&
    control.upgraded &&
    !control.survived &&
    !control.configCheckOk;

  const realPassed = real.reloadOk && real.survived && real.configCheckOk;
  const pass = controlFailed && realPassed;

  yield* Console.log(
    JSON.stringify({
      judge: "caddy-reload",
      mode: "throwaway",
      image: values.image,
      pass,
      controlFailed,
      realPassed,
      control,
      delay: real,
    })
  );

  return pass;
});

const main = (values.live ? liveRun : throwawayRun).pipe(
  Effect.catchTag("ThrowawayCaddyError", (failure) =>
    Console.log(
      JSON.stringify({
        judge: "caddy-reload",
        pass: false,
        error: failure.message,
      })
    ).pipe(Effect.as(false))
  ),
  Effect.tap((pass) =>
    Effect.sync(() => {
      process.exitCode = pass ? 0 : 1;
    })
  )
);

NodeRuntime.runMain(main);
