#!/usr/bin/env bash
# Judge: the brain never changes the user's pi setup (plan D11, 2A). Cairn reads ~/.pi/agent
# (settings, skills, packages, auth.json) through pi's own classes, so this proves the fences hold
# against the real directory, not a fixture.
#
#   judges/pi-readonly.sh [--model <provider>/<modelId>] [--no-turn] [--search]
#
# Records every entry under the agent dir (PI_CODING_AGENT_DIR, else ~/.pi/agent) with its type,
# size, mtime and mode, and every other entry under the pi home (the agent dir's parent, ~/.pi),
# then boots the brain's model side in a throwaway data dir: pi's config resolve, the model runtime
# over auth.json, a model listing, a skills resolve (PiConfig.reload), the tools-only pi host over
# the user's allowlisted packages (ADR 0039), and one turn on an API model through pi-durable (the
# brain's Harness and extension set). It then records both again. Passes when:
#
# - the two agent dir records are identical (no entry created, removed, resized, touched or
#   re-moded),
# - the pi home outside the agent dir is identical too, but for `exa-usage.json`: the Exa monthly
#   counter the host shares with the TUI (ADR 0039), which may change only the way pi-web-access
#   changes it (still a `{ month, count }` record, the count never lower within one month),
# - no `.lock` entry exists in the agent dir,
# - the brain process started no child process (no npm, no git, no `!command` key) other than the
#   one `flock` that holds Cairn's OAuth lock (the store is built as the deployed brain's is) and
#   the coding tools' one `git version` at boot,
# - openai-codex is not ready: Cairn's own OAuth store is empty here, and pi's Codex login is
#   never read,
# - the listing has opencode-go models and no anthropic model,
# - the turn completed (unless --no-turn); with --search, the turn asks the model to call the
#   host's `web_search` once, and that call must have committed a result that is not an error.
#
# Prints names, counts, sizes and times only: never a file's contents or a credential (the Exa
# counter's month and count are neither). The turn uses the cheapest-looking available opencode-go
# model unless --model names one; it costs cents. --search adds one real web search on the user's
# search provider (pi-web-access's own config, ~/.pi/web-search.json), a fraction of a cent on Exa.
# A pi TUI writing its own sessions during the run would show as a change; rerun when it is idle.
#
# --control is the broken control for the pi home check, and runs only with PI_CODING_AGENT_DIR on
# a scratch copy (never the real ~/.pi): the brain writes `stray-control.json` beside the agent dir
# and winds the Exa counter back by one (or breaks it), with no turn. It must print the two pi home
# FAIL lines and exit nonzero.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
agent=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
agent=${agent%/}
pihome=$(dirname "$agent")
model=""
turn=1
search=0
control=0

while [[ $# -gt 0 ]]; do
  case $1 in
    --model) model=$2; shift 2 ;;
    --no-turn) turn=0; shift ;;
    --search) search=1; shift ;;
    --control) control=1; turn=0; shift ;;
    *) echo "usage: judges/pi-readonly.sh [--model <provider>/<modelId>] [--no-turn] [--search] [--control]" >&2; exit 2 ;;
  esac
done

# The broken control writes where the brain must not, so it runs only on a scratch pi home.
if [[ $control -eq 1 && ( -z ${PI_CODING_AGENT_DIR:-} || $(realpath -m "$agent") == $(realpath -m "$HOME/.pi/agent") ) ]]; then
  echo "usage: --control writes under the pi home; point PI_CODING_AGENT_DIR at a scratch copy" >&2
  exit 2
fi

[[ $turn -eq 1 || $search -eq 0 ]] || { echo "usage: --search needs the turn (drop --no-turn)" >&2; exit 2; }
[[ -d $agent ]] || { echo "FAIL no agent dir at $agent"; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/cairn-pi-readonly-XXXXXX")
trap 'rm -rf "$work"' EXIT

record() { find "$agent" -printf '%y %s %T@ %m %P\n' | LC_ALL=C sort; }

# Every entry under the pi home but the agent dir (recorded above), by path relative to it.
record_home() { find "$pihome" -mindepth 1 -path "$agent" -prune -o -printf '%y %s %T@ %m %P\n' | LC_ALL=C sort; }

# The Exa counter as `<month> <count>`, `absent` or `malformed`; nothing else is read from it.
exa_usage() {
  local file=$pihome/exa-usage.json
  [[ -e $file ]] || { echo absent; return; }
  node -e '
const fs = require("node:fs");
try {
  const usage = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
  const ok = usage !== null && /^\d{4}-\d{2}$/.test(String(usage.month)) && Number.isInteger(usage.count) && usage.count >= 0;
  console.log(ok ? `${usage.month} ${usage.count}` : "malformed");
} catch {
  console.log("malformed");
}' "$file"
}

record >"$work/before"
record_home >"$work/home-before"
exa_before=$(exa_usage)
echo "agent dir: $agent ($(wc -l <"$work/before") entries)"
echo "pi home: $pihome ($(wc -l <"$work/home-before") entries outside the agent dir; exa-usage.json: $exa_before)"

# The program runs from apps/server so its bare imports resolve there; Cairn's modules load by
# absolute URL, with Node's type stripping.
src="file://$repo/apps/server/src"
set +e
(
  cd "$repo/apps/server"
  CAIRN_JUDGE_SRC=$src CAIRN_JUDGE_DATA=$work/data CAIRN_JUDGE_MODEL=$model CAIRN_JUDGE_TURN=$turn \
    CAIRN_JUDGE_SEARCH=$search CAIRN_JUDGE_CONTROL=$control CAIRN_JUDGE_PI_HOME=$pihome \
    node --input-type=module -e '
import { createRequire, syncBuiltinESMExports } from "node:module";

// Count every child process the brain starts, before anything that could start one loads.
const spawned = [];
const cp = createRequire(process.cwd() + "/")("node:child_process");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = cp[name];
  cp[name] = (command, ...rest) => {
    const base = String(command).split("/").pop();
    // `git version`, asked once at boot by the coding tools (the commit trailer needs git 2.54),
    // reads nothing of the agent dir; it is counted under its own name.
    spawned.push(base === "git" && Array.isArray(rest[0]) && rest[0].at(-1) === "version" && rest[0].filter((arg) => !arg.startsWith("-") && !arg.includes("=")).length === 1 ? "git-version" : base);
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
const { SettingsStore } = await import(`${src}/models/SettingsStore.ts`);
const { ReachServicesTest } = await import(`${src}/reach/ReachLayer.ts`);
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
  Layer.provideMerge(PiHost.layer),
  // The store the health feed records into, in memory: this judge watches the agent dir.
  Layer.provide(ModelHealth.layerTest),
  // The settings the roles tool reads its table from, in memory as well.
  Layer.provide(SettingsStore.layerTest),
  // Artifacts and portals for the reach tools, over a fake porch and in-memory units.
  Layer.provide(ReachServicesTest),
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

  const host = yield* PiHost;
  yield* report(`pi host: ${host.packages.map((loaded) => `${loaded.name}@${loaded.version} (${loaded.tools.length} tools)`).join(", ") || "no packages"}`);

  // The broken control: a brain that writes a stray file under the pi home and winds the Exa
  // counter back, as a careless private copy of the counter would. The judge must fail on both.
  if (process.env.CAIRN_JUDGE_CONTROL === "1") {
    const fs = createRequire(process.cwd() + "/")("node:fs");
    const home = process.env.CAIRN_JUDGE_PI_HOME;
    const exa = `${home}/exa-usage.json`;
    fs.writeFileSync(`${home}/stray-control.json`, "{}\n");
    let usage;
    try {
      usage = JSON.parse(fs.readFileSync(exa, "utf-8"));
    } catch {
      usage = undefined;
    }
    fs.writeFileSync(exa, Number.isInteger(usage?.count) && usage.count > 0
      ? JSON.stringify({ month: usage.month, count: usage.count - 1 })
      : "not json");
    yield* report("control: wrote stray-control.json and wound exa-usage.json back");
  }

  const searching = process.env.CAIRN_JUDGE_SEARCH === "1";
  let searches = [];
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
        runtimeMode: "full-access",
      });
      const turnStart = Date.now();
      yield* seam.submit(threadId, {
        requestId: "pi-readonly-judge",
        content: [{ type: "text", text: searching
          ? "Call the web_search tool exactly once, with the query \"pi coding agent extensions\". Then reply with the single word: ready. Use no other tool."
          : "Reply with the single word: ready. Do not use any tool." }],
        entry: Option.none(),
        whenBusy: "reject",
      });
      const ended = yield* Fiber.join(terminal).pipe(Effect.timeout(Duration.seconds(120)));
      turn = Option.match(ended, { onNone: () => "no terminal", onSome: (e) => e.status });
      yield* report(`turn: ${turn} in ${Date.now() - turnStart} ms`);

      // What the turn committed: the tool, error flag and size of each result, never its text.
      const [frame] = yield* seam.watch(threadId).pipe(Stream.take(1), Stream.runCollect);
      const results = (frame?._tag === "Snapshot" ? frame.view.entries : [])
        .filter((entry) => entry.kind === "pi.tool-result")
        .flatMap((entry) => entry.model ?? []);
      for (const message of results) {
        const size = (message.content ?? []).reduce((sum, part) => sum + (part.text?.length ?? 0), 0);
        yield* report(`tool result: ${message.toolName}${message.isError ? " (error)" : ""}, ${size} characters`);
      }
      searches = results.filter((message) => message.toolName === "web_search");
      const usage = frame?._tag === "Snapshot" ? frame.view.docs["pi.usage"] : undefined;
      if (usage !== undefined) yield* report(`usage: ${JSON.stringify(usage)}`);
    }
  }

  return {
    opencode: opencode.length,
    anthropic: anthropic.length,
    codex,
    turn,
    searches: searches.length,
    searchErrors: searches.filter((message) => message.isError).length,
  };
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
  if (process.env.CAIRN_JUDGE_SEARCH === "1" && result.searches === 0) failures.push("the turn committed no web_search result");
  if (process.env.CAIRN_JUDGE_SEARCH === "1" && result.searchErrors > 0) failures.push(`${result.searchErrors} web_search results were errors`);
}
if (result !== undefined && result.codex === "ready") failures.push("openai-codex is ready from the pi login, with the Cairn OAuth store empty");
// The OAuth store holds its lock through one `flock` child, by design, and the coding tools ask
// `git version` once; anything else fails.
if (spawned.some((name) => name !== "flock" && name !== "git-version")) failures.push("the brain started a child process other than the OAuth lock");
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

# The pi home outside the agent dir: only the shared Exa counter may change, and only as
# pi-web-access changes it.
record_home >"$work/home-after"
exa_after=$(exa_usage)
if ! diff -u "$work/home-before" "$work/home-after" >"$work/home-diff"; then
  strays=$(grep -E '^[-+][^-+]' "$work/home-diff" | grep -vE ' exa-usage\.json$' || true)
  if [[ -n $strays ]]; then
    echo "FAIL the pi home changed outside exa-usage.json:"
    sed 's/^/  /' <<<"$strays"
    status=$((status + 1))
  fi
fi
read -r month_before count_before <<<"$exa_before"
read -r month_after count_after <<<"$exa_after"
if [[ $exa_after == "$exa_before" ]]; then
  echo "pi home: identical before and after ($(wc -l <"$work/home-after") entries; exa-usage.json: $exa_after)"
elif [[ $exa_after == malformed || ($exa_before != absent && $exa_after == absent) ]]; then
  echo "FAIL exa-usage.json went from $exa_before to $exa_after"
  status=$((status + 1))
elif [[ $month_before == "$month_after" && $count_after -lt $count_before ]]; then
  echo "FAIL exa-usage.json's count fell within $month_after ($count_before to $count_after)"
  status=$((status + 1))
elif [[ $exa_before != absent && $month_after < $month_before ]]; then
  echo "FAIL exa-usage.json went back a month ($month_before to $month_after)"
  status=$((status + 1))
else
  echo "pi home: only exa-usage.json changed, $exa_before to $exa_after"
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
