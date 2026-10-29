// The reach judge (ADR 0038, docs/phase-2/notes/reach.md R4 and "Judges"). This is its artifact
// half: Cairn's artifact service on the real porch binary, served by a throwaway Caddy
// (`judges/lib/ThrowawayCaddy.ts`) behind the owner-only guard the wizard writes
// (`ops/wizards/reach-edits.ts`), asking a stub `/_cairn/auth` that admits only the owner. The
// portal half (3F) and the phone check (`--live`, 5G) join it later.
//
//   node judges/reach.ts --porch /tmp/reach-probe/porch-bin [--image caddy-caddy:latest]
//
// porch runs only inside a temp folder the judge owns: `HOME`, `XDG_CONFIG_HOME` and
// `XDG_STATE_HOME` point there, as do the artifacts folder, the Caddyfile, the thread folders and
// the brain's data folder, so the user's porch, `~/caddy` and `~/Developer/agent-artifacts` are
// never read or written. The judge never runs `porch import`.
//
// Passes when:
// - every artifact scenario (`apps/server/src/reach/ArtifactScenarios.ts`) holds on the real porch:
//   publish, idempotent republish (`changed: false`, same URL), an edit in place, another thread
//   refused, a hand-written page never overwritten, secrets and paths outside refused, revoke;
// - through Caddy, the owner reads the last published bytes, a revoked page is gone, and the
//   hand-written page reads as written;
// - owner-only: a stranger is refused (403) on `plans.gneiss.run` in any letter case, while the
//   owner is served (200);
// - both controls fail: porch alone overwrites a hand-written page (Cairn's rule is load-bearing),
//   and with the guard taken out the stranger is served (the owner check can fail).
//
// Prints one line per check and a JSON summary; exits 0 on a pass, 1 otherwise.

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Console,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Result,
} from "effect";

import { ServerConfig } from "../apps/server/src/Config.ts";
import { Database } from "../apps/server/src/db/Database.ts";
import { migrations } from "../apps/server/src/db/Migrations.ts";
import { ArtifactPublisher } from "../apps/server/src/reach/ArtifactPublisher.ts";
import { Artifacts } from "../apps/server/src/reach/Artifacts.ts";
import {
  artifactScenarios,
  overwriteControl,
  SCENARIO_PROJECT,
  THREAD_A,
} from "../apps/server/src/reach/ArtifactScenarios.ts";
import type { ArtifactStage } from "../apps/server/src/reach/ArtifactScenarios.ts";
import {
  PorchClient,
  PorchSettings,
} from "../apps/server/src/reach/PorchClient.ts";
import { DOMAIN, ownerOnly } from "../ops/wizards/reach-edits.ts";
import {
  DEFAULT_CADDY_IMAGE,
  freePort,
  runCommand,
  startCaddy,
  ThrowawayCaddyError,
} from "./lib/ThrowawayCaddy.ts";

const { values } = parseArgs({
  options: {
    porch: { type: "string", default: "porch" },
    image: { type: "string", default: DEFAULT_CADDY_IMAGE },
  },
});

/** The header the stub auth reads to tell the owner from a stranger; Caddy forwards it. */
const PEER_HEADER = "x-judge-peer";

/** The judge's folders, removed with the scope. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "cairn-reach-")));

    const dirs = {
      root,
      home: path.join(root, "home"),
      cfg: path.join(root, "cfg"),
      state: path.join(root, "state"),
      artifacts: path.join(root, "artifacts"),
      conf: path.join(root, "conf"),
      data: path.join(root, "data"),
      threadA: path.join(root, "thread-a"),
      threadB: path.join(root, "thread-b"),
      outside: path.join(root, "outside"),
    };

    for (const dir of Object.values(dirs).slice(1)) {
      mkdirSync(dir);
    }

    return dirs;
  }),
  (dirs) =>
    Effect.sync(() => {
      rmSync(dirs.root, { recursive: true, force: true });
    })
);

interface Ports {
  readonly site: number;
  readonly admin: number;
  readonly auth: number;
}

const siteAddress = (ports: Ports) =>
  `http://*.${DOMAIN}:${String(ports.site)}`;

/** A site shaped like the live one: porch's snippets, then the catch-all. No guard. */
const caddyfile = (ports: Ports, snippets: Option.Option<string>) =>
  [
    "{",
    `\tadmin 127.0.0.1:${String(ports.admin)}`,
    "\tauto_https off",
    "\tpersist_config off",
    "}",
    "",
    `${siteAddress(ports)} {`,
    "\tbind 127.0.0.1",
    ...Option.match(snippets, {
      onNone: () => [],
      onSome: (dir) => [
        `\timport ${dir}/porches.caddy`,
        `\timport ${dir}/errors.caddy`,
      ],
    }),
    "\thandle {",
    '\t\trespond "Service not found" 404',
    "\t}",
    "}",
    "",
  ].join("\n");

/** The same site behind the wizard's owner-only guard, asking the stub on `ports.auth`. */
const guarded = (ports: Ports, text: string) =>
  Effect.gen(function* () {
    const edited = ownerOnly(text, {
      site: siteAddress(ports),
      auth: `127.0.0.1:${String(ports.auth)}`,
    });

    if (Result.isFailure(edited)) {
      return yield* new ThrowawayCaddyError({
        message: `the owner-only edit refused the judge's Caddyfile: ${edited.failure}`,
      });
    }

    return edited.success.text;
  });

/** A stub `/_cairn/auth`: 200 for the owner, 403 for anyone else. Closed with the scope. */
const ownerAuth = (port: number) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((incoming, response) => {
        response.statusCode =
          incoming.headers[PEER_HEADER] === "owner" ? 200 : 403;
        response.end();
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

interface Answer {
  readonly status: number;
  readonly body: string;
  readonly cacheControl: string;
}

/** GET `urlPath` through the throwaway Caddy as `peer`, on a fresh connection. */
const fetchAs = (port: number, host: string, urlPath: string, peer: string) =>
  Effect.callback<Answer>((resume) => {
    const sent = request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        headers: { Host: host, [PEER_HEADER]: peer },
        agent: false,
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
              cacheControl: response.headers["cache-control"] ?? "",
            })
          );
        });
      }
    );

    sent.on("error", () => {
      resume(Effect.succeed({ status: 0, body: "", cacheControl: "" }));
    });
    sent.end();
  });

interface Check {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

const judge = Effect.gen(function* () {
  const dirs = yield* scratch;

  const ports: Ports = {
    site: yield* freePort,
    admin: yield* freePort,
    auth: yield* freePort,
  };

  const caddyfilePath = path.join(dirs.conf, "Caddyfile");
  const snippets = path.join(dirs.cfg, "porchlight", "caddy");

  const env = {
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.cfg,
    XDG_STATE_HOME: dirs.state,
  };

  yield* ownerAuth(ports.auth);
  writeFileSync(caddyfilePath, caddyfile(ports, Option.none()));

  const caddy = yield* startCaddy({
    conf: dirs.conf,
    mounts: [dirs.root],
    waitPort: ports.site,
    image: values.image,
  });

  // Every answer given, so init asks nothing; its DNS and certificate checks are only printed.
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
    env,
    dirs.root
  );

  if (init.status !== 0) {
    return yield* new ThrowawayCaddyError({
      message: `porch init failed (${String(init.status)}): ${init.stderr.trim()}`,
    });
  }

  const open = caddyfile(ports, Option.some(snippets));
  const closed = yield* guarded(ports, open);
  writeFileSync(caddyfilePath, closed);
  yield* caddy.reload;

  const stage: ArtifactStage = {
    domain: DOMAIN,
    artifacts: dirs.artifacts,
    cwd: dirs.threadA,
    otherCwd: dirs.threadB,
    outside: dirs.outside,
  };

  const layer = Artifacts.layer.pipe(
    Layer.provideMerge(ArtifactPublisher.layer),
    Layer.provideMerge(PorchClient.layer),
    Layer.provideMerge(Database.layerTest(migrations)),
    Layer.provideMerge(ServerConfig.layerWith({ dataDir: dirs.data })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Layer.succeed(PorchSettings, {
        bin: values.porch,
        env,
        timeout: Duration.seconds(30),
      })
    )
  );

  const checks: Array<Check> = [];

  const record = (check: string, ok: boolean, detail = "") =>
    Effect.gen(function* () {
      checks.push({ check, ok, detail });
      yield* Console.log(
        `${ok ? "ok  " : "FAIL"} ${check}${detail === "" ? "" : `: ${detail}`}`
      );
    });

  for (const scenario of artifactScenarios) {
    const exit = yield* Effect.exit(
      scenario.run(stage).pipe(Effect.provide(layer))
    );

    yield* record(
      scenario.name,
      Exit.isSuccess(exit),
      Exit.isFailure(exit) ? String(exit.cause) : ""
    );
  }

  // One page published and left revoked, for the served check below.
  const revoked = yield* Effect.exit(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const artifacts = yield* Artifacts;
      yield* fs.writeFileString(
        path.join(dirs.threadA, "revoked.html"),
        "<p>revoked</p>\n"
      );

      const published = yield* artifacts.publish({
        threadId: THREAD_A,
        projectId: Option.none(),
        cwd: dirs.threadA,
        path: "revoked.html",
        name: Option.none(),
        project: Option.some(SCENARIO_PROJECT),
      });

      yield* artifacts.revoke(published.row.id, Option.some(THREAD_A));
    }).pipe(Effect.provide(layer))
  );

  yield* record(
    "publish then revoke a page",
    Exit.isSuccess(revoked),
    Exit.isFailure(revoked) ? String(revoked.cause) : ""
  );

  const control = yield* Effect.exit(
    overwriteControl.run(stage).pipe(Effect.provide(layer))
  );

  yield* record(
    "control: porch alone overwrites a hand-written page (must fail)",
    Exit.isFailure(control),
    Exit.isSuccess(control)
      ? "the control passed: porch refused on its own"
      : ""
  );

  const plans = `plans.${DOMAIN}`;

  const page = (urlPath: string, peer: string, host = plans) =>
    fetchAs(ports.site, host, `/${SCENARIO_PROJECT}/${urlPath}`, peer);

  const report = yield* page("report.html", "owner");

  yield* record(
    "the owner reads the last published bytes",
    report.status === 200 && report.body === "<p>two</p>\n",
    `${String(report.status)} ${JSON.stringify(report.body)}; cache-control ${JSON.stringify(report.cacheControl)}`
  );

  const site = yield* page("site/", "owner");

  yield* record(
    "a published folder is served at its slash URL",
    site.status === 200 && site.body === "<p>site</p>\n",
    String(site.status)
  );

  const hand = yield* page("plan.html", "owner");

  yield* record(
    "the hand-written page reads as written",
    hand.status === 200 && hand.body === "<p>written by hand</p>\n",
    `${String(hand.status)} ${JSON.stringify(hand.body)}`
  );

  const gone = yield* page("revoked.html", "owner");

  yield* record(
    "a revoked page is no longer served",
    gone.status === 404,
    String(gone.status)
  );

  const strangers = yield* Effect.forEach(
    [plans, plans.toUpperCase(), "Plans.Gneiss.Run"],
    (host) =>
      Effect.map(
        page("report.html", "stranger", host),
        (answer) => [host, answer.status] as const
      )
  );

  yield* record(
    "owner-only: a stranger is refused in any letter case",
    strangers.every(([, status]) => status === 403),
    JSON.stringify(Object.fromEntries(strangers))
  );

  writeFileSync(caddyfilePath, open);
  yield* caddy.reload;
  const unguarded = yield* page("report.html", "stranger");
  writeFileSync(caddyfilePath, closed);
  yield* caddy.reload;

  yield* record(
    "control: without the guard a stranger is served (must be 200)",
    unguarded.status === 200,
    String(unguarded.status)
  );

  const passed = checks.filter((each) => each.ok).length;
  const pass = passed === checks.length;

  yield* Console.log(
    JSON.stringify({
      judge: "reach",
      half: "artifacts",
      pass,
      porch: values.porch,
      image: values.image,
      checks: checks.length,
      passed,
      cacheControl: report.cacheControl,
    })
  );

  return pass;
});

const main = Effect.scoped(judge).pipe(
  Effect.catchTag("ThrowawayCaddyError", (failure) =>
    Console.log(
      JSON.stringify({ judge: "reach", pass: false, error: failure.message })
    ).pipe(Effect.as(false))
  ),
  Effect.tap((pass) =>
    Effect.sync(() => {
      process.exitCode = pass ? 0 : 1;
    })
  )
);

NodeRuntime.runMain(main);
