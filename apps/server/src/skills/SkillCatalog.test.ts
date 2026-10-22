// Ported in part from cairn-v1, apps/server/test/skills.test.ts at 1a5cd4a (sorted render, hidden
// skills listed but not rendered, project override, a linked skill read once, refused text left
// out, a changed skill on the next render). Changed: the outside judge is pi's own
// `DefaultResourceLoader` over the committed fixture home (`PiSkillsOracle`), and the catalog is
// cached per cwd.
import { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { PiConfig } from "../models/PiConfig.ts";
import { piSkillsOracle } from "./PiSkillsOracle.ts";
import { isRefused } from "./PromptSafety.ts";
import type { SkillViews, SkillView } from "./SkillCatalog.ts";
import { projectSkillRoots, SkillCatalog } from "./SkillCatalog.ts";
import { makeFixtureHome } from "./SkillsTestKit.ts";
import type { FixtureHome } from "./SkillsTestKit.ts";

let fixture: FixtureHome;

let savedHome: string | undefined;

const catalogLayer = () =>
  SkillCatalog.layerNoDeps.pipe(
    Layer.provide(
      PiConfig.layerWith({
        agentDir: fixture.agentDir,
        cwd: fixture.piCwd,
        home: fixture.home,
      })
    )
  );

const withCatalog = <A, E>(
  body: (catalog: SkillViews) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    const catalog = yield* SkillCatalog;

    return yield* body(catalog);
  }).pipe(Effect.provide(catalogLayer()));

const names = (view: SkillView) => view.skills.map((skill) => skill.name);

const promptNames = (prompt: string) =>
  [...prompt.matchAll(/<name>(?<name>[^<]*)<\/name>/gu)].map(
    (match) => match.groups?.name ?? ""
  );

const setDescription = (file: string, name: string, description: string) => {
  writeFileSync(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
  );
};

describe("the skill catalog", () => {
  beforeEach(() => {
    fixture = makeFixtureHome();
    savedHome = process.env.HOME;
    // pi's package manager finds `~/.agents/skills` under $HOME.
    process.env.HOME = fixture.home;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    fixture.remove();
  });

  it.effect(
    "renders exactly the section pi's own loader gives for the fixture home",
    () =>
      Effect.gen(function* () {
        const view = yield* withCatalog((catalog) =>
          Effect.sync(() => catalog.view(Option.none()))
        );

        const oracle = yield* piSkillsOracle({
          agentDir: fixture.agentDir,
          cwd: fixture.piCwd,
          keep: (skill) =>
            !isRefused(skill.name, skill.description, skill.filePath),
        });

        assert.deepStrictEqual(
          names(view),
          oracle.skills.map((skill) => skill.name)
        );
        assert.strictEqual(view.prompt, oracle.prompt);
        assert.deepStrictEqual(oracle.diagnostics, []);
      })
  );

  it.effect(
    "honours settings filters and packages, lists hidden skills and leaves them out of the prompt",
    () =>
      Effect.gen(function* () {
        const view = yield* withCatalog((catalog) =>
          Effect.sync(() => catalog.view(Option.none()))
        );

        assert.deepStrictEqual(names(view), [
          "agent-own",
          "alpha",
          "manual",
          "nested",
          "packaged",
          "quoting",
          "shared",
          "zeta",
        ]);

        const hidden = Object.fromEntries(
          view.skills.map((skill) => [
            skill.name,
            Option.getOrElse(skill.hidden, () => "visible"),
          ])
        );

        assert.strictEqual(hidden.manual, "user_invoked");
        assert.strictEqual(hidden.quoting, "unsendable");
        assert.deepStrictEqual(promptNames(view.prompt), [
          "agent-own",
          "alpha",
          "nested",
          "packaged",
          "shared",
          "zeta",
        ]);
        assert.isTrue(view.prompt.startsWith("The following skills"));
      })
  );

  it.effect("renders byte-identical text three times", () =>
    withCatalog((catalog) =>
      Effect.sync(() => {
        const first = catalog.refresh(Option.none());
        const second = catalog.refresh(Option.none());
        const third = catalog.view(Option.none());

        assert.strictEqual(first.prompt, second.prompt);
        assert.strictEqual(second.prompt, third.prompt);
        // Nothing changed, so the cached view itself comes back.
        assert.strictEqual(first, third);
      })
    )
  );

  it.effect(
    "puts project skills first, so a project skill wins, and never reads the project's .pi",
    () =>
      withCatalog((catalog) =>
        Effect.sync(() => {
          const view = catalog.view(
            Option.some(path.join(fixture.project, "sub"))
          );

          const shared = view.skills.find((skill) => skill.name === "shared");

          assert.strictEqual(shared?.source, "project");
          assert.strictEqual(
            shared?.description,
            "The project's version of the shared skill."
          );
          assert.isTrue(names(view).includes("local-only"));
          assert.isFalse(names(view).includes("sneaky"));
          assert.isTrue(
            view.problems.some((problem) => problem.startsWith("skill shared:"))
          );

          // Another cwd sees the user's version.
          const outside = catalog.view(Option.none());

          assert.strictEqual(
            outside.skills.find((skill) => skill.name === "shared")?.source,
            "user"
          );
        })
      )
  );

  it.effect("shows an edited description on the next refresh", () =>
    withCatalog((catalog) =>
      Effect.sync(() => {
        const before = catalog.refresh(Option.none());

        setDescription(
          path.join(fixture.home, ".agents", "skills", "zeta", "SKILL.md"),
          "zeta",
          "Use when converting temperatures, edited."
        );

        const after = catalog.refresh(Option.none());

        assert.notStrictEqual(before.prompt, after.prompt);
        assert.isTrue(after.prompt.includes("temperatures, edited."));
        // The cached view stays as it was until a refresh.
        assert.strictEqual(catalog.view(Option.none()), after);
      })
    )
  );

  it.effect("picks up a skill added to the project on the next refresh", () =>
    withCatalog((catalog) =>
      Effect.sync(() => {
        const cwd = Option.some(fixture.project);
        const before = catalog.refresh(cwd);
        const dir = path.join(fixture.project, ".agents", "skills", "added");

        symlinkSync(
          path.join(fixture.project, ".agents", "skills", "local-only"),
          dir
        );

        const after = catalog.refresh(cwd);

        assert.isFalse(names(before).includes("added"));
        // A linked skill is the same file: read once, under its first name.
        assert.deepStrictEqual(names(after), names(before));
      })
    )
  );

  it.effect("reload resolves pi's setup again and rebuilds", () =>
    withCatalog((catalog) =>
      Effect.gen(function* () {
        const first = catalog.view(Option.none());
        const reloaded = yield* catalog.reload(Option.none());

        assert.notStrictEqual(first, reloaded);
        assert.strictEqual(first.prompt, reloaded.prompt);
      })
    )
  );

  it.effect("the project-only catalog has no user skills", () =>
    Effect.gen(function* () {
      const catalog = yield* SkillCatalog;
      const view = catalog.view(Option.some(fixture.project));

      assert.deepStrictEqual(names(view), ["local-only", "shared"]);
    }).pipe(Effect.provide(SkillCatalog.layerProjectOnly(fixture.home)))
  );

  it("walks project roots from the cwd up to the git root", () => {
    const roots = projectSkillRoots(
      path.join(fixture.project, "sub"),
      fixture.home
    );

    assert.deepStrictEqual(roots, [
      path.join(fixture.project, "sub", ".agents", "skills"),
      path.join(fixture.project, ".agents", "skills"),
    ]);
  });
});
