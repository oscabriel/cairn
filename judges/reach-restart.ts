// Portals through brain restarts (ADR 0038's gate, docs/phase-2/notes/reach.md R5): a judge brain
// (`fixtures/reach/PortalBrain.ts`, Cairn's `Portals` with the real porch and real transient user
// units) runs as a transient unit with `cairn.service`'s kill settings (`KillMode=mixed`,
// `Restart=always`), behind a throwaway Caddy (`lib/ThrowawayCaddy.ts`) that porch reloads. Never
// `cairn.service`, the live Caddy or the user's porch: porch's `HOME` and XDG folders, the
// Caddyfile, the store and every unit are the judge's own, and portal units carry the prefix
// `cairn-judge-portal-<pid>-`.
//
//   node judges/reach-restart.ts [--case restart|matrix|control]... [--porch /tmp/reach-probe/porch-bin]
//     [--image caddy-caddy:latest]
//
// Cases (default: all three):
// - restart: open a portal, `kill -9` the brain and check the page answers every probe (every
//   100 ms through Caddy) while the brain restarts, and the portal is still `open`; then SIGTERM it
//   (`systemctl --user stop`) and start a new one over the same store, with the same checks; then
//   close it through `portal.close`'s answer and check the unit is gone, the porch is gone and the
//   name falls to Caddy's catch-all 404.
// - matrix: `CAIRN_JUDGE_FAULT=portal:after-<step>` kills the brain after each step of an open
//   (row, porch, unit, probe, open), twice per step: once the open is rerun after the restart (it
//   must end open, serving the page), once it is not (the boot repair, with no grace, ends it, and
//   a close follows). Then `portal:after-close-<step>` kills the brain after each step of a close
//   (row marked removed, unit stopped, porch removed), twice per step: once the close is rerun after
//   the restart, once it is left to the boot repair; either way the portal must end removed. Each
//   run must leave no unit, no portal porch and no live row behind.
// - control: the same restart with each server a child of the brain (`--inline`), as a dev server
//   started with `bash` would be. Its page must stop answering through the kill, or the judge
//   proves nothing.
//
// Prints one JSON line per case and a summary; exits 0 when restart and matrix pass and the
// control fails. No model, no network beyond loopback, $0.

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Console,
  Duration,
  Effect,
  Fiber,
  Option,
  Random,
  Ref,
  Schema,
} from "effect";

import type { ThrowawayCaddyError } from "./lib/ThrowawayCaddy.ts";
import {
  DEFAULT_CADDY_IMAGE,
  freePort,
  runCommand,
  startCaddy,
} from "./lib/ThrowawayCaddy.ts";
import * as Unit from "./lib/Unit.ts";

const root = path.join(import.meta.dirname, "..");

const brainScript = path.join(
  import.meta.dirname,
  "fixtures",
  "reach",
  "PortalBrain.ts"
);

const { values } = parseArgs({
  options: {
    case: { type: "string", multiple: true },
    porch: { type: "string", default: "/tmp/reach-probe/porch-bin" },
    image: { type: "string", default: DEFAULT_CADDY_IMAGE },
  },
});

const cases = values.case ?? ["restart", "matrix", "control"];

const DOMAIN = "example.test";

const NAME = "main--judge";

const THREAD = "0199f0c2-6a4e-7d4c-8a6b-0000000a0001";

const STEPS = ["row", "porch", "unit", "probe", "open"] as const;

const CLOSE_STEPS = ["row", "unit", "porch"] as const;

const UNIT_PREFIX = `cairn-judge-portal-${String(process.pid)}-`;

/** A unit-name suffix per brain life, hex so `Unit.sweepOrphans` recognises it. */
let brainCount = 0;

class JudgeFailure extends Schema.TaggedError<JudgeFailure>()("JudgeFailure", {
  message: Schema.String,
}) {}

interface Reply {
  readonly status: number;
  readonly body: string;
}

/** One HTTP request to loopback; status 0 when nothing answered. */
const call = (
  port: number,
  method: string,
  urlPath: string,
  body: Option.Option<unknown>,
  host: Option.Option<string> = Option.none()
) =>
  Effect.callback<Reply>((resume) => {
    const payload = Option.match(body, {
      onNone: () => "",
      onSome: (value) => JSON.stringify(value),
    });

    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        timeout: 60_000,
        headers: Option.match(host, {
          onNone: () => ({ "content-type": "application/json" }),
          onSome: (name) => ({ Host: name }),
        }),
      },
      (response) => {
        const chunks: Array<Buffer> = [];

        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resume(
            Effect.succeed({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf-8"),
            })
          );
        });
        response.on("error", () => {
          resume(Effect.succeed({ status: 0, body: "" }));
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
    });
    req.on("error", () => {
      resume(Effect.succeed({ status: 0, body: "" }));
    });
    req.end(payload);
  });

/** Polls `check` every 100 ms until it holds, failing after `within`. */
const waitFor = <E, R>(
  what: string,
  check: Effect.Effect<boolean, E, R>,
  within: Duration.Input
) =>
  Effect.gen(function* () {
    for (;;) {
      if (yield* check.pipe(Effect.orElseSucceed(() => false))) {
        return;
      }

      yield* Effect.sleep(Duration.millis(100));
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: within,
      orElse: () =>
        Effect.fail(
          new JudgeFailure({ message: `timed out waiting: ${what}` })
        ),
    })
  );

const PortalJson = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  state: Schema.String,
  port: Schema.NullOr(Schema.Int),
});

const decodeRows = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(PortalJson))
);

const decodeRow = Schema.decodeUnknownEffect(Schema.fromJsonString(PortalJson));

const PorchList = Schema.Array(
  Schema.Struct({ name: Schema.String, kind: Schema.String })
);

const decodePorchList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PorchList)
);

const judge = Effect.gen(function* () {
  const dirs = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const base = realpathSync(
        mkdtempSync(path.join(tmpdir(), "cairn-reach-restart-"))
      );

      const made = {
        base,
        porch: path.join(base, "porch"),
        conf: path.join(base, "conf"),
        site: path.join(base, "site"),
        artifacts: path.join(base, "artifacts"),
      };

      for (const folder of [
        made.conf,
        made.site,
        made.artifacts,
        path.join(made.porch, "home"),
        path.join(made.porch, "cfg"),
        path.join(made.porch, "state"),
      ]) {
        mkdirSync(folder, { recursive: true });
      }

      return made;
    }),
    (made) =>
      Effect.sync(() => {
        rmSync(made.base, { recursive: true, force: true });
      })
  );

  // Whatever a failed case left running, the judge's portal units go with it (the brains go with
  // their own scopes); a judge killed outright leaves them to `Unit.sweepOrphans`.
  yield* Effect.addFinalizer(() =>
    Effect.asVoid(
      runCommand("systemctl", ["--user", "stop", `${UNIT_PREFIX}*`])
    )
  );

  const nonce = `nonce-${String(yield* Random.nextIntBetween(1e9, 9e9))}`;

  writeFileSync(
    path.join(dirs.site, "index.html"),
    `<!doctype html><p>${nonce}</p>\n`
  );

  const site = yield* freePort;
  const admin = yield* freePort;
  const snippets = path.join(dirs.porch, "cfg", "porchlight", "caddy");
  const caddyfilePath = path.join(dirs.conf, "Caddyfile");

  const caddyfile = (withSnippets: boolean) => {
    const lines = [
      "{",
      `\tadmin 127.0.0.1:${String(admin)}`,
      "\tauto_https off",
      "\tpersist_config off",
      "}",
      "",
      `http://*.${DOMAIN}:${String(site)} {`,
      "\tbind 127.0.0.1",
    ];

    if (withSnippets) {
      lines.push(
        `\timport ${snippets}/porches.caddy`,
        `\timport ${snippets}/errors.caddy`
      );
    }

    lines.push(
      "\thandle {",
      '\t\trespond "Service not found" 404',
      "\t}",
      "}",
      ""
    );

    return lines.join("\n");
  };

  writeFileSync(caddyfilePath, caddyfile(false));

  const caddy = yield* startCaddy({
    conf: dirs.conf,
    mounts: [dirs.base],
    waitPort: site,
    image: values.image,
  });

  const porchEnv = {
    HOME: path.join(dirs.porch, "home"),
    XDG_CONFIG_HOME: path.join(dirs.porch, "cfg"),
    XDG_STATE_HOME: path.join(dirs.porch, "state"),
  };

  const init = yield* runCommand(
    values.porch,
    [
      "init",
      "--domain",
      DOMAIN,
      "--artifacts",
      dirs.artifacts,
      "--caddyfile",
      caddyfilePath,
      "--reload",
      caddy.reloadCommand,
      "--json",
    ],
    porchEnv,
    dirs.base
  );

  if (init.status !== 0) {
    return yield* new JudgeFailure({
      message: `porch init failed (${String(init.status)}): ${init.stderr.trim()}`,
    });
  }

  writeFileSync(caddyfilePath, caddyfile(true));
  yield* caddy.reload;

  /** The portal porches porch lists now. */
  const portalPorches = Effect.gen(function* () {
    const listed = yield* runCommand(values.porch, ["ls", "--json"], porchEnv);

    return (yield* decodePorchList(listed.stdout))
      .map((row) => row.name)
      .filter((name) => name.includes("--"));
  });

  /** The judge's portal units still loaded. */
  const portalUnits = Effect.map(
    runCommand("systemctl", [
      "--user",
      "list-units",
      "--all",
      "--plain",
      "--no-legend",
      "--type=service",
      `${UNIT_PREFIX}*`,
    ]),
    (result) =>
      result.stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/u)[0] ?? "")
        .filter((name) => name.startsWith(UNIT_PREFIX))
  );

  /** The page through Caddy, as the phone would load it. */
  const page = call(
    site,
    "GET",
    "/",
    Option.none(),
    Option.some(`${NAME}.${DOMAIN}`)
  );

  const pageAnswers = Effect.map(
    page,
    (reply) => reply.status === 200 && reply.body.includes(nonce)
  );

  interface Brain {
    readonly unit: string;
    readonly port: number;
    readonly dir: string;
  }

  /** Starts one brain unit over `dataDir`. */
  const startBrain = (
    dataDir: string,
    options: {
      readonly fault: Option.Option<string>;
      readonly graceMs: number;
      readonly inline: boolean;
    }
  ) =>
    Effect.gen(function* () {
      brainCount += 1;

      const port = yield* freePort;
      const unit = `cairn-judge-reach-${String(process.pid)}-${brainCount.toString(16)}`;

      mkdirSync(dataDir, { recursive: true });

      const args = [
        brainScript,
        "--dir",
        dataDir,
        "--porch-root",
        dirs.porch,
        "--porch",
        values.porch,
        "--control-port",
        String(port),
        "--unit-prefix",
        UNIT_PREFIX,
        "--first-port",
        "38100",
        "--last-port",
        "38199",
        "--grace-ms",
        String(options.graceMs),
      ];

      if (options.inline) {
        args.push("--inline");
      }

      // An empty value names no fault family, so the brain plants none.
      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CAIRN_JUDGE_FAULT: Option.getOrElse(options.fault, () => ""),
      };

      yield* Unit.start({
        name: unit,
        command: [process.execPath, ...args],
        cwd: root,
        env,
        properties: Unit.brainProperties,
        lifetime: "20min",
      });

      const brain: Brain = { unit, port, dir: dataDir };

      yield* waitFor(
        `${unit} ready`,
        Effect.map(
          call(port, "GET", "/health", Option.none()),
          (reply) => reply.status === 200
        ),
        "60 seconds"
      );

      return brain;
    });

  const health = (brain: Brain) =>
    Effect.map(
      call(brain.port, "GET", "/health", Option.none()),
      (reply) => reply.status === 200
    );

  const list = (brain: Brain) =>
    Effect.flatMap(call(brain.port, "GET", "/list", Option.none()), (reply) =>
      decodeRows(reply.body)
    );

  const open = (brain: Brain) =>
    call(
      brain.port,
      "POST",
      "/open",
      Option.some({
        threadId: THREAD,
        name: NAME,
        command: "exec python3 -m http.server $PORT --bind 127.0.0.1",
        cwd: dirs.site,
      })
    );

  const close = (brain: Brain, portalId: string) =>
    call(brain.port, "POST", "/close", Option.some({ portalId }));

  /** Probes the page every 100 ms until interrupted; answers how many probes failed. */
  const prober = Effect.gen(function* () {
    const tally = yield* Ref.make({ ok: 0, failed: 0 });

    const fiber = yield* Effect.forkChild(
      Effect.forever(
        Effect.gen(function* () {
          const ok = yield* pageAnswers;

          yield* Ref.update(tally, (current) =>
            ok
              ? { ...current, ok: current.ok + 1 }
              : { ...current, failed: current.failed + 1 }
          );
          yield* Effect.sleep(Duration.millis(100));
        })
      )
    );

    return {
      stop: Effect.gen(function* () {
        yield* Fiber.interrupt(fiber);

        return yield* Ref.get(tally);
      }),
    };
  });

  /** Kills the brain's main process and waits for systemd to bring it back. */
  const killAndWait = (brain: Brain) =>
    Effect.gen(function* () {
      const before = yield* Unit.restarts(brain.unit);

      yield* Unit.killMain(brain.unit, "KILL");
      yield* waitFor(
        `${brain.unit} restarted`,
        Effect.map(Unit.restarts(brain.unit), (count) => count > before),
        "30 seconds"
      );
      yield* waitFor(`${brain.unit} ready again`, health(brain), "60 seconds");
    });

  /** No portal unit, no portal porch and no live row left. */
  const leftovers = (brain: Brain) =>
    Effect.gen(function* () {
      return {
        units: yield* portalUnits,
        porches: yield* portalPorches,
        rows: (yield* list(brain)).map((row) => `${row.name}:${row.state}`),
      };
    });

  const clean = (left: Effect.Success<ReturnType<typeof leftovers>>) =>
    left.units.length === 0 &&
    left.porches.length === 0 &&
    left.rows.length === 0;

  /** Opens the portal on `brain` and checks the page through Caddy. */
  const openServed = (brain: Brain) =>
    Effect.gen(function* () {
      const opened = yield* open(brain);

      if (opened.status !== 200) {
        return yield* new JudgeFailure({
          message: `open answered ${String(opened.status)}: ${opened.body}`,
        });
      }

      const row = yield* decodeRow(opened.body);

      return { row, served: yield* pageAnswers };
    });

  /** Kills the brain with probes running; answers the probes and the portal's state after. */
  const probedKill = (brain: Brain, portalId: string) =>
    Effect.gen(function* () {
      const probes = yield* prober;

      yield* killAndWait(brain);
      yield* Effect.sleep(Duration.seconds(1));

      const tally = yield* probes.stop;
      const after = (yield* list(brain)).find((found) => found.id === portalId);

      return { probes: tally, state: after?.state ?? "missing" };
    });

  /** The restart case: `kill -9`, then SIGTERM and a new brain, then close. */
  const restartCase = Effect.scoped(
    Effect.gen(function* () {
      const dataDir = path.join(dirs.base, "restart");

      const options = {
        fault: Option.none<string>(),
        graceMs: 120_000,
        inline: false,
      };

      const first = yield* startBrain(dataDir, options);
      const { row, served } = yield* openServed(first);

      // The server runs in its own unit, under the judge's prefix.
      const unitBeforeKill = yield* Unit.activeState(
        `${UNIT_PREFIX}${row.id}`
      ).pipe(Effect.orElseSucceed(() => "gone"));

      const kill = yield* probedKill(first, row.id);

      const termProbes = yield* prober;
      yield* Unit.stop(first.unit);

      const second = yield* startBrain(dataDir, options);
      yield* Effect.sleep(Duration.seconds(1));

      const term = yield* termProbes.stop;

      const afterTerm = (yield* list(second)).find(
        (found) => found.id === row.id
      );

      const closed = yield* close(second, row.id);

      const unitAfterClose = yield* Unit.activeState(
        `${UNIT_PREFIX}${row.id}`
      ).pipe(Effect.orElseSucceed(() => "gone"));

      const fallback = yield* page;
      const left = yield* leftovers(second);

      yield* Unit.stop(second.unit);

      const answered =
        kill.probes.failed === 0 &&
        kill.probes.ok > 0 &&
        term.failed === 0 &&
        term.ok > 0;

      const stayedOpen = kill.state === "open" && afterTerm?.state === "open";

      const closedForGood =
        closed.status === 200 &&
        unitAfterClose !== "active" &&
        fallback.status === 404 &&
        fallback.body.includes("Service not found");

      return {
        pass:
          served &&
          unitBeforeKill === "active" &&
          answered &&
          stayedOpen &&
          closedForGood &&
          clean(left),
        served,
        unitBeforeKill,
        killProbes: kill.probes,
        stateAfterKill: kill.state,
        termProbes: term,
        stateAfterTerm: afterTerm?.state ?? "missing",
        closeStatus: closed.status,
        unitAfterClose,
        nameAfterClose: { status: fallback.status, body: fallback.body.trim() },
        left,
      };
    })
  );

  /** The broken control: the server inside the brain's cgroup must not answer through a kill. */
  const controlCase = Effect.scoped(
    Effect.gen(function* () {
      const brain = yield* startBrain(path.join(dirs.base, "control"), {
        fault: Option.none<string>(),
        graceMs: 120_000,
        inline: true,
      });

      const { row, served } = yield* openServed(brain);
      const kill = yield* probedKill(brain, row.id);

      yield* close(brain, row.id);
      yield* Unit.stop(brain.unit);

      return {
        pass: served && kill.probes.failed === 0 && kill.state === "open",
        served,
        killProbes: kill.probes,
        stateAfterKill: kill.state,
      };
    })
  );

  /** One cell of the kill matrix. */
  const matrixCell = (step: (typeof STEPS)[number], rerun: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dataDir = path.join(
          dirs.base,
          `matrix-${step}-${rerun ? "rerun" : "repair"}`
        );

        const brain = yield* startBrain(dataDir, {
          fault: Option.some(`portal:after-${step}`),
          graceMs: rerun ? 120_000 : 0,
          inline: false,
        });

        const first = yield* open(brain);
        yield* waitFor(
          `${brain.unit} back after the fault`,
          Effect.map(Unit.restarts(brain.unit), (count) => count > 0),
          "30 seconds"
        );
        yield* waitFor(
          `${brain.unit} ready after the fault`,
          health(brain),
          "60 seconds"
        );

        let state = "none";
        let served = false;

        if (rerun) {
          const again = yield* open(brain);
          state =
            again.status === 200
              ? (yield* decodeRow(again.body)).state
              : `error ${String(again.status)}`;
          served = yield* pageAnswers;
        } else {
          const [row] = yield* list(brain);
          state = row?.state ?? "none";
          served = row?.state === "open" && (yield* pageAnswers);
        }

        const rows = yield* list(brain);

        for (const row of rows) {
          yield* close(brain, row.id);
        }

        const left = yield* leftovers(brain);
        yield* Unit.stop(brain.unit);

        // A rerun must end open and serving; with no rerun the repair keeps an open portal open
        // and ends one left mid-open (`unit` may be either: the server may not answer yet).
        let expected = ["open"];

        if (!rerun && step === "unit") {
          expected = ["open", "stopped"];
        } else if (!rerun && (step === "row" || step === "porch")) {
          expected = ["stopped"];
        }

        const pass =
          first.status !== 200 &&
          expected.includes(state) &&
          (state !== "open" || served) &&
          clean(left);

        return {
          step,
          rerun,
          pass,
          firstStatus: first.status,
          state,
          served,
          left,
        };
      })
    );

  /** One cell of the close kill matrix: the brain dies after `step` of a close. */
  const closeCell = (step: (typeof CLOSE_STEPS)[number], rerun: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dataDir = path.join(
          dirs.base,
          `close-${step}-${rerun ? "rerun" : "repair"}`
        );

        const brain = yield* startBrain(dataDir, {
          fault: Option.some(`portal:after-close-${step}`),
          graceMs: 120_000,
          inline: false,
        });

        const { row, served } = yield* openServed(brain);
        const first = yield* close(brain, row.id);

        yield* waitFor(
          `${brain.unit} back after the fault`,
          Effect.map(Unit.restarts(brain.unit), (count) => count > 0),
          "30 seconds"
        );
        yield* waitFor(
          `${brain.unit} ready after the fault`,
          health(brain),
          "60 seconds"
        );

        // 0 when the close is left to the boot repair.
        const again = rerun ? (yield* close(brain, row.id)).status : 0;

        // The restarted brain's boot repair (and the rerun, if any) must leave the portal removed:
        // no unit, no porch, no live row, and the name falls to the catch-all 404.
        const left = yield* leftovers(brain);
        const fallback = yield* page;
        yield* Unit.stop(brain.unit);

        const pass =
          served &&
          first.status !== 200 &&
          (!rerun || again === 200) &&
          fallback.status === 404 &&
          clean(left);

        return {
          step: `close-${step}`,
          rerun,
          pass,
          served,
          firstStatus: first.status,
          rerunStatus: again,
          nameAfter: fallback.status,
          left,
        };
      })
    );

  const results: Array<{ readonly name: string; readonly pass: boolean }> = [];

  if (cases.includes("restart")) {
    const result = yield* restartCase;
    results.push({ name: "restart", pass: result.pass });
    yield* Console.log(JSON.stringify({ case: "restart", ...result }));
  }

  if (cases.includes("matrix")) {
    let passed = 0;

    for (const step of STEPS) {
      for (const rerun of [true, false]) {
        const cell = yield* matrixCell(step, rerun);

        if (cell.pass) {
          passed += 1;
        }

        yield* Console.log(JSON.stringify({ case: "matrix", ...cell }));
      }
    }

    for (const step of CLOSE_STEPS) {
      for (const rerun of [true, false]) {
        const cell = yield* closeCell(step, rerun);

        if (cell.pass) {
          passed += 1;
        }

        yield* Console.log(JSON.stringify({ case: "matrix", ...cell }));
      }
    }

    results.push({
      name: "matrix",
      pass: passed === (STEPS.length + CLOSE_STEPS.length) * 2,
    });
  }

  if (cases.includes("control")) {
    const result = yield* controlCase;
    results.push({ name: "control", pass: result.pass });
    yield* Console.log(JSON.stringify({ case: "control", ...result }));
  }

  const finalUnits = yield* portalUnits;
  const finalPorches = yield* portalPorches;

  const pass =
    results.every((result) =>
      result.name === "control" ? !result.pass : result.pass
    ) &&
    finalUnits.length === 0 &&
    finalPorches.length === 0;

  yield* Console.log(
    JSON.stringify({
      judge: "reach-restart",
      pass,
      cases: results.map((result) =>
        result.name === "control"
          ? {
              control: result.pass
                ? "passed (the judge cannot fail)"
                : "failed, as it must",
            }
          : { [result.name]: result.pass ? "pass" : "FAIL" }
      ),
      leftoverUnits: finalUnits,
      leftoverPorches: finalPorches,
    })
  );

  return pass;
});

const main = Effect.scoped(judge).pipe(
  Effect.catchTags({
    ThrowawayCaddyError: (failure: ThrowawayCaddyError) =>
      Console.log(
        JSON.stringify({
          judge: "reach-restart",
          pass: false,
          error: failure.message,
        })
      ).pipe(Effect.as(false)),
    JudgeFailure: (failure: JudgeFailure) =>
      Console.log(
        JSON.stringify({
          judge: "reach-restart",
          pass: false,
          error: failure.message,
        })
      ).pipe(Effect.as(false)),
  }),
  Effect.tap((pass) =>
    Effect.sync(() => {
      process.exitCode = pass ? 0 : 1;
    })
  ),
  Effect.provide(NodeServices.layer)
);

NodeRuntime.runMain(main);
