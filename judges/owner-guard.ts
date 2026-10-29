// Does the wizard's owner-only guard refuse every artifacts and portal host, in any letter case?
// (ADR 0038, docs/phase-2/notes/reach.md R2.) Caddy's `host` matchers ignore case, so a guard that
// compares case-sensitively lets `Host: PLANS.gneiss.run` past it to a handle that still serves the
// page. This judge runs the guard `ops/wizards/reach-edits.ts` writes in a throwaway Caddy from the
// live image (`judges/lib/ThrowawayCaddy.ts`), with `forward_auth` pointed at a stub that answers
// 403 to everything, so a refused host is one the guard caught.
//
//   node judges/owner-guard.ts [--image caddy-caddy:latest]
//
// One container, three Caddyfiles in turn, each a `*.gneiss.run` site shaped like the live one
// (the hand-written `@owner_plans` handle, a porch-style portal handle, an unguarded `t3` handle and
// the catch-all):
//
// - guarded (the wizard's edit): plans and portal hosts, lower and upper case, answer 403; t3 is
//   still served (200); an unknown host is the catch-all's 404.
// - control, unguarded: the plans host is served. Proves the check can fail.
// - control, case-sensitive (the guard before this fix): lower-case hosts answer 403 and upper-case
//   ones are served. Proves the check catches the case bypass.
//
// Prints one JSON line and exits 0 when the guarded variant passes and both controls fail.

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

import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Result } from "effect";

import { ownerMatcherLine, ownerOnly } from "../ops/wizards/reach-edits.ts";
import {
  DEFAULT_CADDY_IMAGE,
  freePort,
  startCaddy,
  ThrowawayCaddyError,
} from "./lib/ThrowawayCaddy.ts";

const { values } = parseArgs({
  options: { image: { type: "string", default: DEFAULT_CADDY_IMAGE } },
});

/** The guard as it was before matching ignored case: the control that must fail. */
const LEGACY_MATCHER =
  "\t@cairn_owner_only expression `{host} == 'plans.gneiss.run' || {host}.matches('^[a-z0-9-]+--[a-z0-9-]+\\\\.gneiss\\\\.run$')`";

/** Hosts the guard must refuse. */
const GUARDED_HOSTS = [
  "plans.gneiss.run",
  "PLANS.gneiss.run",
  "Plans.Gneiss.Run",
  "main--cairn.gneiss.run",
  "MAIN--CAIRN.gneiss.run",
  "main--cairn.GNEISS.run",
];

interface Ports {
  readonly site: number;
  readonly admin: number;
  readonly auth: number;
}

const siteAddress = (ports: Ports) =>
  `http://*.gneiss.run:${String(ports.site)}`;

/** A site shaped like the live one, with no guard. */
const fixture = (ports: Ports) =>
  [
    "{",
    `\tadmin 127.0.0.1:${String(ports.admin)}`,
    "\tauto_https off",
    "\tpersist_config off",
    "}",
    "",
    `${siteAddress(ports)} {`,
    "\tbind 127.0.0.1",
    "",
    "\t@owner_plans host plans.gneiss.run",
    "\thandle @owner_plans {",
    '\t\trespond "artifact" 200',
    "\t}",
    "",
    "\t@t3 host t3.gneiss.run",
    "\thandle @t3 {",
    '\t\trespond "t3" 200',
    "\t}",
    "",
    "\t@main--cairn host main--cairn.gneiss.run",
    "\thandle @main--cairn {",
    '\t\trespond "portal" 200',
    "\t}",
    "",
    "\thandle {",
    '\t\trespond "Service not found" 404',
    "\t}",
    "}",
    "",
  ].join("\n");

const guarded = (ports: Ports) =>
  Effect.gen(function* () {
    const edited = ownerOnly(fixture(ports), {
      site: siteAddress(ports),
      auth: `127.0.0.1:${String(ports.auth)}`,
    });

    if (Result.isFailure(edited)) {
      return yield* new ThrowawayCaddyError({
        message: `the owner-only edit refused the fixture: ${edited.failure}`,
      });
    }

    return edited.success.text;
  });

/** A stub `/_cairn/auth` that refuses everyone, closed with the scope. */
const refusingAuth = (port: number) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((_request, response) => {
        response.statusCode = 403;
        response.end("refused by the stub");
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

/** The status a GET with `Host: host` answers through the throwaway Caddy. */
const statusFor = (port: number, host: string) =>
  Effect.callback<number>((resume) => {
    const sent = request(
      // A fresh connection each time: a kept-alive one may be the one a reload just closed.
      {
        host: "127.0.0.1",
        port,
        path: "/cairn/probe.html",
        headers: { host },
        agent: false,
      },
      (response) => {
        response.resume();
        resume(Effect.succeed(response.statusCode ?? 0));
      }
    );

    sent.on("error", () => {
      resume(Effect.succeed(0));
    });
    sent.end();
  });

const statusesFor = (port: number) =>
  Effect.gen(function* () {
    const statuses: Record<string, number> = {};

    for (const host of [
      ...GUARDED_HOSTS,
      "t3.gneiss.run",
      "nothing.gneiss.run",
    ]) {
      statuses[host] = yield* statusFor(port, host);
    }

    return statuses;
  });

const guardHolds = (statuses: Readonly<Record<string, number>>) =>
  GUARDED_HOSTS.every((host) => statuses[host] === 403) &&
  statuses["t3.gneiss.run"] === 200 &&
  statuses["nothing.gneiss.run"] === 404;

const main = Effect.scoped(
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() =>
        realpathSync(mkdtempSync(path.join(tmpdir(), "cairn-owner-guard-")))
      ),
      (dir) =>
        Effect.sync(() => {
          rmSync(dir, { recursive: true, force: true });
        })
    );

    const conf = path.join(root, "conf");
    const caddyfile = path.join(conf, "Caddyfile");
    mkdirSync(conf);

    const ports: Ports = {
      site: yield* freePort,
      admin: yield* freePort,
      auth: yield* freePort,
    };

    yield* refusingAuth(ports.auth);

    writeFileSync(caddyfile, fixture(ports));

    const caddy = yield* startCaddy({
      conf,
      mounts: [],
      waitPort: ports.site,
      image: values.image,
    });

    const unguarded = yield* statusesFor(ports.site);

    const guardedText = yield* guarded(ports);

    writeFileSync(
      caddyfile,
      guardedText.replace(ownerMatcherLine("\t"), () => LEGACY_MATCHER)
    );
    yield* caddy.reload;
    const legacy = yield* statusesFor(ports.site);

    writeFileSync(caddyfile, guardedText);
    yield* caddy.reload;
    const real = yield* statusesFor(ports.site);

    const realPassed = guardHolds(real);

    const controlsFailed =
      !guardHolds(unguarded) &&
      unguarded["plans.gneiss.run"] === 200 &&
      !guardHolds(legacy) &&
      legacy["plans.gneiss.run"] === 403 &&
      legacy["PLANS.gneiss.run"] === 200;

    const pass = realPassed && controlsFailed;

    yield* Console.log(
      JSON.stringify({
        judge: "owner-guard",
        image: values.image,
        pass,
        realPassed,
        controlsFailed,
        guarded: real,
        unguarded,
        caseSensitive: legacy,
      })
    );

    return pass;
  })
).pipe(
  Effect.catchTag("ThrowawayCaddyError", (failure) =>
    Console.log(
      JSON.stringify({
        judge: "owner-guard",
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
