// J6 and J7, live, against the `claude` binary's own login on this machine.
//   node judges/claude-eligibility.ts [--part all|probe|eligibility] [--model claude-haiku-5-5]
//
// J6 (probe): the usage probe reads the plan's windows within 1 s with the subscription type; with
// ANTHROPIC_API_KEY set in the brain's environment the probe child still reports
// `apiKeySource: "none"` (the bridge strips it); with HOME pointing at an empty directory it reports
// not logged in. The probe sends no prompt and costs nothing.
//
// J7 (eligibility): one turn through the real bridge whose instructions are Cairn's sections as they
// stand (a Cairn section, every skill the user's agent directories hold in pi's skills format, and
// this repo's project context), checked by `assertSendablePrompt` first; the turn must succeed with
// no "Third-party apps" rejection, and every `rate_limit_event` it reports must have
// `isUsingOverage !== true`. Costs a fraction of a cent of plan usage on Haiku.
//
// Prints one JSON log line with the numbers. Exit 0 when every check holds. Never prints a credential:
// the dummy API key below is not a key, and the probe's account is reduced to its login kind.
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { Claude } from "@cairn/bridge/Claude";
import { ClaudeAccount } from "@cairn/bridge/ClaudeAccount";
import type { RateLimitInfo } from "@cairn/bridge/ClaudeEvents";
import { childEnv, unsendableFindings } from "@cairn/bridge/ClaudeGuards";
import { claudeModel, DEFAULT_LONG_CONTEXT } from "@cairn/bridge/ClaudeModels";
import { providerContext } from "@cairn/bridge/ClaudeProvider";
import { ClaudeSdk } from "@cairn/bridge/ClaudeSdk";
import { ClaudeSettings } from "@cairn/bridge/ClaudeSettings";
import { ClaudeSlots } from "@cairn/bridge/ClaudeSlots";
import { ClaudeSummary } from "@cairn/bridge/ClaudeSummary";
import { readProbe } from "@cairn/bridge/ClaudeUsage";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { NodeRuntime } from "@effect/platform-node";
import {
  Clock,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";

const { values } = parseArgs({
  options: {
    part: { type: "string", default: "all" },
    model: { type: "string", default: "claude-haiku-5-5" },
  },
});

/** A check of the judge did not hold. */
class ClaudeEligibilityFailed extends Schema.TaggedError<ClaudeEligibilityFailed>()(
  "ClaudeEligibilityFailed",
  { message: Schema.String }
) {}

const scratch = (prefix: string) =>
  realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));

const PROBE_BUDGET_MS = 1000;

/** Not a key: a string with an API key's prefix, so a leak would show as `apiKeySource` other than none. */
const DUMMY_API_KEY = "sk-ant-api03-cairn-judge-not-a-key";

// --- J6: the probe ---

/** One probe; `strip` false is the negative control that skips the bridge's env stripping. */
const probeOnce = (
  env: Readonly<Record<string, string | undefined>>,
  strip = true
) =>
  Effect.gen(function* () {
    const sdk = yield* ClaudeSdk;
    const started = yield* Clock.currentTimeMillis;

    const unstripped = Object.fromEntries(
      Object.entries(env).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, value] as const]
      )
    );

    const raw = yield* sdk
      .probe({
        cwd: scratch("cairn-claude-probe-"),
        env: strip ? childEnv(env, false) : unstripped,
        executable: Option.none(),
      })
      .pipe(Effect.timeout("10 seconds"));

    const ended = yield* Clock.currentTimeMillis;

    return { ms: ended - started, reading: readProbe(raw, ended) };
  });

const probePart = Effect.gen(function* () {
  const normal = yield* probeOnce(process.env);

  const keyEnv = { ...process.env, ANTHROPIC_API_KEY: DUMMY_API_KEY };
  const withKey = yield* probeOnce(keyEnv);

  // The control: the same key passed through unstripped must show up as the account's key source,
  // so an account that reports none (or no source) proves the stripping, not a silent field.
  const control = yield* probeOnce(keyEnv, false);

  const emptyHome = scratch("cairn-claude-empty-home-");

  const loggedOut = yield* probeOnce({
    ...process.env,
    HOME: emptyHome,
    XDG_CONFIG_HOME: path.join(emptyHome, ".config"),
  });

  const ids = new Set(normal.reading.windows.map((window) => window.id));

  const checks = {
    windowsWithinBudget: normal.ms < PROBE_BUDGET_MS,
    fiveHourAndWeekly: ids.has("five_hour") && ids.has("seven_day"),
    subscriptionType: Option.isSome(normal.reading.plan),
    loggedIn: normal.reading.login.kind === "firstParty",
    apiKeyStripped:
      withKey.reading.login.kind === "firstParty" &&
      Option.getOrElse(withKey.reading.apiKeySource, () => "none") === "none",
    controlSeesTheKey: Option.exists(
      control.reading.apiKeySource,
      (source) => source !== "none"
    ),
    emptyHomeNotLoggedIn: loggedOut.reading.login.kind === "none",
  };

  const numbers = {
    probeMs: {
      normal: normal.ms,
      withKey: withKey.ms,
      control: control.ms,
      emptyHome: loggedOut.ms,
    },
    windows: normal.reading.windows.map(
      (window) => `${window.id}=${Math.round(window.usedPercent)}%`
    ),
    plan: Option.getOrElse(normal.reading.plan, () => "none"),
    apiKeySourceWithKey: Option.getOrElse(
      withKey.reading.apiKeySource,
      () => "unreported"
    ),
    apiKeySourceControl: Option.getOrElse(
      control.reading.apiKeySource,
      () => "unreported"
    ),
    emptyHome: {
      login: loggedOut.reading.login.kind,
      state: loggedOut.reading.state,
      reason: Option.getOrElse(loggedOut.reading.reason, () => ""),
    },
  };

  return { checks, numbers };
}).pipe(Effect.provide(ClaudeSdk.layer));

// --- J7: eligibility ---

const SKILL_DIRS = [
  path.join(homedir(), ".agents", "skills"),
  path.join(homedir(), ".pi", "agent", "skills"),
  path.join(homedir(), ".claude", "skills"),
];

interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly location: string;
}

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** A skill's name and description from its SKILL.md frontmatter (single-line or folded values). */
const readSkill = (file: string): Option.Option<SkillEntry> => {
  const text = readFileSync(file, "utf-8");
  const match = /^---\n(?<front>[\s\S]*?)\n---/u.exec(text);

  if (match === null) {
    return Option.none();
  }

  const lines = (match.groups?.front ?? "").split("\n");

  const field = (key: string): Option.Option<string> => {
    const index = lines.findIndex((line) => line.startsWith(`${key}:`));

    if (index === -1) {
      return Option.none();
    }

    const inline = (lines[index] ?? "").slice(key.length + 1).trim();

    if (inline !== "" && inline !== ">" && inline !== "|" && inline !== ">-") {
      return Option.some(inline.replaceAll(/^["']|["']$/gu, ""));
    }

    const folded: Array<string> = [];

    for (const line of lines.slice(index + 1)) {
      if (!/^\s+\S/u.test(line)) {
        break;
      }

      folded.push(line.trim());
    }

    return folded.length > 0 ? Option.some(folded.join(" ")) : Option.none();
  };

  return Option.all({
    name: field("name"),
    description: field("description"),
  }).pipe(
    Option.map(({ name, description }) => ({
      name,
      description,
      location: file,
    }))
  );
};

/** Every skill in the user's agent directories, once per name, read-only. */
const userSkills = (): ReadonlyArray<SkillEntry> => {
  const byName = new Map<string, SkillEntry>();

  for (const dir of SKILL_DIRS) {
    const entries = Option.getOrElse(
      Option.liftThrowable(() => readdirSync(dir))(),
      (): ReadonlyArray<string> => []
    );

    for (const entry of entries) {
      const skill = Option.flatMap(
        Option.liftThrowable(() => path.join(dir, entry, "SKILL.md"))(),
        (file) => Option.flatten(Option.liftThrowable(() => readSkill(file))())
      );

      for (const found of Option.toArray(skill)) {
        if (!byName.has(found.name)) {
          byName.set(found.name, found);
        }
      }
    }
  }

  return [...byName.values()];
};

/** The skills section in pi's own format (pi-coding-agent `formatSkillsForPrompt`, read not imported). */
const skillsSection = (skills: ReadonlyArray<SkillEntry>) =>
  [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
    ...skills.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.location)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");

const repoRoot = path.resolve(import.meta.dirname, "..");

const contextSection = () => {
  const file = path.join(repoRoot, "CLAUDE.md");

  return `# Project Context\n\nProject-specific instructions and guidelines:\n\n## ${file}\n\n${readFileSync(file, "utf-8")}`;
};

const CAIRN_SECTION = [
  "<cairn>",
  "You are working in Cairn, the user's own agent control plane. The thread runs in a scratch directory.",
  "Answer briefly. Do not call tools in this turn.",
  "</cairn>",
].join("\n");

const eligibilityPart = Effect.gen(function* () {
  const model = yield* Effect.fromOption(
    claudeModel(values.model, DEFAULT_LONG_CONTEXT)
  ).pipe(
    Effect.mapError(
      () =>
        new ClaudeEligibilityFailed({
          message: `No bridge model ${values.model} in pi-ai's catalog.`,
        })
    )
  );

  const skills = userSkills();

  const system: Message = {
    role: "system",
    content: "",
    sections: {
      cairn: CAIRN_SECTION,
      context: contextSection(),
      skills: skillsSection(skills),
    },
    timestamp: 1,
  };

  const instructions = [
    CAIRN_SECTION,
    contextSection(),
    skillsSection(skills),
  ].join("\n\n");

  const findings = unsendableFindings(instructions);
  const cwd = scratch("cairn-claude-eligibility-");
  const sessionId = crypto.randomUUID();

  const { reply, readings } = yield* Effect.gen(function* () {
    const claude = yield* Claude;
    const seen = yield* Ref.make<ReadonlyArray<RateLimitInfo>>([]);

    yield* Effect.forkScoped(
      Stream.runForEach(claude.rateLimits, (info) =>
        Ref.update(seen, (all) => [...all, info])
      )
    );
    yield* Effect.yieldNow;
    yield* claude.noteConversation(sessionId, {
      cwd,
      threadId: Option.none(),
    });

    const stream = claude.provider.streamSimple(
      model,
      providerContext([
        system,
        {
          role: "user",
          content: "Reply with the single word: ready.",
          timestamp: 2,
        },
      ]),
      { sessionId }
    );

    const result: AssistantMessage = yield* Effect.promise(
      async () => await stream.result()
    );

    // Rate-limit readings arrive just before the result; let the feed drain.
    yield* Effect.sleep("200 millis");

    return { reply: result, readings: yield* Ref.get(seen) };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Claude.layerNoDeps.pipe(
        Layer.provide(
          Layer.mergeAll(
            ClaudeSummary.layerNoDeps,
            ClaudeSlots.layer,
            ClaudeAccount.layer
          )
        ),
        Layer.provide(ClaudeSdk.layer)
      )
    )
  );

  const errorText = reply.errorMessage ?? "";

  const checks = {
    sendable: findings.length === 0,
    success: reply.stopReason === "stop" && errorText === "",
    noThirdPartyRejection: !/third-party apps/iu.test(errorText),
    rateLimitSeen: readings.length > 0,
    noOverage: readings.every((info) => info.isUsingOverage !== true),
  };

  const numbers = {
    model: values.model,
    skills: skills.length,
    instructionChars: instructions.length,
    findings,
    stop: reply.stopReason,
    error: errorText,
    reply: reply.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .slice(0, 80),
    usage: {
      input: reply.usage.input,
      cacheRead: reply.usage.cacheRead,
      cacheWrite: reply.usage.cacheWrite,
      output: reply.usage.output,
    },
    rateLimits: readings.map((info) => ({
      status: info.status,
      type: info.rateLimitType ?? "",
      isUsingOverage: info.isUsingOverage ?? "unreported",
    })),
  };

  return { checks, numbers };
}).pipe(
  // The brain's environment carries an API key: the turn child must still start on the login (the
  // bridge refuses a child whose init reports any other key source, which would fail the turn).
  Effect.provideService(ClaudeSettings, {
    ...ClaudeSettings.defaultValue(),
    env: { ...process.env, ANTHROPIC_API_KEY: DUMMY_API_KEY },
  })
);

const program = Effect.gen(function* () {
  const { part } = values;

  const j6 =
    part === "all" || part === "probe"
      ? Option.some(yield* probePart)
      : Option.none();

  const j7 =
    part === "all" || part === "eligibility"
      ? Option.some(yield* eligibilityPart)
      : Option.none();

  const results = { J6: Option.getOrNull(j6), J7: Option.getOrNull(j7) };

  const passed = [
    ...Option.toArray(j6).map((found) => Object.values(found.checks)),
    ...Option.toArray(j7).map((found) => Object.values(found.checks)),
  ].every((checks) => checks.every(Boolean));

  yield* Effect.logInfo(
    "claude-eligibility",
    JSON.stringify({ passed, ...results })
  );

  if (!passed) {
    return yield* new ClaudeEligibilityFailed({
      message:
        "claude-eligibility failed: see the checks in the log line above.",
    });
  }

  return results;
});

// A turn that never ends fails the judge at the deadline instead of hanging it.
NodeRuntime.runMain(
  program.pipe(
    Effect.timeoutOrElse({
      duration: Duration.minutes(5),
      orElse: () =>
        Effect.fail(
          new ClaudeEligibilityFailed({
            message: "judge timed out after 5 minutes",
          })
        ),
    })
  )
);
