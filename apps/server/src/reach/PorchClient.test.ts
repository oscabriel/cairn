// PorchClient on two stages. The fake layer runs the whole porch contract (`PorchScenarios.ts`, the
// same scenarios `judges/porch-contract.ts` runs on the real binary), and Cairn's publish rule over
// it, with its broken control failing. The real layer runs against stub binaries that print what
// porch prints, so its error mapping and receipt decoding are held without porch installed.

import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Exit, FileSystem, Layer, Option } from "effect";

import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { Artifacts0010 } from "../db/migrations/0010Artifacts.ts";
import { Portals0011 } from "../db/migrations/0011Portals.ts";
import { ArtifactPublisher } from "./ArtifactPublisher.ts";
import { makeFakePorch, PorchClient, PorchSettings } from "./PorchClient.ts";
import {
  clientScenarios,
  publisherScenarios,
  unmanagedControl,
} from "./PorchScenarios.ts";
import type { PorchStage } from "./PorchScenarios.ts";

const DOMAIN = "example.test";

const BROKEN = "unrecognized directive: cairn_judge_broken";

/** A fresh fake porch over a temp artifacts folder, and the layers built on it. */
const fakeStage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cairn-porch-" });
  const artifacts = path.join(root, "artifacts");
  const sources = path.join(root, "sources");
  yield* fs.makeDirectory(artifacts);
  yield* fs.makeDirectory(sources);
  const fake = yield* makeFakePorch({ domain: DOMAIN, artifacts });

  const stage: PorchStage = {
    domain: DOMAIN,
    artifacts,
    sources,
    breakProxy: fake.refuseReloads(Option.some(BROKEN)),
    mendProxy: fake.refuseReloads(Option.none()),
    brokenProxyText: BROKEN,
  };

  const porch = Layer.succeed(PorchClient, fake.client);

  const layer = ArtifactPublisher.layer.pipe(
    Layer.provideMerge(porch),
    Layer.provideMerge(
      Database.layerTest({
        ...migrations,
        "0010_Artifacts": Artifacts0010,
        "0011_Portals": Portals0011,
      })
    ),
    Layer.provideMerge(NodeServices.layer)
  );

  return { stage, layer, fake };
});

describe("PorchClient fake: the porch contract", () => {
  it.live("runs every client and publisher scenario", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stage, layer, fake } = yield* fakeStage;

        for (const scenario of [...clientScenarios, ...publisherScenarios]) {
          const exit = yield* Effect.exit(
            scenario.run(stage).pipe(Effect.provide(layer))
          );

          assert.isTrue(
            Exit.isSuccess(exit),
            `${scenario.name}: ${Exit.isFailure(exit) ? String(exit.cause) : ""}`
          );
        }

        assert.isAbove(yield* fake.reloads, 3);
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it.live("the unmanaged-overwrite control fails: porch alone overwrites", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stage, layer } = yield* fakeStage;

        const exit = yield* Effect.exit(
          unmanagedControl.run(stage).pipe(Effect.provide(layer))
        );

        assert.isTrue(Exit.isFailure(exit));
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );
});

/** A stub porch: a shell script that prints `stdout`, `stderr` and exits `code`. */
const stubPorch = (stdout: string, code: number, stderr = "") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "cairn-porch-stub-",
    });

    const bin = path.join(root, "porch");
    yield* fs.writeFileString(path.join(root, "out"), stdout);
    yield* fs.writeFileString(path.join(root, "err"), stderr);
    yield* fs.writeFileString(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/argv"\ncat "${root}/out"\ncat "${root}/err" >&2\nexit ${String(code)}\n`
    );
    yield* fs.chmod(bin, 0o755);

    return { bin, root };
  });

const realLayer = (bin: string, env: Readonly<Record<string, string>> = {}) =>
  PorchClient.layer.pipe(
    Layer.provide(
      Layer.succeed(PorchSettings, {
        bin,
        env,
        timeout: Duration.seconds(10),
      })
    )
  );

describe("PorchClient real layer: receipts and refusals", () => {
  it.live("decodes a publish receipt and passes argv without a shell", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const { bin, root } = yield* stubPorch(
          JSON.stringify({
            changed: true,
            hash: "abc",
            path: "/srv/a/p/r.html",
            republish: "porch publish /tmp/r.html --project p",
            url: "https://plans.example.test/p/r.html",
          }),
          0
        );

        const receipt = yield* Effect.gen(function* () {
          const porch = yield* PorchClient;

          return yield* porch.publish("/tmp/x; rm -rf ~/r.html", "p");
        }).pipe(Effect.provide(realLayer(bin)));

        assert.deepStrictEqual(receipt, {
          changed: true,
          hash: "abc",
          path: "/srv/a/p/r.html",
          url: "https://plans.example.test/p/r.html",
        });
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, "argv")),
          "publish\n/tmp/x; rm -rf ~/r.html\n--project\np\n--json\n"
        );
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it.live("maps porch's refusal codes, keeping the proxy's words", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const message =
          "caddy refused to reload, so nothing changed. It said:\nError: adapting config using caddyfile: unrecognized directive: cairn_judge_broken\n(reload command: docker exec caddy caddy reload --config /etc/caddy/Caddyfile)";

        const { bin } = yield* stubPorch(
          JSON.stringify({ error: { code: "proxy-refused", message } }),
          1
        );

        const error = yield* Effect.flip(
          Effect.gen(function* () {
            const porch = yield* PorchClient;

            return yield* porch.add("main--cairn", "http://127.0.0.1:3101");
          }).pipe(Effect.provide(realLayer(bin)))
        );

        assert.strictEqual(error.reason, "proxy-refused");
        assert.strictEqual(Option.getOrNull(error.porchCode), "proxy-refused");
        assert.include(
          error.detail,
          "unrecognized directive: cairn_judge_broken"
        );
        assert.include(error.message, "unrecognized directive");
        assert.isFalse(error.retryable);
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it.live("an unknown code is other, and keeps porch's code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bin } = yield* stubPorch(
          JSON.stringify({
            error: { code: "busy", message: "another porch holds the lock" },
          }),
          1
        );

        const error = yield* Effect.flip(
          Effect.gen(function* () {
            const porch = yield* PorchClient;

            return yield* porch.remove("main--cairn");
          }).pipe(Effect.provide(realLayer(bin)))
        );

        assert.strictEqual(error.reason, "other");
        assert.strictEqual(Option.getOrNull(error.porchCode), "busy");
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it.live("a crash with no JSON is crashed, with the end of stderr", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bin } = yield* stubPorch(
          "",
          1,
          'TypeError: Invalid URL\n input: "notaurl"\n'
        );

        const error = yield* Effect.flip(
          Effect.gen(function* () {
            const porch = yield* PorchClient;

            return yield* porch.list;
          }).pipe(Effect.provide(realLayer(bin)))
        );

        assert.strictEqual(error.reason, "crashed");
        assert.include(error.detail, "Invalid URL");
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it.live("output that does not decode is bad-receipt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bin } = yield* stubPorch(
          JSON.stringify({ name: "x", url: "http://not-https" }),
          0
        );

        const error = yield* Effect.flip(
          Effect.gen(function* () {
            const porch = yield* PorchClient;

            return yield* porch.add("main--cairn", "http://127.0.0.1:3101");
          }).pipe(Effect.provide(realLayer(bin)))
        );

        assert.strictEqual(error.reason, "bad-receipt");
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it.live("doctor's failing checks are answers, not errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { bin } = yield* stubPorch(
          JSON.stringify([
            { detail: "matches", name: "Snippet is current", ok: true },
            { detail: "ENOTFOUND", name: "*.example.test resolves", ok: false },
          ]),
          1
        );

        const checks = yield* Effect.gen(function* () {
          const porch = yield* PorchClient;

          return yield* porch.doctor;
        }).pipe(Effect.provide(realLayer(bin)));

        assert.deepStrictEqual(
          checks.map((check) => check.ok),
          [true, false]
        );
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it.live("a missing binary is unavailable and retryable", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.gen(function* () {
          const porch = yield* PorchClient;

          return yield* porch.version;
        }).pipe(Effect.provide(realLayer("/nonexistent/porch")))
      );

      assert.strictEqual(error.reason, "unavailable");
      assert.isTrue(error.retryable);
    })
  );

  it.live("machine reads porch's config under the given XDG_CONFIG_HOME", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "cairn-porch-cfg-",
        });

        const layer = realLayer("/nonexistent/porch", {
          XDG_CONFIG_HOME: root,
        });

        const before = yield* Effect.flip(
          Effect.gen(function* () {
            return yield* (yield* PorchClient).machine;
          }).pipe(Effect.provide(layer))
        );

        assert.strictEqual(before.reason, "no-config");

        yield* fs.makeDirectory(path.join(root, "porchlight"));
        yield* fs.writeFileString(
          path.join(root, "porchlight", "config.json"),
          JSON.stringify({
            artifacts: "/home/u/Developer/agent-artifacts",
            domain: "gneiss.run",
            ports: { range: [3100, 3699] },
            proxy: { kind: "caddy", reload: "true" },
          })
        );

        const machine = yield* Effect.gen(function* () {
          return yield* (yield* PorchClient).machine;
        }).pipe(Effect.provide(layer));

        assert.deepStrictEqual(machine, {
          domain: "gneiss.run",
          artifacts: "/home/u/Developer/agent-artifacts",
        });
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it.live("bad input never reaches porch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { bin, root } = yield* stubPorch("{}", 0);

        const error = yield* Effect.flip(
          Effect.gen(function* () {
            return yield* (yield* PorchClient).add("-x", "http://127.0.0.1:1");
          }).pipe(Effect.provide(realLayer(bin)))
        );

        assert.strictEqual(error.reason, "bad-input");
        assert.isFalse(yield* fs.exists(path.join(root, "argv")));
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );
});
