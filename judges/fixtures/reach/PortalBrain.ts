// The judge brain of `judges/reach-restart.ts` (ADR 0038): Cairn's `Portals` over its own
// `cairn.sqlite` in a scratch folder, the real porch binary with a scratch `HOME` and XDG folders
// (so the user's porch is never read or written), and real transient user units under a judge-only
// prefix. It runs the portals' boot repair and sweep from `ReachRepair.ts` at start, their close
// hook at SIGTERM, and answers a small loopback control API in place of the socket RPCs:
//
//   POST /open  {threadId, name, command, cwd}  → the portal row (what `portal_open` runs)
//   POST /close {portalId}                      → `portal.close`'s answer
//   POST /start {portalId}                      → `portal.start`'s answer
//   GET  /list                                  → every portal not removed (what `reach.list` shows)
//   GET  /health                                → 200 once the boot repair ran
//
//   node judges/fixtures/reach/PortalBrain.ts --dir <data> --porch-root <root> --porch <bin>
//     --control-port N --unit-prefix P --first-port N --last-port N [--grace-ms N] [--inline]
//
// `CAIRN_JUDGE_FAULT=portal:after-<step>` kills this process with SIGKILL right after that step of
// an open, once per data folder (a marker file remembers it), so the restarted life runs clean.
// `--inline` is the broken control: each portal's server is a child of this process, in the
// brain's own cgroup, as a dev server started with `bash` would be, instead of its own unit.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";

import { ThreadId } from "@cairn/protocol/Ids";
import { PortalId, PortalRow } from "@cairn/protocol/Reach";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Duration, Effect, FiberSet, Layer, Option, Schema } from "effect";

import { Database } from "../../../apps/server/src/db/Database.ts";
import { migrations } from "../../../apps/server/src/db/Migrations.ts";
import {
  PorchClient,
  PorchSettings,
} from "../../../apps/server/src/reach/PorchClient.ts";
import {
  judgePortalFaults,
  Portals,
  PortalSettings,
} from "../../../apps/server/src/reach/Portals.ts";
import { PortalUnits } from "../../../apps/server/src/reach/PortalUnits.ts";
import {
  portalReconcile,
  startPortalSweep,
  stopPortalSweep,
} from "../../../apps/server/src/reach/ReachRepair.ts";
import {
  answerPortalClose,
  answerPortalStart,
} from "../../../apps/server/src/rpc/PortalHandlers.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    "porch-root": { type: "string" },
    porch: { type: "string", default: "porch" },
    "control-port": { type: "string" },
    "unit-prefix": { type: "string" },
    "first-port": { type: "string" },
    "last-port": { type: "string" },
    "grace-ms": { type: "string", default: "120000" },
    inline: { type: "boolean", default: false },
  },
});

const dir = values.dir ?? "";

const porchRoot = values["porch-root"] ?? "";

const controlPort = Number(values["control-port"]);

const marker = path.join(dir, "fault-fired");

const inlineDir = path.join(dir, "inline");

/** One JSON line on stdout, which the unit's journal keeps. */
const log = (event: string, detail: string) => {
  process.stdout.write(`${JSON.stringify({ event, detail })}\n`);
};

/** The pid an inline server wrote; 0 when it has none. */
const pidOf = (unit: string) => {
  const file = path.join(inlineDir, `${unit}.pid`);

  return existsSync(file) ? Number(readFileSync(file, "utf-8")) : 0;
};

/** Whether an inline server's process is alive. */
const alive = (unit: string) => {
  const pid = pidOf(unit);

  return pid > 0 && existsSync(`/proc/${String(pid)}`);
};

/** The broken control: servers as children of this process, tracked by pid files. */
const InlineUnits = Layer.effect(
  PortalUnits,
  Effect.gen(function* () {
    const real = yield* PortalUnits;

    return PortalUnits.of({
      ...real,
      start: (spec) =>
        Effect.sync(() => {
          const child = spawn("/bin/sh", ["-c", spec.command], {
            cwd: spec.cwd,
            env: { ...process.env, ...spec.env },
            stdio: "ignore",
            detached: true,
          });

          child.unref();
          writeFileSync(
            path.join(inlineDir, `${spec.unit}.pid`),
            String(child.pid ?? 0)
          );
        }),
      isActive: (unit) => Effect.sync(() => alive(unit)),
      stop: (unit) =>
        Effect.sync(() => {
          if (alive(unit)) {
            process.kill(-pidOf(unit), "SIGTERM");
          }
        }),
      list: (prefix) =>
        Effect.sync(() =>
          readdirSync(inlineDir)
            .map((file) => file.replace(/\.pid$/u, ""))
            .filter((unit) => unit.startsWith(prefix) && alive(unit))
        ),
    });
  })
).pipe(Layer.provide(PortalUnits.layer));

const units = values.inline ? InlineUnits : PortalUnits.layer;

const settings = Layer.succeed(PortalSettings, {
  unitPrefix: values["unit-prefix"] ?? "cairn-judge-portal-",
  firstPort: Number(values["first-port"]),
  lastPort: Number(values["last-port"]),
  openingGrace: Duration.millis(Number(values["grace-ms"])),
  sweepEvery: Duration.seconds(5),
  probeEvery: Duration.millis(200),
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
});

const porchSettings = Layer.succeed(PorchSettings, {
  bin: values.porch,
  env: {
    HOME: path.join(porchRoot, "home"),
    XDG_CONFIG_HOME: path.join(porchRoot, "cfg"),
    XDG_STATE_HOME: path.join(porchRoot, "state"),
  },
  timeout: Duration.seconds(30),
});

const BrainLayer = Portals.layerNoDeps.pipe(
  Layer.provide(PorchClient.layer),
  Layer.provide(units),
  Layer.provideMerge(
    Database.layer({ filename: path.join(dir, "cairn.sqlite"), migrations })
  ),
  Layer.provide(settings),
  Layer.provide(porchSettings),
  Layer.provide(
    judgePortalFaults(process.env.CAIRN_JUDGE_FAULT ?? "", marker).pipe(
      Layer.provide(NodeServices.layer)
    )
  )
);

const OpenBody = Schema.Struct({
  threadId: ThreadId,
  name: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
});

const IdBody = Schema.Struct({ portalId: PortalId });

const decodeOpen = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenBody));

const decodeId = Schema.decodeUnknownEffect(Schema.fromJsonString(IdBody));

const encodeRows = Schema.encodeUnknownEffect(Schema.Array(PortalRow));

const bodyOf = (req: IncomingMessage) =>
  Effect.callback<string>((resume) => {
    const chunks: Array<Buffer> = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resume(Effect.succeed(Buffer.concat(chunks).toString("utf-8")));
    });
  });

const reply = (res: ServerResponse, status: number, json: string) =>
  Effect.sync(() => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(json);
  });

const program = Effect.gen(function* () {
  const portals = yield* Portals;
  const run = yield* FiberSet.makeRuntime();

  yield* Effect.sync(() => {
    mkdirSync(inlineDir, { recursive: true });
  });

  yield* portalReconcile.repair;
  yield* startPortalSweep.repair;
  yield* Effect.addFinalizer(() => stopPortalSweep.close);

  const handle = (req: IncomingMessage, res: ServerResponse) =>
    Effect.gen(function* () {
      const body = yield* bodyOf(req);

      if (req.url === "/health") {
        return yield* reply(
          res,
          200,
          JSON.stringify({ ready: true, pid: process.pid })
        );
      }

      if (req.url === "/list") {
        const rows = yield* portals.list(Option.none());

        return yield* reply(res, 200, JSON.stringify(yield* encodeRows(rows)));
      }

      if (req.url === "/open") {
        const input = yield* decodeOpen(body);

        const row = yield* portals.open({
          ...input,
          ttlHours: 12,
          readyPath: "/",
          readyTimeout: Duration.seconds(30),
        });

        return yield* reply(
          res,
          200,
          JSON.stringify((yield* encodeRows([row]))[0])
        );
      }

      if (req.url === "/close" || req.url === "/start") {
        const { portalId } = yield* decodeId(body);

        yield* req.url === "/close"
          ? answerPortalClose(portals, { portalId })
          : answerPortalStart(portals, { portalId });

        return yield* reply(res, 200, JSON.stringify({ ok: true }));
      }

      return yield* reply(res, 404, JSON.stringify({ error: "no such route" }));
    }).pipe(
      Effect.catchCause((cause) =>
        reply(res, 500, JSON.stringify({ error: String(cause) }))
      )
    );

  yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((req, res) => {
        run(handle(req, res));
      });

      server.listen(controlPort, "127.0.0.1", () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.callback<boolean>((resume) => {
        server.close(() => {
          resume(Effect.succeed(true));
        });
        server.closeAllConnections();
      })
  );

  log("ready", String(controlPort));

  return yield* Effect.never;
});

NodeRuntime.runMain(Effect.scoped(program).pipe(Effect.provide(BrainLayer)));
