// The judge registry (ADR 0054): one entry per judge under `judges/`, saying what it proves, how it
// runs, what it costs, what it needs and its broken control, so a gap is visible here and not only
// in someone's memory. `judges/index.test.ts` fails when a top-level judge file has no entry or an
// entry names a missing file; `judges/status.ts` prints this table joined with each judge's last
// record (`judges/lib/Record.ts`); `judges/run-set.ts` runs `SET`, which `ops/cairn/deploy.sh`
// requires a passing record of before it deploys a commit.
//
// Paths are relative to `judges/`. A judge's first file is the one that records its runs; a shell
// file after it is a wrapper that runs the first.

import { Option } from "effect";

/** How a judge is run: in `pnpm check`, by the nightly timer, in the pre-deploy set, by a wizard or by hand. */
export type Runs = "check" | "nightly" | "set" | "wizard" | "hand";

/**
 * What a judge needs beyond node and the checkout: system Chromium, the deployed brain, Docker,
 * porch, or a running systemd unit the caller names on its command line (`unit`).
 */
export type Need = "browser" | "live-brain" | "docker" | "porch" | "unit";

/** A real model's spend: which model, and roughly how much a run costs. */
export interface Spend {
  readonly model: string;
  readonly about: string;
}

/** What a run costs: its default, and the flags that change it (a flag that makes a paid judge free, or one that spends). */
export interface Cost {
  readonly default: "free" | Spend;
  readonly switches: ReadonlyArray<{
    readonly flag: string;
    readonly cost: "free" | Spend;
  }>;
}

/** One judge. */
export interface Judge {
  /** The record name: the first file's base name without its extension. */
  readonly name: string;
  readonly files: ReadonlyArray<string>;
  /** The kickoff target or ADR gate it holds. */
  readonly proves: string;
  readonly runs: ReadonlyArray<Runs>;
  readonly cost: Cost;
  readonly needs: ReadonlyArray<Need>;
  /** The broken control that shows it can fail, or `none`. */
  readonly control: string;
}

/** One run of the pre-deploy set: a judge and its arguments. */
export interface SetRun {
  readonly judge: string;
  readonly args: ReadonlyArray<string>;
}

const free: Cost = { default: "free", switches: [] };

const paid = (model: string, about: string): Cost => ({
  default: { model, about },
  switches: [],
});

/** A paid judge that `flag` makes free. */
const freeWith = (flag: string, model: string, about: string): Cost => ({
  default: { model, about },
  switches: [{ flag, cost: "free" }],
});

/** A free judge that `flag` makes spend. */
const paidWith = (flag: string, model: string, about: string): Cost => ({
  default: "free",
  switches: [{ flag, cost: { model, about } }],
});

const HAIKU = "claude-bridge/claude-haiku-5-5";

/** Every judge, by name. */
export const JUDGES: ReadonlyArray<Judge> = [
  // In `pnpm check`.
  {
    name: "brand.test",
    files: ["brand.test.ts"],
    proves:
      "No t3code brand (names, storage keys, CSS names, git refs) ships in the apps or packages (plan D24).",
    runs: ["check"],
    cost: free,
    needs: [],
    control:
      "none (the known-leftovers list must match the scan exactly, so a fixed leftover fails too)",
  },
  {
    name: "contrast.test",
    files: ["contrast.test.ts"],
    proves:
      "Every design token text pair meets WCAG AA in both themes, and the view code uses no colour but the tokens (ADR 0040).",
    runs: ["check"],
    cost: free,
    needs: [],
    control: "a planted 40 percent ink must fail",
  },
  {
    name: "headers.test",
    files: ["headers.test.ts"],
    proves:
      "A port starts with its source header and the MIT notice, ended by a blank line (S65, T57).",
    runs: ["check"],
    cost: free,
    needs: [],
    control: "none",
  },
  {
    name: "index.test",
    files: ["index.test.ts"],
    proves:
      "Every top-level judge file has an entry in this registry, and every entry's files exist (ADR 0054).",
    runs: ["check"],
    cost: free,
    needs: [],
    control: "none",
  },
  {
    name: "judge-model.test",
    files: ["judge-model.test.ts"],
    proves:
      "The judge brain's scripted model runs a script line anywhere in a message and resolves `$subagent`, as the kill judges need.",
    runs: ["check"],
    cost: free,
    needs: [],
    control: "none",
  },
  {
    name: "lint-boundaries.test",
    files: ["lint-boundaries.test.ts"],
    proves:
      "The library boundaries in oxlint.config.ts refuse the imports S42 and ADR 0002 forbid.",
    runs: ["check"],
    cost: free,
    needs: [],
    control: "a probe in each zone that must be refused",
  },
  {
    name: "lint-rules.test",
    files: ["lint-rules.test.ts"],
    proves:
      "The vendored anti-slop rules and Cairn's automation rules fire on what they forbid and nothing else (T63).",
    runs: ["check"],
    cost: free,
    needs: [],
    control: "one probe each rule must flag",
  },
  {
    name: "look.test",
    files: ["look.test.ts"],
    proves:
      "The frozen-round comparison works, and today's tokens.css matches the newest frozen look round (ADR 0040).",
    runs: ["check"],
    cost: free,
    needs: [],
    control: "a token, one cell or a size changed in a fixture round must fail",
  },
  {
    name: "models.test",
    files: ["models.test.ts"],
    proves:
      "J-models (ADR 0043): a child runs on the model it names or on its parent's, and an unknown model is refused.",
    runs: ["check"],
    cost: free,
    needs: [],
    control: "a harness that drops the parent's level",
  },
  {
    name: "phone-report.test",
    files: ["phone-report.test.ts"],
    proves:
      "The wizard's phone verdicts on log lines in the brain's own format, DERP runs excluded.",
    runs: ["check"],
    cost: free,
    needs: [],
    control: "a log that must fail the verdict",
  },
  {
    name: "thread-state-rows.test",
    files: ["thread-state-rows.test.ts"],
    proves:
      "Every row of docs/golden/thread-states.md has a case, and `threadState` puts each thread where the doc says.",
    runs: ["check"],
    cost: free,
    needs: [],
    control: "a doc whose category disagrees must fail",
  },
  {
    name: "thread-states.test",
    files: ["thread-states.test.ts"],
    proves:
      "Every status the protocol defines has a row in the thread-states doc and its label map.",
    runs: ["check"],
    cost: free,
    needs: [],
    control: "none",
  },
  {
    name: "typed-results.test",
    files: ["typed-results.test.ts"],
    proves:
      "J-typed's verdict counts attempts and reads the dispatched model alike with the tool.",
    runs: ["check"],
    cost: free,
    needs: [],
    control: "each failing transcript names the one thing that fails it",
  },

  // Kill judges and other brains on scratch stores.
  {
    name: "artifacts-kill",
    files: ["artifacts-kill.ts"],
    proves:
      "Artifact publishing on the real porch survives kill -9 in every crash window of its steps (ADR 0038, kill coverage).",
    runs: ["hand"],
    cost: free,
    needs: ["porch"],
    control: "none",
  },
  {
    name: "brief-go",
    files: ["brief-go.ts", "brief-go.sh"],
    proves:
      "ADR 0030's gate: Go is the commit that starts the child, under kill -9 before, inside and after it.",
    runs: ["set", "hand"],
    cost: free,
    needs: [],
    control: "an answer that commits Go without its start",
  },
  {
    name: "budget-kill",
    files: ["budget-kill.ts"],
    proves:
      "J-budget under kill -9 (ADR 0036): a stop budget holds within one response per running child, and a raise lets work start again.",
    runs: ["set", "hand"],
    cost: free,
    needs: [],
    control:
      "no-stop (a guard that stops nothing) and no-boot (no boot repair) cases",
  },
  {
    name: "codex-login",
    files: ["codex-login.ts"],
    proves:
      "J-codex (ADR 0037): Codex sign-in and refresh-token rotation survive kill -9 with no token reused.",
    runs: ["set", "hand"],
    cost: free,
    needs: [],
    control: "a store that never persists a refresh",
  },
  {
    name: "durability",
    files: ["durability.ts"],
    proves:
      "The kickoff's Durability target: kill -9 and restarts at every window of a turn lose nothing, and every client converges.",
    runs: ["nightly", "set", "hand"],
    cost: paidWith(
      "--bridge",
      HAIKU,
      "a few cents of plan usage for the bridge windows"
    ),
    needs: ["browser"],
    control: "--sabotage skip-snapshot and --sabotage page-text",
  },
  {
    name: "events-kill",
    files: ["events-kill.ts", "events-kill.sh"],
    proves:
      "ADR 0033's gate: every durable event is handled exactly once by each reactor under kill -9 and log rotation.",
    runs: ["set", "hand"],
    cost: free,
    needs: [],
    control: "reactors that keep their cursor in memory",
  },
  {
    name: "goal-kill",
    files: ["goal-kill.ts"],
    proves:
      "One goal_check yields one judge run, one verdict and one note however the brain dies (briefs note, criteria and verdicts).",
    runs: ["set", "hand"],
    cost: free,
    needs: [],
    control: "a verdict committed apart from the run's end",
  },
  {
    name: "pi-host",
    files: ["pi-host.ts"],
    proves:
      "ADR 0039: a tools-only pi tool's durable run under kill -9, on the user's real pi packages (read only).",
    runs: ["set", "hand"],
    cost: free,
    needs: [],
    control: "a host whose replay table forgets `counter_safe`",
  },
  {
    name: "reach-restart",
    files: ["reach-restart.ts", "reach-restart.sh"],
    proves:
      "ADR 0038's gate: a portal answers through a kill -9 and a SIGTERM of the brain, and the kill matrix leaves nothing behind.",
    runs: ["hand"],
    cost: free,
    needs: ["docker", "porch"],
    control: "servers inside the brain's cgroup (`--inline`)",
  },
  {
    name: "shell-resume",
    files: ["shell-resume.ts"],
    proves:
      "A client resubscribing after random connection cuts holds the database's snapshot within 2 s. On the scripted brain (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: [],
    control: "none",
  },
  {
    name: "shutdown",
    files: ["shutdown.sh"],
    proves:
      "ADR 0022: a clean restart closes the brain in under 5 s and is not a crash, and a stubborn tool is cut off.",
    runs: ["set", "hand"],
    cost: paidWith(
      "--unit",
      "opencode-go (the deployed brain's cheap model)",
      "cents; restarts the deployed brain"
    ),
    needs: [],
    control: "`stubborn` ignores its signal under TimeoutStopSec=3",
  },
  {
    name: "spend-kill",
    files: ["spend-kill.ts", "spend-kill.sh"],
    proves:
      "J-spend under kill -9 (ADR 0036): the spend ledger equals the store, with nothing counted twice and unpriced tokens never $0.",
    runs: ["set", "hand"],
    cost: free,
    needs: [],
    control: "a ledger that adds what it reads and catches up by adding again",
  },
  {
    name: "subagent-durability",
    files: ["subagent-durability.ts"],
    proves:
      "ADR 0028: a subagent's delivery survives kill -9 at every crash point, each input and answer once.",
    runs: ["set", "hand"],
    cost: paidWith("--bridge", HAIKU, "a few cents of plan usage"),
    needs: [],
    control: "the control-* cases (a reporter that mints fresh request ids)",
  },
  {
    name: "wire-budget",
    files: ["wire-budget.ts"],
    proves:
      "ADR 0020: a cold client opens a 2,000-entry thread in one snapshot under 200,000 bytes, p95 under 1,000 ms modelled.",
    runs: ["set", "hand"],
    cost: free,
    needs: [],
    control: "none",
  },
  {
    name: "workflow-budget",
    files: ["workflow-budget.ts"],
    proves:
      "ADR 0036 for workflows: a budget line stops a fan-out under kill -9, admitting nothing past it.",
    runs: ["set", "hand"],
    cost: free,
    needs: [],
    control: "control-no-admission and control-no-stopper",
  },
  {
    name: "workflow-kill",
    files: ["workflow-kill.ts", "workflow-kill.sh"],
    proves:
      "Workflows note judges 1 and 2 (ADR 0012 as amended): every node is dispatched once under kill -9, and a parked run finishes.",
    runs: ["set", "hand"],
    cost: free,
    needs: [],
    control: "a dispatch that ignores its row, and watchers left parked",
  },
  {
    name: "approval-kill",
    files: ["approval-kill.ts"],
    proves:
      "ADR 0046's gate (ADR 0013's S4 on pi-durable 1.5): an approval pending across six kill -9s is still answerable, and its call runs once.",
    runs: ["set", "hand"],
    cost: free,
    needs: [],
    control: "control (the brain opened with pi-durable's own restart limit)",
  },
  {
    name: "workflow-stop",
    files: ["workflow-stop.ts", "workflow-stop.sh"],
    proves:
      "Workflows note judge 2: a stopped node is null to the script and its work never finishes, across kills.",
    runs: ["set", "hand"],
    cost: free,
    needs: [],
    control: "control-deaf (node tools deaf to the stop)",
  },

  // Browser judges over in-process brains on the scripted harness.
  {
    name: "behaviour",
    files: ["behaviour.ts"],
    proves:
      "What a screenshot cannot show: the composer footer folds the least that fits, against t3code's readings (plan 4F, ADR 0040). On the scripted brain (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "--broken footer-measure",
  },
  {
    name: "dev-smoke",
    files: ["dev-smoke.ts"],
    proves:
      "`pnpm dev` goes Live, lists the demo thread and streams its transcript. The dev default is the scripted brain (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "none",
  },
  {
    name: "goal-chip",
    files: ["goal-chip.ts"],
    proves:
      "The goal chip and panel show the brain's verdicts at 390 and 1,440 px (ADR 0026, briefs note B6). On the scripted brain: the judge writes verdicts through the verdict writer, no pi-durable judge run does (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "--broken mark|count|state",
  },
  {
    name: "load",
    files: ["load.ts"],
    proves:
      "The kickoff's Load target: cold loads p50 under 1,000 ms and p95 under 1,500 ms on LAN and 4G, at most 6 requests (the default URL is the deployed brain; --local runs its own).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "five loads with index.html held 1,500 ms must miss the p50",
  },
  {
    name: "look",
    files: ["look.ts"],
    proves:
      "`check`: today's client matches the newest frozen look round; `capture` and `round` hold each named state to the look rules (ADR 0040). On the scripted brain over seeded documents (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control:
      "planted violations on the thread state, and an overridden --ink-1 that must drift",
  },
  {
    name: "look-rules",
    files: ["look-rules.ts"],
    proves:
      "The look rules (touch, overflow, focus, hscroll, tone, sheet) on every look catalogue primitive (ADR 0040).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "one planted violation per rule must fail at its element",
  },
  {
    name: "meters",
    files: ["meters.ts"],
    proves:
      "The usage page shows the seeded spend, budgets and plan windows, and nothing unknown as zero (surfaces S9, models M10). On the scripted brain over seeded documents, without pi-durable's spend feed or budget halts (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "--broken zero",
  },
  {
    name: "paste-client",
    files: ["paste-client.ts"],
    proves:
      "Paste, drop and send in the real client at 390 px: one chip and one upload per file, and a send waits for the upload. On the scripted brain (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "none",
  },
  {
    name: "reconnect",
    files: ["reconnect.ts"],
    proves:
      "The kickoff's Durability target, client side: the page converges within 2 s after its brain is killed and restarted. On the dev brain's scripted default (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "none",
  },
  {
    name: "rollup",
    files: ["rollup.ts"],
    proves:
      "ADR 0027's gate in the page: a child's approval lights its ancestors, and a question goes to the parent's model first. On the scripted brain, whose subagent delivery the conformance suite judges; pi-durable's subagent tasks and repairs are not in it (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "--broken banner|lit",
  },
  {
    name: "rows-subagent",
    files: ["rows-subagent.ts"],
    proves:
      "Subagent rows (surfaces S4): each row's state comes from its child's own shell row, and the way back works. On the scripted brain, without pi-durable's subagent tasks and repairs (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "--broken state|back",
  },
  {
    name: "subagent-flows",
    files: ["subagent-flows.ts"],
    proves:
      "Steer, stop and escalated-question flows from the UI, judged on the page and on the brain (ADR 0027, ADR 0028). On the scripted brain, without pi-durable's subagent tasks and repairs (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "--broken steer|stop|card",
  },
  {
    name: "surfaces",
    files: ["surfaces.ts"],
    proves:
      "The request card and the brief card: one answer per request, a reload keeps it, two devices settle it once. On the scripted brain (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "--broken slot|double|advance|undo|nocheck|typing",
  },
  {
    name: "transcript-scroll",
    files: ["transcript-scroll.ts"],
    proves:
      "ADR 0041: the transcript follows, holds the reader's row and never jumps, on a 2,100-row thread.",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "--broken estimate|reflow|bookmark|anchor|extend|wheel",
  },
  {
    name: "typing",
    files: ["typing.ts"],
    proves:
      "ADR 0023's gate (the kickoff's Composer target): no key dropped or reordered while a long thread streams, IME and menus intact. On the scripted brain (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "none",
  },
  {
    name: "workflow-surfaces",
    files: ["workflow-surfaces.ts"],
    proves:
      "The workflow launch approval and steps panel (ADR 0032): numbers first, one answer per control, Stop reaches the brain. On the scripted brain over a hand-written ledger: no workflow runs (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "--broken double|sample|stop",
  },
  {
    name: "work-panel",
    files: ["work-panel.ts"],
    proves:
      "The work panel (surfaces S5, S7): Stop ends one child alone, and the steps follow the child. On the scripted brain, without pi-durable's subagent tasks and repairs (ADR 0024).",
    runs: ["set", "hand"],
    cost: free,
    needs: ["browser"],
    control: "--broken stop|state|move|count",
  },

  // Read-only checks of the user's setup and the push path.
  {
    name: "paste",
    files: ["paste.ts"],
    proves:
      "The kickoff's Paste target: a pasted screenshot reaches the model as the same image, paste to ready p95 under 1,500 ms; --page is the wizard's phone stage.",
    runs: ["set", "wizard", "hand"],
    cost: freeWith(
      "--skip-real",
      `${HAIKU} and an opencode-go model that takes images`,
      "cents"
    ),
    needs: ["browser"],
    control: "none",
  },
  {
    name: "pi-readonly",
    files: ["pi-readonly.sh"],
    proves:
      "The brain never changes the user's pi setup (plan D11): the agent dir and pi home are identical before and after.",
    runs: ["set", "hand"],
    cost: freeWith(
      "--no-turn",
      "an opencode-go model",
      "one turn, under a cent"
    ),
    needs: [],
    control: "--control on a scratch pi home",
  },
  {
    name: "push",
    files: ["push.ts"],
    proves:
      "Push end to end: --pwa registers the worker, --fake pushes approvals once with their words, --send reaches the phone (the wizard). --fake runs on the scripted brain (ADR 0024).",
    runs: ["set", "wizard", "hand"],
    cost: free,
    needs: ["browser"],
    control: "none",
  },
  {
    name: "skills",
    files: ["skills.ts"],
    proves:
      "Plan 3E: Cairn's skills section equals pi's own loader, renders stably, and the owner's pi setup is unchanged.",
    runs: ["set", "hand"],
    cost: freeWith(
      "--no-model",
      "an opencode-go model",
      "one call, under a cent"
    ),
    needs: [],
    control: "none",
  },

  // Docker, porch and the live route.
  {
    name: "caddy-reload",
    files: ["caddy-reload.ts"],
    proves:
      "An open WebSocket survives a Caddy reload when the proxy sets stream_close_delay (ADR 0038, reach R2).",
    runs: ["wizard", "hand"],
    cost: free,
    needs: ["docker"],
    control: "a Caddy without stream_close_delay must cut the connection",
  },
  {
    name: "gate",
    files: ["gate.sh"],
    proves:
      "The sign-in gate (ADR 0008 as amended): only the owner's untagged devices are admitted, by the live route and the brain.",
    runs: ["hand"],
    cost: free,
    needs: ["live-brain"],
    control:
      "node rows judged against a made-up owner must disagree; --control-port for a second brain",
  },
  {
    name: "owner-guard",
    files: ["owner-guard.ts"],
    proves:
      "The wizard's owner-only guard refuses every artifacts and portal host in any letter case (ADR 0038).",
    runs: ["wizard", "hand"],
    cost: free,
    needs: ["docker"],
    control: "an unguarded and a case-sensitive guard",
  },
  {
    name: "porch-contract",
    files: ["porch-contract.ts"],
    proves:
      "The porch contract on the real binary matches the fake layer's scenarios (ADR 0038, reach R3).",
    runs: ["hand"],
    cost: free,
    needs: ["docker", "porch"],
    control: "the same publish straight through porch overwrites a page",
  },
  {
    name: "reach",
    files: ["reach.ts"],
    proves:
      "ADR 0038's artifact half: every artifact scenario on the real porch, served owner-only through Caddy.",
    runs: ["hand"],
    cost: free,
    needs: ["docker", "porch"],
    control: "porch alone overwrites a hand-written page",
  },
  {
    name: "relay-orphans",
    files: ["relay-orphans.sh"],
    proves:
      "Gate S5 (ADR 0014): no stdio relay process outlives the event that should end it.",
    runs: ["hand"],
    cost: free,
    needs: ["unit"],
    control: "none",
  },

  // The deployed brain, and real models.
  {
    name: "claude-eligibility",
    files: ["claude-eligibility.ts"],
    proves:
      "J6 and J7: the usage probe reads the plan's windows, and a turn with Cairn's sections is not refused as a third-party app.",
    runs: ["hand"],
    cost: paid(HAIKU, "a fraction of a cent of plan usage"),
    needs: [],
    control: "a probe that skips the bridge's env stripping",
  },
  {
    name: "claude-kill",
    files: ["claude-kill.sh"],
    proves:
      "J2 and J9 on the bridge: kill -9 while a Claude reply streams, a tool is held, or the answer is written.",
    runs: ["hand"],
    cost: paid(HAIKU, "a few cents of plan usage"),
    needs: [],
    control: "none",
  },
  {
    name: "claude-live",
    files: ["claude-live.ts"],
    proves:
      "J4 and J5 live: a large tool list is loaded, a real paste, and compaction, switch and deletion keep the context.",
    runs: ["hand"],
    cost: paid(HAIKU, "cents of plan usage"),
    needs: [],
    control: "none",
  },
  {
    name: "claude-reminder",
    files: ["claude-reminder.ts"],
    proves:
      "J11: a changed section reaches a running Claude session as one system-reminder at a small cache write, across a restart.",
    runs: ["hand"],
    cost: paid(HAIKU, "a few cents of plan usage"),
    needs: [],
    control: "none",
  },
  {
    name: "claude-ttft",
    files: ["claude-ttft.ts"],
    proves:
      "J13: time to the first token through the bridge against the Agent SDK alone (records, does not gate).",
    runs: ["hand"],
    cost: paid(
      "claude-haiku-5-5, claude-sonnet-5-5 and claude-opus-5-5 on the bridge",
      "a little plan usage per turn"
    ),
    needs: [],
    control: "none",
  },
  {
    name: "codex-signin",
    files: ["codex-signin.ts"],
    proves:
      "The deployed brain's Codex sign-in ends SignedIn and offers the Codex model (ADR 0037).",
    runs: ["wizard", "hand"],
    cost: free,
    needs: ["live-brain"],
    control: "none",
  },
  {
    name: "council-typed",
    files: ["council-typed.ts"],
    proves:
      "Workflows note judge 9: the council recipe's typed nodes on two real providers; --kill-in-pass-2 is judge 6's kill.",
    runs: ["hand"],
    cost: paid(`${HAIKU} and opencode-go models`, "cents"),
    needs: [],
    control: "none",
  },
  {
    name: "deployed-unit",
    files: ["deployed-unit.ts"],
    proves:
      "ADR 0022's gate on the real cairn.service: restarts, a kill while a reply streams, and the login PATH.",
    runs: ["hand"],
    cost: paid(
      `opencode-go and ${HAIKU}`,
      "cents per turn; `path` is free; restarts the deployed brain"
    ),
    needs: ["live-brain"],
    control: "none",
  },
  {
    name: "goal-judge",
    files: ["goal-judge.ts"],
    proves:
      "A goal's model judge on a real model says MET and NOT MET rightly, and a bridge judge is refused (ADR 0043).",
    runs: ["hand"],
    cost: paid("a cheap opencode-go model", "under a cent"),
    needs: [],
    control: "none",
  },
  {
    name: "live-chat",
    files: ["live-chat.ts"],
    proves:
      "The deployed brain chats through Caddy on an API model, from this machine's tailnet node.",
    runs: ["hand"],
    cost: paid("an opencode-go model", "cents"),
    needs: ["live-brain"],
    control: "none",
  },
  {
    name: "phone-report",
    files: ["phone-report.ts"],
    proves:
      "The wizard's phone verdicts: three cold loads under 1,000 ms and paste to model under 2,000 ms on the phone.",
    runs: ["wizard"],
    cost: free,
    needs: ["live-brain"],
    control: "none",
  },
  {
    name: "tools",
    files: ["tools.ts"],
    proves:
      "The kickoff's Tools target: the deployed brain's model reaches Executor's apps from a code mode script.",
    runs: ["hand"],
    cost: paid("an opencode-go model", "a few cents"),
    needs: ["live-brain"],
    control: "none",
  },
  {
    name: "typed-results",
    files: ["typed-results.ts"],
    proves:
      "The kickoff's Typed results target: a schema-valid result within two attempts on real models across providers.",
    runs: ["hand"],
    cost: paid(`opencode-go models and ${HAIKU}`, "cents per model"),
    needs: [],
    control: "--control v1,union",
  },

  // The nightly and the set.
  {
    name: "nightly",
    files: ["fixtures/durability/nightly.sh"],
    proves:
      "The durability matrix every night on the deployed commit: faux and bridge windows three times, both controls, J14's held approval.",
    runs: ["nightly"],
    cost: freeWith("--no-bridge", HAIKU, "a few cents of plan usage"),
    needs: ["browser"],
    control: "--sabotage skip-snapshot and page-text must fail every window",
  },
  {
    name: "run-set",
    files: ["run-set.ts"],
    proves:
      "The pre-deploy set passed on a clean commit, which ops/cairn/deploy.sh requires (ADR 0054).",
    runs: ["hand"],
    cost: free,
    needs: ["browser"],
    control: "none",
  },
];

/**
 * Files at the top of `judges/` that judge nothing: the registry itself and the status printer.
 * `index.test.ts` checks these are the only ones without an entry.
 */
export const TOOLS: ReadonlyArray<string> = ["index.ts", "status.ts"];

/**
 * The pre-deploy set, in the order `run-set.ts` runs it: every free judge that needs no model, no
 * deployed brain, no Docker, no porch and no unit named on its command line, read-only checks
 * first, then the kill judges, then the browser judges, then the systemd ones.
 */
export const SET: ReadonlyArray<SetRun> = [
  { judge: "skills", args: ["--no-model"] },
  { judge: "pi-readonly", args: ["--no-turn"] },
  { judge: "events-kill", args: [] },
  { judge: "spend-kill", args: [] },
  { judge: "budget-kill", args: [] },
  { judge: "goal-kill", args: [] },
  { judge: "brief-go", args: [] },
  { judge: "approval-kill", args: [] },
  { judge: "workflow-kill", args: [] },
  { judge: "workflow-stop", args: [] },
  { judge: "workflow-budget", args: [] },
  { judge: "codex-login", args: [] },
  { judge: "pi-host", args: [] },
  { judge: "shell-resume", args: [] },
  { judge: "wire-budget", args: [] },
  { judge: "subagent-durability", args: [] },
  { judge: "typing", args: [] },
  { judge: "behaviour", args: ["--strict"] },
  { judge: "surfaces", args: [] },
  { judge: "rollup", args: [] },
  { judge: "rows-subagent", args: [] },
  { judge: "work-panel", args: [] },
  { judge: "meters", args: [] },
  { judge: "goal-chip", args: [] },
  { judge: "workflow-surfaces", args: [] },
  { judge: "subagent-flows", args: [] },
  { judge: "transcript-scroll", args: [] },
  { judge: "look-rules", args: [] },
  { judge: "look", args: ["check"] },
  { judge: "paste-client", args: [] },
  { judge: "paste", args: ["--skip-real"] },
  { judge: "load", args: ["--local"] },
  { judge: "push", args: ["--pwa"] },
  { judge: "push", args: ["--fake"] },
  { judge: "dev-smoke", args: [] },
  { judge: "reconnect", args: [] },
  { judge: "durability", args: [] },
  { judge: "shutdown", args: [] },
];

/** The judge named `name`, if the registry has one. */
export const judgeNamed = (name: string) =>
  Option.fromUndefinedOr(JUDGES.find((judge) => judge.name === name));

/** The judge one of whose files is `file` (relative to `judges/`), if the registry has one. */
export const judgeOfFile = (file: string) =>
  Option.fromUndefinedOr(JUDGES.find((judge) => judge.files.includes(file)));

/** What a run with `args` costs: the first switch among the arguments, else the default. */
export const costOf = (judge: Judge, args: ReadonlyArray<string>) =>
  judge.cost.switches.find((change) => args.includes(change.flag))?.cost ??
  judge.cost.default;

/** A cost as one line: `free`, or the model and roughly how much. */
export const describeCost = (cost: "free" | Spend) =>
  cost === "free" ? "free" : `${cost.model}, ${cost.about}`;
