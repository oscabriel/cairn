#!/usr/bin/env bash
# Judge: the brain never changes the user's pi setup (plan D11, 2A). Cairn reads ~/.pi/agent
# (settings, skills, packages, auth.json) through pi's own classes, so this proves the fences hold
# against the real directory, not a fixture.
#
#   judges/pi-readonly.sh [--model <provider>/<modelId>] [--no-turn]
#
# Records every entry under the agent dir (PI_CODING_AGENT_DIR, else ~/.pi/agent) with its type,
# size, mtime and mode, then boots the brain's model side in a throwaway data dir: pi's config
# resolve, the model runtime over auth.json, a model listing, a skills resolve (PiConfig.reload),
# and one turn on an API model through pi-durable (the brain's Harness and extension set). It then
# records the agent dir again. Passes when:
#
# - the two records are identical (no entry created, removed, resized, touched or re-moded),
# - no `.lock` entry exists in the agent dir,
# - the brain process started no child process (no npm, no git, no `!command` key) other than the
#   one `flock` that holds Cairn's OAuth lock (the store is built as the deployed brain's is),
# - openai-codex is not ready: Cairn's own OAuth store is empty here, and pi's Codex login is
#   never read,
# - the listing has opencode-go models and no anthropic model,
# - the turn completed (unless --no-turn).
#
# Prints names, counts, sizes and times only: never a file's contents or a credential. The turn
# uses the cheapest-looking available opencode-go model unless --model names one; it costs cents.
# A pi TUI writing its own sessions during the run would show as a change; rerun when it is idle.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
agent=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
model=""
turn=1

while [[ $# -gt 0 ]]; do
  case $1 in
    --model) model=$2; shift 2 ;;
    --no-turn) turn=0; shift ;;
    *) echo "usage: judges/pi-readonly.sh [--model <provider>/<modelId>] [--no-turn]" >&2; exit 2 ;;
  esac
done

[[ -d $agent ]] || { echo "FAIL no agent dir at $agent"; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/cairn-pi-readonly-XXXXXX")
trap 'rm -rf "$work"' EXIT

record() { find "$agent" -printf '%y %s %T@ %m %P\n' | LC_ALL=C sort; }

record >"$work/before"
echo "agent dir: $agent ($(wc -l <"$work/before") entries)"

# The program runs from apps/server so its bare imports resolve there; Cairn's modules load by
# absolute URL, with Node's type stripping.
src="file://$repo/apps/server/src"
set +e
(
  cd "$repo/apps/server"
  CAIRN_JUDGE_SRC=$src CAIRN_JUDGE_DATA=$work/data CAIRN_JUDGE_MODEL=$model CAIRN_JUDGE_TURN=$turn \
    node --input-type=module -e '
import { createRequire, syncBuiltinESMExports } from "node:module";

// Count every child process the brain starts, before anything that could start one loads.
const spawned = [];
const cp = createRequire(process.cwd() + "/")("node:child_process");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = cp[name];
  cp[name] = (command, ...rest) => {
    spawned.push(String(command).split("/").pop());
    return original.call(cp, command, ...rest);
  };
}
syncBuiltinESMExports();

const src = process.env.CAIRN_JUDGE_SRC;
const { Duration, Effect, Fiber, Layer, Option, Stream } = await import("effect");
const { ServerConfig } = await import(`${src}/Config.ts`);
const { PiConfig } = await import(`${src}/models/PiConfig.ts`);
const { PiModelSource } = await import(`${src}/models/PiModelSource.ts`);
const { HarnessSettings } = await import(`${src}/models/HarnessSettings.ts`);
const { HarnessBoot, PiDurableBrain } = await import(`${src}/AppLayer.ts`);
const { HarnessSeam } = await import(`${src}/brain/HarnessSeam.ts`);
const { PiHost } = await import(`${src}/pi-host/PiHost.ts`);
const { ModelHealth } = await import(`${src}/models/ModelHealth.ts`);
const { ThreadId, ProjectId } = await import("@cairn/protocol/Ids");
const { OAuthStore } = await import(`${src}/models/OAuthStore.ts`);
const { Database } = await import(`${src}/db/Database.ts`);
const { migrations } = await import(`${src}/db/Migrations.ts`);
const { OAuthCredentials0007 } = await import(`${src}/db/migrations/0007OAuthCredentials.ts`);
const { NodeServices } = await import("@effect/platform-node");

const data = process.env.CAIRN_JUDGE_DATA;
const config = ServerConfig.layerWith({ dataDir: data });
const pi = PiConfig.layer.pipe(Layer.provide(config));
// The OAuth store of Cairn itself, built as on the deployed brain, over the throwaway data dir:
// Codex is read from it, never from the auth.json of pi.
const oauth = OAuthStore.layerWith(`${data}/state/oauth.lock`).pipe(
  Layer.provide(Database.layer({
    filename: `${data}/cairn.sqlite`,
    migrations: { ...migrations, "0007_OAuthCredentials": OAuthCredentials0007 },
  })),
  Layer.provide(NodeServices.layer)
);
const models = PiModelSource.layerNoDeps.pipe(
  Layer.provide(HarnessSettings.layerNoDeps),
  Layer.provide(oauth),
  Layer.provideMerge(pi)
);
// The tools-only pi host as the deployed brain builds it: the allowlisted pi packages the user
// enabled, loaded from the agent dir under the throwaway data dir.
const brain = PiDurableBrain({ models }).pipe(
  Layer.provide(PiHost.layer),
  // The store the health feed records into, in memory: this judge watches the agent dir.
  Layer.provide(ModelHealth.layerTest),
  Layer.provide(config)
);

const report = (line) => Effect.sync(() => console.log(line));

const started = Date.now();

const program = Effect.gen(function* () {
  const source = yield* PiModelSource;
  const piConfig = yield* PiConfig;
  yield* report(`boot: pi config, model runtime and Harness ready in ${Date.now() - started} ms`);

  const catalog = yield* source.catalog({ bridgeEnabled: true });
  const available = catalog.models.filter((m) => m.available);
  const byProvider = new Map();
  for (const m of available) byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);
  yield* report(`listing: ${catalog.models.length} models, available by provider: ${[...byProvider].map(([p, n]) => `${p}=${n}`).join(" ")}`);
  const opencode = available.filter((m) => m.provider === "opencode-go");
  const anthropic = catalog.models.filter((m) => m.provider === "anthropic");
  yield* report(`listing: opencode-go ${opencode.length}, anthropic ${anthropic.length}`);

  const statuses = yield* source.providers;
  yield* report(`providers: ${statuses.map((s) => `${s.provider}=${s.state}`).join(" ")}`);
  const codex = statuses.find((s) => s.provider === "openai-codex")?.state ?? "absent";

  const resolveStart = Date.now();
  const snapshot = yield* piConfig.reload;
  yield* report(`skills: ${snapshot.skills.length} resolved in ${Date.now() - resolveStart} ms, ${snapshot.missing.length} packages missing, ${snapshot.errors.length} problems`);

  let turn = "skipped";
  if (process.env.CAIRN_JUDGE_TURN === "1") {
    const wanted = process.env.CAIRN_JUDGE_MODEL;
    // A cheap non-Claude model, so the turn says nothing about Anthropic either way.
    const cheap = (m) => /flash|mini|small|lite|air/i.test(m.modelId) && !/claude/i.test(m.modelId);
    const pick = wanted
      ? available.find((m) => `${m.provider}/${m.modelId}` === wanted)
      : (opencode.find(cheap) ?? opencode[0]);
    if (pick === undefined) {
      turn = "no model";
    } else {
      yield* report(`turn: on ${pick.provider}/${pick.modelId}`);
      const seam = yield* HarnessSeam;
      const boot = yield* HarnessBoot;
      yield* boot.resume;
      const threadId = ThreadId.make(crypto.randomUUID().replace(/^(.{14})./, "$17"));
      const terminal = yield* seam.events.pipe(
        Stream.filter((event) => event._tag === "RunTerminal" && event.threadId === threadId),
        Stream.runHead,
        Effect.forkChild
      );
      yield* Effect.sleep(Duration.millis(50));
      yield* seam.ensureThread({
        threadId,
        projectId: ProjectId.make("prj_pi_readonly_judge"),
        model: { provider: pick.provider, modelId: pick.modelId },
        thinkingLevel: pick.thinkingLevels.includes("minimal") ? "minimal" : (pick.thinkingLevels[0] ?? "off"),
        cwd: process.env.CAIRN_JUDGE_DATA,
        instructions: Option.none(),
      });
      const turnStart = Date.now();
      yield* seam.submit(threadId, {
        requestId: "pi-readonly-judge",
        content: [{ type: "text", text: "Reply with the single word: ready. Do not use any tool." }],
        entry: Option.none(),
        whenBusy: "reject",
      });
      const ended = yield* Fiber.join(terminal).pipe(Effect.timeout(Duration.seconds(120)));
      turn = Option.match(ended, { onNone: () => "no terminal", onSome: (e) => e.status });
      yield* report(`turn: ${turn} in ${Date.now() - turnStart} ms`);
    }
  }

  return { opencode: opencode.length, anthropic: anthropic.length, codex, turn };
});

const result = await Effect.runPromise(
  // One layer, so the brain and the listing share one model runtime.
  Effect.scoped(program.pipe(Effect.provide(Layer.mergeAll(brain, models))))
).catch((error) => {
  console.log(`error: ${error?.message ?? String(error)}`);
  return undefined;
});

console.log(`children: ${spawned.length}${spawned.length > 0 ? ` (${spawned.join(" ")})` : ""}`);
const failures = [];
if (result === undefined) failures.push("the brain did not boot");
else {
  if (result.opencode === 0) failures.push("no opencode-go model listed");
  if (result.anthropic > 0) failures.push("an anthropic model was listed");
  if (process.env.CAIRN_JUDGE_TURN === "1" && result.turn !== "completed") failures.push(`the turn ended ${result.turn}`);
}
if (result !== undefined && result.codex === "ready") failures.push("openai-codex is ready from the pi login, with the Cairn OAuth store empty");
// The OAuth store holds its lock through one `flock` child, by design; anything else fails.
if (spawned.some((name) => name !== "flock")) failures.push("the brain started a child process other than the OAuth lock");
if (spawned.filter((name) => name === "flock").length !== 1) failures.push("the OAuth store did not take its lock");
for (const failure of failures) console.log(`FAIL ${failure}`);
process.exit(failures.length);
'
)
status=$?
set -e

record >"$work/after"

if ! diff -u "$work/before" "$work/after" >"$work/diff"; then
  echo "FAIL the agent dir changed:"
  grep -E '^[-+][^-+]' "$work/diff" | sed 's/^/  /'
  status=$((status + 1))
else
  echo "agent dir: identical before and after ($(wc -l <"$work/after") entries)"
fi

locks=$(grep -c '\.lock\b' "$work/after" || true)
if [[ $locks -gt 0 ]]; then
  echo "FAIL $locks .lock entries in the agent dir"
  status=$((status + 1))
fi

if [[ $status -eq 0 ]]; then
  echo "PASS pi-readonly"
else
  echo "FAIL pi-readonly ($status)"
fi
exit "$status"
