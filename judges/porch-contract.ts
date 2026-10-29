// The porch contract on the real binary (ADR 0038, docs/phase-2/notes/reach.md R3): every scenario
// `PorchClient.test.ts` runs on the fake layer (`apps/server/src/reach/PorchScenarios.ts`), here
// through `PorchClient.layer` and the installed porch, against a throwaway Caddy
// (`judges/lib/ThrowawayCaddy.ts`) that porch reloads with the live command aimed at it.
//
//   node judges/porch-contract.ts [--porch porch] [--image caddy-caddy:latest]
//
// porch runs only inside a temp folder the judge owns: `HOME`, `XDG_CONFIG_HOME` and
// `XDG_STATE_HOME` point there, as do the artifacts folder and the Caddyfile, so the user's porch
// config, registry and agent-artifacts are never read or written. The judge never runs
// `porch import`.
//
// Passes when:
// - every client scenario holds on the real porch (receipts decode, refusal codes, the proxy's
//   words in `proxy-refused`), so the fake layer is faithful to it;
// - every publisher scenario holds (Cairn refuses to overwrite a file it did not publish);
// - the throwaway Caddy serves the last published bytes at `plans.example.test`, and the
//   hand-written page the publisher refused to overwrite still reads as written;
// - the control fails: the same publish straight through porch overwrites the hand-written file.
//   While it fails, porch still overwrites unmanaged files and Cairn's rule is load-bearing.
//
// Prints one line per scenario and a JSON summary; exits 0 on a pass, 1 otherwise.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Duration, Effect, Exit, Layer } from "effect";

import { Database } from "../apps/server/src/db/Database.ts";
import { migrations } from "../apps/server/src/db/Migrations.ts";
import { Artifacts0010 } from "../apps/server/src/db/migrations/0010Artifacts.ts";
import { ArtifactPublisher } from "../apps/server/src/reach/ArtifactPublisher.ts";
import {
  PorchClient,
  PorchSettings,
} from "../apps/server/src/reach/PorchClient.ts";
import {
  clientScenarios,
  publisherScenarios,
  unmanagedControl,
} from "../apps/server/src/reach/PorchScenarios.ts";
import type { PorchStage } from "../apps/server/src/reach/PorchScenarios.ts";
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

const DOMAIN = "example.test";

const BROKEN = "cairn_judge_broken";

/** The judge's folders, removed with the scope. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "cairn-porch-contract-"))
    );

    const dirs = {
      root,
      home: path.join(root, "home"),
      cfg: path.join(root, "cfg"),
      state: path.join(root, "state"),
      artifacts: path.join(root, "artifacts"),
      sources: path.join(root, "sources"),
      conf: path.join(root, "conf"),
    };

    for (const dir of [
      dirs.home,
      dirs.cfg,
      dirs.state,
      dirs.artifacts,
      dirs.sources,
      dirs.conf,
    ]) {
      mkdirSync(dir);
    }

    return dirs;
  }),
  (dirs) =>
    Effect.sync(() => {
      rmSync(dirs.root, { recursive: true, force: true });
    })
);

interface CaddySite {
  readonly site: number;
  readonly admin: number;
  readonly snippets: string;
}

const caddyfile = (at: CaddySite, withSnippets: boolean, broken: boolean) => {
  const lines = [
    "{",
    `\tadmin 127.0.0.1:${String(at.admin)}`,
    "\tauto_https off",
    "\tpersist_config off",
    "}",
    "",
    `http://*.${DOMAIN}:${String(at.site)} {`,
    "\tbind 127.0.0.1",
  ];

  if (broken) {
    lines.push(`\t${BROKEN}`);
  }

  if (withSnippets) {
    lines.push(
      `\timport ${at.snippets}/porches.caddy`,
      `\timport ${at.snippets}/errors.caddy`
    );
  }

  lines.push("\thandle {", '\t\trespond "Service not found" 404', "\t}", "}");

  return `${lines.join("\n")}\n`;
};

/** GET through the throwaway Caddy with a `Host` of `<host>.example.test`. */
const fetchThrough = (port: number, host: string, urlPath: string) =>
  Effect.callback<{ readonly status: number; readonly body: string }>(
    (resume) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: urlPath,
          headers: { Host: `${host}.${DOMAIN}` },
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
        }
      );

      req.on("error", () => {
        resume(Effect.succeed({ status: 0, body: "" }));
      });
      req.end();
    }
  );

const contract = Effect.gen(function* () {
  const dirs = yield* scratch;

  const at: CaddySite = {
    site: yield* freePort,
    admin: yield* freePort,
    snippets: path.join(dirs.cfg, "porchlight", "caddy"),
  };

  const caddyfilePath = path.join(dirs.conf, "Caddyfile");

  const env = {
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.cfg,
    XDG_STATE_HOME: dirs.state,
  };

  writeFileSync(caddyfilePath, caddyfile(at, false, false));

  const caddy = yield* startCaddy({
    conf: dirs.conf,
    mounts: [dirs.root],
    waitPort: at.site,
    image: values.image,
  });

  // Every answer given, so init asks nothing; its DNS and certificate checks fail for example.test
  // and are only printed. It writes the machine config and an empty snippet.
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

  writeFileSync(caddyfilePath, caddyfile(at, true, false));
  yield* caddy.reload;

  const stage: PorchStage = {
    domain: DOMAIN,
    artifacts: dirs.artifacts,
    sources: dirs.sources,
    breakProxy: Effect.sync(() => {
      writeFileSync(caddyfilePath, caddyfile(at, true, true));
    }),
    mendProxy: Effect.sync(() => {
      writeFileSync(caddyfilePath, caddyfile(at, true, false));
    }),
    brokenProxyText: BROKEN,
  };

  const layer = ArtifactPublisher.layer.pipe(
    Layer.provideMerge(PorchClient.layer),
    Layer.provideMerge(
      Database.layerTest({ ...migrations, "0010_Artifacts": Artifacts0010 })
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Layer.succeed(PorchSettings, {
        bin: values.porch,
        env,
        timeout: Duration.seconds(30),
      })
    )
  );

  const scenarios = [...clientScenarios, ...publisherScenarios];

  const results: Array<{
    readonly scenario: string;
    readonly ok: boolean;
    readonly detail: string;
  }> = [];

  for (const scenario of [...scenarios, unmanagedControl]) {
    const exit = yield* Effect.exit(
      scenario.run(stage).pipe(Effect.provide(layer))
    );

    const control = scenario === unmanagedControl;

    const result = {
      scenario: scenario.name,
      ok: Exit.isSuccess(exit),
      detail: Exit.isFailure(exit) ? String(exit.cause) : "",
    };

    results.push(result);

    let word = result.ok ? "ok  " : "FAIL";

    if (control) {
      word = result.ok
        ? "FAIL (the control passed)"
        : "ok   (the control failed, as it must)";
    }

    yield* Console.log(
      `${word} ${result.scenario}${result.detail === "" ? "" : `: ${result.detail}`}`
    );
  }

  const served = yield* fetchThrough(at.site, "plans", "/judge/report.html");
  const hand = yield* fetchThrough(at.site, "plans", "/judge/hand.html");

  const handOnDisk = readFileSync(
    path.join(dirs.artifacts, "judge", "hand.html"),
    "utf-8"
  );

  const contractResults = results.slice(0, scenarios.length);
  const controlResult = results.at(-1);
  const servedOk = served.status === 200 && served.body === "<p>second</p>\n";

  const handOk =
    hand.status === 200 &&
    hand.body === "<p>written by hand</p>\n" &&
    handOnDisk === hand.body;

  const controlFailed = controlResult !== undefined && !controlResult.ok;
  const passed = contractResults.filter((line) => line.ok).length;

  const pass =
    passed === scenarios.length && servedOk && handOk && controlFailed;

  yield* Console.log(
    JSON.stringify({
      judge: "porch-contract",
      pass,
      porch: values.porch,
      image: values.image,
      scenarios: scenarios.length,
      scenariosPassed: passed,
      served: { status: served.status, ok: servedOk },
      handWrittenIntact: handOk,
      controlFailed,
    })
  );

  return pass;
});

const main = Effect.scoped(contract).pipe(
  Effect.catchTag("ThrowawayCaddyError", (failure) =>
    Console.log(
      JSON.stringify({
        judge: "porch-contract",
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
