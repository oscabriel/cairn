// The artifacts kill judge (plan section 2's durability rule, waves.md "Kill coverage"): Cairn's
// `Artifacts` on the real porch binary, killed with SIGKILL inside each crash window of its own
// steps, then the replay-safe call run again in a fresh process, as pi-durable replays a
// `replay: "safe"` tool after a brain dies. Each life is `fixtures/reach/ArtifactBrain.ts` over one
// `cairn.sqlite` file and data folder in the judge's scratch root.
//
//   node judges/artifacts-kill.ts --porch /tmp/reach-probe/porch-bin [--case <name>]...
//
// porch runs only inside that scratch root (`HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, the
// artifacts folder and a Caddyfile it never reloads, `--reload true`), so the user's porch, Caddy
// and artifacts folder are never touched. No Caddy, no container, no model.
//
// Cases, each its own page:
// - stage: killed after the staged copy is written, before porch runs; the rerun publishes.
// - claim: killed after `ArtifactPublisher` inserted its claim, before porch; the rerun publishes
//   under the held claim.
// - porch: killed after porch published, before the row was filled in (a page served, its row
//   unfilled); the rerun fills it in.
// - publish: killed after porch published and the row was filled in; the rerun is `changed: false`.
// - restore: published, revoked, then killed after the republish cleared `revoked_at` and before
//   the copy porch will not write is restored (a live row with nothing served); the rerun restores.
// - remove: killed after a revoke removed the files, before it marked the row; the rerun marks it.
//
// Per case it asserts that the kill landed (the process died of SIGKILL and the window's state is
// the torn one, not the end state, which is the control: without the rerun the case would fail),
// then that the rerun ends right: one row for the page, served bytes equal to the source's (or
// nothing served after a revoke), and no stray file in the artifacts or staging folder. Prints one
// line per check and a JSON summary; exits 0 on a pass.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Option, Schema } from "effect";

import { THREAD_A } from "../apps/server/src/reach/ArtifactScenarios.ts";
import type { ArtifactLife } from "./fixtures/reach/ArtifactBrain.ts";

const { values } = parseArgs({
  options: {
    porch: { type: "string", default: "porch" },
    case: { type: "string", multiple: true },
  },
});

const repo = path.join(import.meta.dirname, "..");

const brainScript = path.join(
  import.meta.dirname,
  "fixtures",
  "reach",
  "ArtifactBrain.ts"
);

const PROJECT = "kill";

/** The most a life may take before the judge counts it hung. */
const LIFE_TIMEOUT_MS = 60_000;

interface Life {
  readonly signal: string | null;
  readonly code: number | null;
  /** The life's last stdout line, or its stderr's tail when it printed none. */
  readonly answer: string;
}

const Answer = Schema.Struct({
  ok: Schema.Boolean,
  changed: Schema.optionalKey(Schema.Boolean),
  revoked: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.String),
  rows: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        hash: Schema.NullOr(Schema.String),
        revoked_at: Schema.NullOr(Schema.Int),
      })
    )
  ),
});

const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer));

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "cairn-art-kill-")));

const dir = (name: string) => path.join(root, name);

/** Runs one life to its end; SIGKILL after `LIFE_TIMEOUT_MS`, so a hang is a failure, not a wait. */
const runLife = (spec: Omit<ArtifactLife, "porch" | "root" | "project">) =>
  Effect.callback<Life>((resume) => {
    const life: ArtifactLife = {
      ...spec,
      porch: values.porch,
      root,
      project: PROJECT,
    };

    const child = spawn(process.execPath, [brainScript, JSON.stringify(life)], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";

    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf-8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, LIFE_TIMEOUT_MS);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const last = out.trim().split("\n").at(-1) ?? "";

      // No answer line means the life died first, which a kill case expects.
      const answer = last === "" ? err.trim().slice(-400) : last;

      resume(Effect.succeed({ signal, code, answer }));
    });
  });

const answerOf = (life: Life) => decodeAnswer(life.answer);

const ok = (life: Life) => {
  const answer = answerOf(life);

  return life.code === 0 && Option.isSome(answer) && answer.value.ok;
};

const killed = (life: Life) => life.signal === "SIGKILL";

interface Check {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Array<Check> = [];

const record = (check: string, passed: boolean, detail = "") =>
  Effect.gen(function* () {
    checks.push({ check, ok: passed, detail });
    yield* Console.log(
      `${passed ? "ok  " : "FAIL"} ${check}${detail === "" ? "" : `: ${detail}`}`
    );
  });

const served = (name: string) => path.join(dir("artifacts"), PROJECT, name);

const staged = (name: string) =>
  path.join(dir("data"), "artifacts", THREAD_A, PROJECT, name);

const source = (name: string) => path.join(dir("thread"), name);

const listing = (folder: string) =>
  existsSync(folder) ? readdirSync(folder).toSorted() : [];

/** The project's rows as stored, read by a life of its own. */
const rowsNow = Effect.gen(function* () {
  const life = yield* runLife({
    action: "rows",
    name: "",
    fault: "",
    marker: dir("no-marker"),
  });

  const answer = answerOf(life);

  return Option.isSome(answer) ? (answer.value.rows ?? []) : [];
});

/** Pages that should be live once every case so far ran; the folders hold exactly these. */
const live = new Set<string>();

/** One row for `name`, in the state `expect` names, the folders holding exactly the live pages. */
const endState = (name: string, expect: "live" | "revoked") =>
  Effect.gen(function* () {
    const rows = (yield* rowsNow).filter((row) => row.name === name);
    const [row] = rows;

    const rowOk =
      rows.length === 1 &&
      row !== undefined &&
      row.hash !== null &&
      (expect === "live" ? row.revoked_at === null : row.revoked_at !== null);

    yield* record(`${name}: one ${expect} row`, rowOk, JSON.stringify(rows));

    if (expect === "live") {
      const want = readFileSync(source(name), "utf-8");

      const have = existsSync(served(name))
        ? readFileSync(served(name), "utf-8")
        : "(nothing served)";

      yield* record(
        `${name}: the served bytes are the source's`,
        have === want,
        JSON.stringify(have)
      );
    } else {
      yield* record(
        `${name}: nothing served`,
        !existsSync(served(name)) && !existsSync(staged(name))
      );
    }

    const want = [...live].toSorted();
    const artifacts = listing(path.join(dir("artifacts"), PROJECT));
    const staging = listing(path.dirname(staged(name)));

    yield* record(
      `${name}: no stray file`,
      JSON.stringify(artifacts) === JSON.stringify(want) &&
        JSON.stringify(staging) === JSON.stringify(want),
      `artifacts ${JSON.stringify(artifacts)}, staging ${JSON.stringify(staging)}, expected ${JSON.stringify(want)}`
    );
  });

const fault = (step: string, name: string) => ({
  fault: `artifact:after-${step}`,
  marker: dir(`fired-${name}`),
});

const noFault = (name: string) => ({
  fault: "",
  marker: dir(`none-${name}`),
});

const write = (name: string, text: string) => {
  writeFileSync(source(name), text);
};

const killedLife = (label: string, life: Life) =>
  record(
    `${label}: the life died of SIGKILL in the window`,
    killed(life),
    `signal ${String(life.signal)}, code ${String(life.code)}, ${life.answer}`
  );

const rerun = (label: string, life: Life) =>
  record(`${label}: the rerun answers`, ok(life), life.answer);

const step = (label: string, life: Life) =>
  record(label, ok(life), life.answer);

const cases = {
  stage: Effect.gen(function* () {
    const name = "stage.html";
    write(name, "<p>stage</p>\n");

    yield* killedLife(
      "stage",
      yield* runLife({ action: "publish", name, ...fault("stage", name) })
    );

    const torn = (yield* rowsNow).filter((row) => row.name === name);
    yield* record(
      "stage: torn state (staged, no row, nothing served)",
      existsSync(staged(name)) &&
        torn.length === 0 &&
        !existsSync(served(name)),
      JSON.stringify(torn)
    );

    yield* rerun(
      "stage",
      yield* runLife({ action: "publish", name, ...fault("stage", name) })
    );
    live.add(name);
    yield* endState(name, "live");
  }),
  claim: Effect.gen(function* () {
    const name = "claim.html";
    write(name, "<p>claim</p>\n");

    yield* killedLife(
      "claim",
      yield* runLife({ action: "publish", name, ...fault("claim", name) })
    );

    const torn = (yield* rowsNow).filter((row) => row.name === name);
    yield* record(
      "claim: torn state (a claim with no hash, nothing served)",
      torn.length === 1 && torn[0]?.hash === null && !existsSync(served(name)),
      JSON.stringify(torn)
    );

    yield* rerun(
      "claim",
      yield* runLife({ action: "publish", name, ...fault("claim", name) })
    );
    live.add(name);
    yield* endState(name, "live");
  }),
  porch: Effect.gen(function* () {
    const name = "porch.html";
    write(name, "<p>porch</p>\n");

    yield* killedLife(
      "porch",
      yield* runLife({ action: "publish", name, ...fault("porch", name) })
    );

    const torn = (yield* rowsNow).filter((row) => row.name === name);
    yield* record(
      "porch: torn state (served, the row's hash not filled in)",
      torn.length === 1 && torn[0]?.hash === null && existsSync(served(name)),
      JSON.stringify(torn)
    );

    yield* rerun(
      "porch",
      yield* runLife({ action: "publish", name, ...fault("porch", name) })
    );
    live.add(name);
    yield* endState(name, "live");
  }),
  publish: Effect.gen(function* () {
    const name = "publish.html";
    write(name, "<p>publish</p>\n");

    yield* killedLife(
      "publish",
      yield* runLife({ action: "publish", name, ...fault("publish", name) })
    );

    const again = yield* runLife({
      action: "publish",
      name,
      ...fault("publish", name),
    });

    yield* rerun("publish", again);

    const answer = answerOf(again);
    yield* record(
      "publish: the rerun is changed: false",
      Option.isSome(answer) && answer.value.changed === false,
      again.answer
    );
    live.add(name);
    yield* endState(name, "live");
  }),
  restore: Effect.gen(function* () {
    const name = "restore.html";
    write(name, "<p>restore</p>\n");

    yield* step(
      "restore: first publish",
      yield* runLife({ action: "publish", name, ...noFault(name) })
    );
    yield* step(
      "restore: revoke",
      yield* runLife({ action: "revoke", name, ...noFault(name) })
    );
    yield* killedLife(
      "restore",
      yield* runLife({ action: "publish", name, ...fault("publish", name) })
    );

    const torn = (yield* rowsNow).filter((row) => row.name === name);
    yield* record(
      "restore: torn state (a live row, nothing served)",
      torn.length === 1 &&
        torn[0]?.revoked_at === null &&
        !existsSync(served(name)),
      JSON.stringify(torn)
    );

    yield* rerun(
      "restore",
      yield* runLife({ action: "publish", name, ...fault("publish", name) })
    );
    live.add(name);
    yield* endState(name, "live");
  }),
  remove: Effect.gen(function* () {
    const name = "remove.html";
    write(name, "<p>remove</p>\n");

    yield* step(
      "remove: publish",
      yield* runLife({ action: "publish", name, ...noFault(name) })
    );
    live.add(name);

    yield* killedLife(
      "remove",
      yield* runLife({ action: "revoke", name, ...fault("remove", name) })
    );

    const torn = (yield* rowsNow).filter((row) => row.name === name);
    yield* record(
      "remove: torn state (files gone, the row still live)",
      torn.length === 1 &&
        torn[0]?.revoked_at === null &&
        !existsSync(served(name)),
      JSON.stringify(torn)
    );

    yield* rerun(
      "remove",
      yield* runLife({ action: "revoke", name, ...fault("remove", name) })
    );
    live.delete(name);
    yield* endState(name, "revoked");
  }),
};

const judge = Effect.gen(function* () {
  for (const name of ["home", "cfg", "state", "artifacts", "data", "thread"]) {
    mkdirSync(dir(name));
  }

  const caddyfile = dir("Caddyfile");
  writeFileSync(caddyfile, "*.gneiss.run {\n}\n");

  const init = yield* Effect.callback<number | null>((resume) => {
    const child = spawn(
      values.porch,
      [
        "init",
        "--domain",
        "gneiss.run",
        "--artifacts",
        dir("artifacts"),
        "--caddyfile",
        caddyfile,
        "--reload",
        "true",
        "--json",
      ],
      {
        cwd: root,
        stdio: "ignore",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir("home"),
          XDG_CONFIG_HOME: dir("cfg"),
          XDG_STATE_HOME: dir("state"),
        },
      }
    );

    child.on("error", () => {
      resume(Effect.succeed(-1));
    });
    child.on("close", (code) => {
      resume(Effect.succeed(code));
    });
  });

  yield* record("porch init in the scratch root", init === 0, String(init));

  if (init !== 0) {
    return false;
  }

  const chosen = values.case ?? Object.keys(cases);

  for (const name of chosen) {
    const run = Object.entries(cases).find(([key]) => key === name);

    yield* run === undefined ? record(`unknown case ${name}`, false) : run[1];
  }

  const passed = checks.filter((each) => each.ok).length;
  const pass = passed === checks.length;

  yield* Console.log(
    JSON.stringify({
      judge: "artifacts-kill",
      pass,
      porch: values.porch,
      cases: chosen,
      checks: checks.length,
      passed,
    })
  );

  return pass;
});

const main = judge.pipe(
  Effect.ensuring(
    Effect.sync(() => {
      rmSync(root, { recursive: true, force: true });
    })
  ),
  Effect.tap((pass) =>
    Effect.sync(() => {
      process.exitCode = pass ? 0 : 1;
    })
  )
);

NodeRuntime.runMain(main);
