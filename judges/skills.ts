// The skills judge (plan 3E). Judges Cairn's skills and context sections against pi itself and
// against the brain's own transcript, and proves the owner's pi setup is never changed:
//
//   node judges/skills.ts [--model <provider>/<modelId>] [--no-model]
//
// 1. Loader parity, fixture: `judges/fixtures/pi-home` copied to a temporary `$HOME`; Cairn's
//    skills section equals pi's own `DefaultResourceLoader` (read-only settings storage, missing
//    packages skipped, no process started) over the same tree.
// 2. Loader parity, the owner's setup: a copy of `~/.pi/agent` (settings, skills, npm and git
//    packages, context files; never auth.json, mcp-auth.json or sessions) and `~/.agents/skills`
//    under a temporary `$HOME`, compared the same way; the copy's skills equal what Cairn reads from
//    the real directory; no skill the settings turn off with `!` is in the section.
// 3. Stability: three renders byte-identical; warm render under 1 ms; cold resolve under 600 ms.
// 4. The brain: pi-durable over the scripted judge model with the `cairn`, `skills` and context
//    sections installed, a thread in the fixture project. Three turns leave exactly one `pi.system`
//    entry carrying `skills`; the project's skill wins and the project's `.pi/skills` is not read;
//    one description edit then a new turn adds exactly one delta, carrying only `skills`.
// 5. One cheap real-model call (an `opencode-go` model through pi's model runtime over the real,
//    read-only agent dir) given only the owner's skills section picks the right skill by name.
//
// Around all of it, as `judges/pi-readonly.sh` does: every entry under the real agent dir is
// recorded (type, size, mtime, mode) before and after and must be identical, no `.lock` may
// appear, and the process must start no child. Prints names, counts and times only, never a
// file's contents or a credential.

import childProcess from "node:child_process";
import {
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  Console,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";

const spawned: Array<string> = [];

// Count every child process, before anything that could start one loads: the brain's modules
// are imported below, after the hook, and `syncBuiltinESMExports` carries it to named imports.
for (const name of [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]) {
  const original: unknown = Object.getOwnPropertyDescriptor(
    childProcess,
    name
  )?.value;

  if (!Predicate.isFunction(original)) {
    continue;
  }

  Object.defineProperty(childProcess, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: (...args: ReadonlyArray<string>) => {
      spawned.push(String(args[0]).split("/").pop() ?? "");

      const result: unknown = original.apply(childProcess, args);

      return result;
    },
  });
}

syncBuiltinESMExports();

const { NodeRuntime } = await import("@effect/platform-node");

const { ConversationId, ProjectId, ThreadId } =
  await import("@cairn/protocol/Ids");

const { withCatalog } = await import("../apps/server/src/AppLayer.ts");

const { Brain } = await import("../apps/server/src/brain/Brain.ts");

const { BrainConfig } = await import("../apps/server/src/brain/BrainConfig.ts");

const { Extensions } = await import("../apps/server/src/brain/Extensions.ts");

const { PiDurableHarness } =
  await import("../apps/server/src/brain/PiDurableHarness.ts");

const { ThreadReceipt } = await import("../apps/server/src/brain/CairnDocs.ts");

const { durable } = await import("../apps/server/src/brain/Durable.ts");

const { HarnessSeam } = await import("../apps/server/src/brain/HarnessSeam.ts");

const { FAUX_MODEL, ModelSource } =
  await import("../apps/server/src/brain/ModelSource.ts");

const { piConversationId } = await import("../apps/server/src/brain/PiIds.ts");

const { ServerConfig } = await import("../apps/server/src/Config.ts");

const { CONTEXT_FILE_NAMES, PiConfig } =
  await import("../apps/server/src/models/PiConfig.ts");

const { PiModelSource } =
  await import("../apps/server/src/models/PiModelSource.ts");

const { cairnSectionExtension } =
  await import("../apps/server/src/skills/CairnSectionExtension.ts");

const { contextExtension } =
  await import("../apps/server/src/skills/ContextExtension.ts");

const { piSkillsOracle } =
  await import("../apps/server/src/skills/PiSkillsOracle.ts");

const { ProjectContext } =
  await import("../apps/server/src/skills/ProjectContext.ts");

const { isRefused } = await import("../apps/server/src/skills/PromptSafety.ts");

const { SkillCatalog } =
  await import("../apps/server/src/skills/SkillCatalog.ts");

const { skillsExtension } =
  await import("../apps/server/src/skills/SkillsExtension.ts");

const { makeFixtureHome } =
  await import("../apps/server/src/skills/SkillsTestKit.ts");

const { JudgeModel } = await import("./fixtures/JudgeModel.ts");

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    "no-model": { type: "boolean", default: false },
  },
});

const REAL_HOME = process.env.HOME ?? os.homedir();

const REAL_AGENT =
  process.env.PI_CODING_AGENT_DIR ?? path.join(REAL_HOME, ".pi", "agent");

/** What of the agent dir the copy takes: never credentials, sessions or logs. */
const COPIED = [
  "settings.json",
  "skills",
  "npm",
  "git",
  "APPEND_SYSTEM.md",
  ...CONTEXT_FILE_NAMES,
];

const WARM_RENDER_BUDGET_MS = 1;

const COLD_RESOLVE_BUDGET_MS = 600;

const failures: Array<string> = [];

const report: Record<string, string | number | ReadonlyArray<string>> = {};

const check = (ok: boolean, failure: string) =>
  Effect.sync(() => {
    if (!ok) {
      failures.push(failure);
    }
  }).pipe(Effect.andThen(Console.log(`${ok ? "ok  " : "FAIL"} ${failure}`)));

/** One line per entry under `root`: type, size, mtime, mode and path. */
const record = (root: string): ReadonlyArray<string> => {
  const lines: Array<string> = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const stat = lstatSync(full);

      let kind = "f";

      if (entry.isSymbolicLink()) {
        kind = "l";
      } else if (entry.isDirectory()) {
        kind = "d";
      }

      lines.push(
        `${kind} ${String(stat.size)} ${String(stat.mtimeMs)} ${stat.mode.toString(8)} ${path.relative(root, full)}`
      );

      if (entry.isDirectory()) {
        walk(full);
      }
    }
  };

  walk(root);

  return lines.toSorted();
};

const now = () => performance.now();

const percentile = (samples: ReadonlyArray<number>, p: number) => {
  const sorted = samples.toSorted((a, b) => a - b);

  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  );
};

const round = (ms: number) => Math.round(ms * 1000) / 1000;

const promptNames = (prompt: string) =>
  [...prompt.matchAll(/<name>(?<name>[^<]*)<\/name>/gu)].map(
    (match) => match.groups?.name ?? ""
  );

const keep = (skill: {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
}) => !isRefused(skill.name, skill.description, skill.filePath);

/** A catalog and pi's oracle over one home and agent dir; `HOME` must already point at `home`. */
const parity = Effect.fn("skills.parity")(function* (
  label: string,
  options: {
    readonly home: string;
    readonly agentDir: string;
    readonly piCwd: string;
  }
) {
  const started = now();

  const view = yield* Effect.gen(function* () {
    const catalog = yield* SkillCatalog;

    return catalog.view(Option.none());
  }).pipe(
    Effect.provide(
      SkillCatalog.layerNoDeps.pipe(
        Layer.provide(
          PiConfig.layerWith({
            agentDir: options.agentDir,
            cwd: options.piCwd,
            home: options.home,
          })
        )
      )
    )
  );

  const coldMs = now() - started;

  const oracle = yield* piSkillsOracle({
    agentDir: options.agentDir,
    cwd: options.piCwd,
    keep,
  });

  const names = view.skills.map((skill) => skill.name);
  const oracleNames = oracle.skills.map((skill) => skill.name);

  yield* check(
    JSON.stringify(names) === JSON.stringify(oracleNames),
    `${label}: Cairn lists the ${String(oracleNames.length)} skills pi's loader loads (Cairn ${String(names.length)})`
  );
  yield* check(
    view.prompt === oracle.prompt,
    `${label}: the skills section equals pi's (${String(view.prompt.length)} characters)`
  );

  const refused = view.skills.filter((skill) =>
    Option.contains(skill.hidden, "unsendable")
  );

  report[`${label}Skills`] = names.length;
  report[`${label}Visible`] = promptNames(view.prompt).length;
  report[`${label}Refused`] = refused.map((skill) => skill.name);
  report[`${label}Chars`] = view.prompt.length;
  report[`${label}ColdMs`] = Math.round(coldMs);

  return { view, coldMs };
});

/** Copies what pi reads of the owner's setup under a new temporary home. */
const copyOwnerSetup = () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "cairn-skills-judge-"));
  const home = path.join(base, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const piCwd = path.join(base, "pi-cwd");

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(piCwd);

  for (const name of COPIED) {
    const from = path.join(REAL_AGENT, name);

    if (existsSync(from)) {
      cpSync(from, path.join(agentDir, name), {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });
    }
  }

  const agentsSkills = path.join(REAL_HOME, ".agents", "skills");

  if (existsSync(agentsSkills)) {
    cpSync(agentsSkills, path.join(home, ".agents", "skills"), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
  }

  return { base, home, agentDir, piCwd };
};

/** The names settings.json turns off with `!skills/.../<name>/SKILL.md`. */
const excludedNames = (settingsFile: string): ReadonlyArray<string> => {
  const decoded = Schema.decodeOption(
    Schema.fromJsonString(
      Schema.Struct({ skills: Schema.optional(Schema.Array(Schema.String)) })
    )
  )(readFileSync(settingsFile, "utf-8"));

  return Option.match(decoded, {
    onNone: () => [],
    onSome: (settings) =>
      (settings.skills ?? []).flatMap((entry) => {
        const match = /^!.*\/(?<name>[^/]+)\/SKILL\.md$/u.exec(entry);

        return match?.groups?.name === undefined ? [] : [match.groups.name];
      }),
  });
};

/** Every `pi.system` entry of a thread's conversation, as the keys of the sections it sets. */
const systemEntries = Effect.fn("skills.systemEntries")(function* (
  threadId: ReturnType<typeof ThreadId.make>
) {
  const brain = yield* Brain;
  const session = yield* brain.session;

  return yield* durable("skills judge entries", async (context) => {
    const receipt = await session.harness.snapshot(
      ThreadReceipt,
      threadId,
      context
    );

    if (receipt === undefined) {
      return [];
    }

    const conversation = await session.harness.conversation(
      piConversationId(ConversationId.make(receipt.conversationId)),
      context
    );

    if (conversation === undefined) {
      return [];
    }

    const page = await conversation.entries({}, 1000, undefined, context);

    // A page lists the newest entry first; the checks read them in commit order.
    return page.items
      .toSorted((a, b) => a.id - b.id)
      .flatMap((entry) =>
        (entry.model ?? []).flatMap((message) =>
          message.role === "system" && message.sections !== undefined
            ? [message.sections]
            : []
        )
      );
  });
});

/** Part 4: the sections inside a real pi-durable brain over the fixture project. */
const brainPart = Effect.fn("skills.brainPart")(function* () {
  const fixture = makeFixtureHome();
  const dataDir = path.join(fixture.home, "..", "data");

  process.env.HOME = fixture.home;

  const renders: Array<number> = [];

  const timed = (source: typeof cairnSectionExtension) => ({
    ...source,
    extension: {
      ...source.extension,
      sections: (source.extension.sections ?? []).map((section) => ({
        ...section,
        render: async (...args: Parameters<typeof section.render>) => {
          const started = now();
          const text = await section.render(...args);

          renders.push(now() - started);

          return text;
        },
      })),
    },
  });

  const sources = Layer.mergeAll(
    SkillCatalog.layerNoDeps,
    ProjectContext.layerNoDeps
  ).pipe(
    Layer.provideMerge(
      PiConfig.layerWith({
        agentDir: fixture.agentDir,
        cwd: fixture.piCwd,
        home: fixture.home,
      })
    )
  );

  const brain = Layer.unwrap(
    Effect.gen(function* () {
      const skills = yield* skillsExtension;
      const context = yield* contextExtension;

      // The harness with exactly these sections, whatever the production set holds, so the
      // judge reads the same before and after the integrator adds them to `ExtensionSet.ts`.
      return PiDurableHarness.layer.pipe(
        Layer.provide(
          Extensions.fromSources(
            [cairnSectionExtension, timed(skills), context].map((each) =>
              Effect.succeed(each)
            )
          )
        ),
        Layer.provideMerge(withCatalog(JudgeModel.layer(2000))),
        Layer.provide(BrainConfig.layerFrom(dataDir))
      );
    })
  ).pipe(
    Layer.provideMerge(sources),
    Layer.provide(ServerConfig.layerWith({ dataDir }))
  );

  const program = Effect.gen(function* () {
    const seam = yield* HarnessSeam;
    const catalog = yield* SkillCatalog;

    yield* Brain.use((open) => open.resume);

    const threadId = ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-00000000e3e1");
    const cwd = path.join(fixture.project, "sub");

    yield* seam.ensureThread({
      threadId,
      projectId: ProjectId.make("prj_skills_judge"),
      model: FAUX_MODEL,
      thinkingLevel: "off",
      cwd,
      instructions: Option.none(),
      runtimeMode: "full-access",
    });

    const turn = Effect.fn("skills.turn")(function* (n: number) {
      const terminal = yield* seam.events.pipe(
        Stream.filter(
          (event) =>
            Predicate.isTagged(event, "RunTerminal") &&
            event.threadId === threadId
        ),
        Stream.runHead,
        Effect.forkChild
      );

      yield* Effect.sleep(Duration.millis(20));
      yield* seam.submit(threadId, {
        requestId: `skills-judge-${String(n)}`,
        content: [{ type: "text", text: `turn ${String(n)}` }],
        entry: Option.none(),
        whenBusy: "followUp",
      });

      const ended = yield* Fiber.join(terminal).pipe(
        Effect.timeout(Duration.seconds(30))
      );

      return Option.match(ended, {
        onNone: () => "no terminal",
        onSome: (event) =>
          Predicate.isTagged(event, "RunTerminal")
            ? event.status
            : "no terminal",
      });
    });

    const statuses = [yield* turn(1), yield* turn(2), yield* turn(3)];

    yield* check(
      statuses.every((status) => status === "completed"),
      `brain: three turns completed (${statuses.join(" ")})`
    );

    const afterThree = yield* systemEntries(threadId);

    const carrying = afterThree.filter((sections) =>
      Predicate.hasProperty(sections, "skills")
    );

    yield* check(
      carrying.length === 1,
      `brain: three turns left exactly one pi.system entry carrying skills (${String(carrying.length)})`
    );

    const first = afterThree[0] ?? {};

    yield* check(
      ["cairn", "skills", "project_context", "addendum"].every((key) =>
        Predicate.hasProperty(first, key)
      ),
      `brain: the first pi.system entry sets cairn, skills, project_context and addendum (${Object.keys(first).join(" ")})`
    );

    const skillsText = first.skills ?? "";
    const expected = catalog.view(Option.some(cwd)).prompt;

    yield* check(
      skillsText === `<skills>\n${expected}\n</skills>`,
      "brain: the skills section is the catalog's text, tagged as pi tags it"
    );
    yield* check(
      skillsText.includes(
        path.join(fixture.project, ".agents", "skills", "shared", "SKILL.md")
      ) && skillsText.includes("local-only"),
      "brain: the project's skills are in and the project's shared skill wins"
    );
    yield* check(
      !skillsText.includes("sneaky"),
      "brain: the project's .pi/skills is not read"
    );
    yield* check(
      !skillsText.includes("architect") && !skillsText.includes("swarm"),
      "brain: skills the settings turn off are absent"
    );

    const context = first.project_context ?? "";

    yield* check(
      [
        path.join(fixture.agentDir, "AGENTS.md"),
        path.join(fixture.project, "AGENTS.md"),
        path.join(fixture.project, "sub", "AGENTS.md"),
      ].every((file) => context.includes(`path="${file}"`)),
      "brain: project_context has the agent dir's, the project's and the folder's AGENTS.md, outermost first"
    );

    writeFileSync(
      path.join(fixture.home, ".agents", "skills", "zeta", "SKILL.md"),
      "---\nname: zeta\ndescription: Use when converting temperatures, edited by the judge.\n---\n\n# zeta\n"
    );

    const fourth = yield* turn(4);
    const afterEdit = yield* systemEntries(threadId);
    const added = afterEdit.slice(afterThree.length);

    yield* check(
      fourth === "completed" &&
        added.length === 1 &&
        JSON.stringify(Object.keys(added[0] ?? {})) === '["skills"]' &&
        (added[0]?.skills ?? "").includes("edited by the judge"),
      `brain: one description edit then a turn added exactly one delta, carrying only skills (${String(added.length)} entries: ${added.map((sections) => Object.keys(sections).join("+")).join(" ")})`
    );

    const warm = renders.slice(1);

    report.sectionRenders = renders.length;
    report.sectionRenderFirstMs = round(renders[0] ?? 0);
    report.sectionRenderP50Ms = round(percentile(warm, 0.5));
    report.sectionRenderMaxWarmMs = round(Math.max(0, ...warm));

    yield* check(
      percentile(warm, 0.5) < WARM_RENDER_BUDGET_MS,
      `brain: warm section render p50 ${String(round(percentile(warm, 0.5)))} ms under ${String(WARM_RENDER_BUDGET_MS)} ms`
    );
  });

  yield* Effect.scoped(program.pipe(Effect.provide(brain))).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        process.env.HOME = REAL_HOME;
        fixture.remove();
      })
    )
  );
});

/** Part 5: one cheap real-model call picks a skill from the owner's section. */
const modelPart = Effect.fn("skills.modelPart")(function* (prompt: string) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cairn-skills-model-"));

  const models = PiModelSource.layer.pipe(
    Layer.provide(ServerConfig.layerWith({ dataDir }))
  );

  const visible = promptNames(prompt);

  const pick = visible.includes("caddy-subdomains")
    ? {
        skill: "caddy-subdomains",
        task: "Put a local dev server on a private https://<name>.<domain> URL served from this machine.",
      }
    : {
        skill: visible[0] ?? "",
        task: `Do what the ${visible[0] ?? ""} skill describes.`,
      };

  const program = Effect.gen(function* () {
    const catalog = yield* PiModelSource;
    const source = yield* ModelSource;
    const listing = yield* catalog.catalog({ bridgeEnabled: false });
    const available = listing.models.filter((model) => model.available);

    const model =
      available.find(
        (each) => `${each.provider}/${each.modelId}` === values.model
      ) ??
      available.find(
        (each) =>
          each.provider === "opencode-go" && each.modelId === "claude-haiku-5-5"
      ) ??
      available.find((each) => each.provider === "opencode-go");

    if (model === undefined) {
      return yield* check(false, "model: no opencode-go model is available");
    }

    const started = now();

    const answer = yield* source.completeSimple(
      { provider: model.provider, modelId: model.modelId },
      {
        systemPrompt: `<skills>\n${prompt}\n</skills>`,
        messages: [
          {
            role: "user",
            content: `Which one skill's file would you read first for this task? ${pick.task} Answer with the skill's name only.`,
            timestamp: 0,
          },
        ],
      },
      // opencode-go routes its Claude models only with a session id.
      { sessionId: `cairn-skills-judge-${crypto.randomUUID()}` }
    );

    const text = answer.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("")
      .trim();

    report.model = `${model.provider}/${model.modelId}`;
    report.modelMs = Math.round(now() - started);
    report.modelExpected = pick.skill;
    report.modelAnswer = text.slice(0, 80);

    return yield* check(
      text.includes(pick.skill),
      `model: ${model.provider}/${model.modelId} picked ${pick.skill} from the owner's section`
    );
  });

  yield* program.pipe(
    Effect.provide(models),
    Effect.ensuring(
      Effect.sync(() => {
        rmSync(dataDir, { recursive: true, force: true });
      })
    )
  );
});

const main = Effect.gen(function* () {
  const before = record(REAL_AGENT);

  yield* Console.log(
    `agent dir: ${REAL_AGENT} (${String(before.length)} entries)`
  );

  // 1. The fixture.
  const fixture = makeFixtureHome();

  process.env.HOME = fixture.home;

  const fixtureParity = yield* parity("fixture", fixture).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        process.env.HOME = REAL_HOME;
        fixture.remove();
      })
    )
  );

  yield* check(
    !fixtureParity.view.skills.some((skill) =>
      ["architect", "swarm"].includes(skill.name)
    ),
    "fixture: the skills settings.json turns off with ! are absent"
  );

  // 2. The owner's setup, copied.
  const copy = copyOwnerSetup();

  process.env.HOME = copy.home;

  const ownerParity = yield* parity("owner", copy).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        process.env.HOME = REAL_HOME;
      })
    )
  );

  const excluded = excludedNames(path.join(copy.agentDir, "settings.json"));
  const ownerNames = ownerParity.view.skills.map((skill) => skill.name);
  const present = excluded.filter((name) => ownerNames.includes(name));

  report.ownerExcluded = excluded.length;

  yield* check(
    excluded.length > 0 && present.length === 0,
    `owner: none of the ${String(excluded.length)} skills settings.json turns off is listed${present.length > 0 ? ` (${present.join(" ")})` : ""}`
  );

  rmSync(copy.base, { recursive: true, force: true });

  // The real directory, read-only: the same skills as the copy, and the timings.
  const realPiCwd = mkdtempSync(path.join(os.tmpdir(), "cairn-skills-cwd-"));
  const coldStarted = now();

  const real = yield* Effect.gen(function* () {
    const catalog = yield* SkillCatalog;
    const first = catalog.view(Option.none());
    const coldMs = now() - coldStarted;

    const texts = [
      first,
      catalog.refresh(Option.none()),
      catalog.refresh(Option.none()),
    ].map((view) => view.prompt);

    const samples: Array<number> = [];

    for (let index = 0; index < 1000; index += 1) {
      const started = now();

      catalog.refresh(Option.none());
      samples.push(now() - started);
    }

    return { first, coldMs, texts, samples };
  }).pipe(
    Effect.provide(
      SkillCatalog.layerNoDeps.pipe(
        Layer.provide(
          PiConfig.layerWith({
            agentDir: REAL_AGENT,
            cwd: realPiCwd,
            home: REAL_HOME,
          })
        )
      )
    ),
    Effect.ensuring(
      Effect.sync(() => {
        rmSync(realPiCwd, { recursive: true, force: true });
      })
    )
  );

  // The copy's section names files under the copy's home; the same text over the real home.
  const copySection = ownerParity.view.prompt.replaceAll(copy.home, REAL_HOME);
  const realNames = real.first.skills.map((skill) => skill.name);

  const differing = [
    ...realNames.filter((name) => !ownerNames.includes(name)),
    ...ownerNames.filter((name) => !realNames.includes(name)),
  ];

  yield* check(
    differing.length === 0 && real.first.prompt === copySection,
    `owner: the real directory gives the copy's ${String(ownerNames.length)} skills and the same section (${String(realNames.length)} real, differing: ${differing.join(" ") || "none"}, section ${real.first.prompt === copySection ? "equal" : "differs"})`
  );
  yield* check(
    real.texts.every((text) => text === real.texts[0]),
    "owner: three renders are byte-identical"
  );

  report.coldResolveMs = Math.round(real.coldMs);
  report.warmRefreshP50Ms = round(percentile(real.samples, 0.5));
  report.warmRefreshP99Ms = round(percentile(real.samples, 0.99));

  yield* check(
    real.coldMs < COLD_RESOLVE_BUDGET_MS,
    `owner: cold resolve ${String(Math.round(real.coldMs))} ms under ${String(COLD_RESOLVE_BUDGET_MS)} ms`
  );
  yield* check(
    percentile(real.samples, 0.5) < WARM_RENDER_BUDGET_MS,
    `owner: warm refresh check p50 ${String(round(percentile(real.samples, 0.5)))} ms under ${String(WARM_RENDER_BUDGET_MS)} ms`
  );

  // 4. The brain.
  yield* brainPart();

  // 5. The model.
  yield* values["no-model"]
    ? Console.log("model: skipped")
    : modelPart(real.first.prompt);

  const after = record(REAL_AGENT);

  const changed =
    after.length !== before.length ||
    after.some((line, index) => line !== before[index]);

  const locks = after.filter((line) => /\.lock(?:\s|$)/u.test(line)).length;

  yield* check(
    !changed,
    `agent dir: identical before and after (${String(after.length)} entries)`
  );
  yield* check(locks === 0, `agent dir: no .lock entry (${String(locks)})`);
  yield* check(
    spawned.length === 0,
    `children: none started (${String(spawned.length)}${spawned.length > 0 ? `: ${spawned.join(" ")}` : ""})`
  );

  yield* Console.log(
    JSON.stringify({ pass: failures.length === 0, ...report })
  );

  return yield* failures.length > 0
    ? Effect.die(`${String(failures.length)} checks failed`)
    : Effect.void;
});

NodeRuntime.runMain(main);
