// The skill expansion stage, judged against pi itself: pi's own `_expandSkillCommand` (the method
// pi's `AgentSession` runs on every prompt) produces the expected text for a leading
// `/skill:name args`, and pi's `parseSkillBlock` must read back what a `$name` reference makes.
import { readFileSync } from "node:fs";
import path from "node:path";

import { RequestId } from "@cairn/protocol/Ids";
import { ProjectCreate } from "@cairn/protocol/ShellCommands";
import type { TurnInput } from "@cairn/protocol/Thread";
import {
  AgentSession,
  loadSkills,
  parseSkillBlock,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Predicate, Result } from "effect";

import { EventSink } from "../shell/EventSink.ts";
import { projectIdFor } from "../shell/ShellCommands.ts";
import {
  createThread,
  ShellTestLayer,
  testCommandId,
} from "../shell/ShellTestKit.ts";
import { TurnContent, textStage } from "../threads/TurnContent.ts";
import type { CatalogSkill } from "./SkillCatalog.ts";
import { SkillCatalog } from "./SkillCatalog.ts";
import { expandSkills, skillExpansionStage } from "./SkillExpansionStage.ts";
import { makeFixtureHome } from "./SkillsTestKit.ts";
import type { FixtureHome } from "./SkillsTestKit.ts";

let fixture: FixtureHome;

/** pi's skills under the fixture's user root, as pi's loader reads them. */
const piSkills = () =>
  loadSkills({
    cwd: fixture.home,
    agentDir: fixture.agentDir,
    skillPaths: [path.join(fixture.home, ".agents", "skills")],
    includeDefaults: false,
  }).skills;

/** pi's own expansion of `text` with `skills` loaded. */
const piExpand = (skills: ReadonlyArray<Skill>, text: string): string => {
  const method: unknown = Object.getOwnPropertyDescriptor(
    AgentSession.prototype,
    "_expandSkillCommand"
  )?.value;

  if (!Predicate.isFunction(method)) {
    throw new TypeError("pi's AgentSession has no _expandSkillCommand.");
  }

  const errors: Array<string> = [];

  const self = {
    resourceLoader: { getSkills: () => ({ skills, diagnostics: [] }) },
    _extensionRunner: {
      emitError: (report: { readonly error: string }) => {
        errors.push(report.error);
      },
    },
  };

  const expanded: unknown = method.call(self, text);

  if (errors.length > 0) {
    throw new Error(`pi's expansion reported ${errors.join("; ")}`);
  }

  if (!Predicate.isString(expanded)) {
    throw new TypeError("pi's expansion returned no text.");
  }

  return expanded;
};

const asCatalog = (skill: Skill): CatalogSkill => ({
  name: skill.name,
  description: skill.description,
  filePath: skill.filePath,
  baseDir: skill.baseDir,
  source: "user",
  hidden: Option.none(),
});

/** Cairn's expansion over the same skills. */
const cairnExpand = (
  skills: ReadonlyArray<Skill>,
  text: string,
  refs: ReadonlyArray<string> = []
) =>
  expandSkills(
    text,
    refs,
    (name) =>
      Option.map(
        Option.fromNullishOr(skills.find((skill) => skill.name === name)),
        asCatalog
      ),
    (skill) =>
      Result.succeed(
        stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim()
      )
  );

const input = (text: string, skillRefs: ReadonlyArray<string>): TurnInput => ({
  requestId: RequestId.make("r1"),
  text,
  attachments: [],
  skillRefs: [...skillRefs],
});

describe("SkillExpansionStage", () => {
  beforeEach(() => {
    fixture = makeFixtureHome();
  });

  afterEach(() => {
    fixture.remove();
  });

  describe("pi's leading command and $ references", () => {
    it("is byte-identical to pi for a leading /skill: command", () => {
      const skills = piSkills();

      for (const text of [
        "/skill:alpha",
        "/skill:alpha write the notes for 1.2",
        "/skill:alpha   spaced out args  ",
        "/skill:manual",
        "/skill:nope do something",
        "/skill:alpha\nsecond line",
        "plain text with /skill:alpha inside",
      ]) {
        assert.strictEqual(
          cairnExpand(skills, text).text,
          piExpand(skills, text),
          text
        );
      }
    });

    it("puts a $name reference's block ahead of the text, as pi's parser reads it", () => {
      const skills = piSkills();
      const text = "$zeta convert 10 C please";
      const expansion = cairnExpand(skills, text, ["zeta"]);
      const parsed = parseSkillBlock(expansion.text);

      assert.deepStrictEqual(expansion.expanded, ["zeta"]);
      assert.strictEqual(parsed?.name, "zeta");
      assert.strictEqual(parsed?.userMessage, text);
      assert.isTrue(parsed?.content.includes("Add 273.15.") === true);
    });

    it("expands each name once, the leading command first, unknown names left as text", () => {
      const skills = piSkills();

      const expansion = cairnExpand(skills, "/skill:alpha and $zeta", [
        "zeta",
        "alpha",
        "ghost",
      ]);

      assert.deepStrictEqual(expansion.expanded, ["alpha", "zeta"]);
      assert.deepStrictEqual(
        expansion.skipped.map((skip) => skip.name),
        ["ghost"]
      );
      assert.isTrue(expansion.text.startsWith('<skill name="alpha"'));
      assert.isTrue(expansion.text.endsWith("\n</skill>\n\nand $zeta"));
      assert.strictEqual(expansion.text.split("<skill name=").length, 3);
    });

    it("leaves the text as typed when nothing expands", () => {
      const expansion = cairnExpand(piSkills(), "hello $ghost", ["ghost"]);

      assert.strictEqual(expansion.text, "hello $ghost");
    });
  });

  describe("the TurnContent stage", () => {
    it.effect(
      "expands with the thread's project skills, replacing the text block in place",
      () =>
        Effect.gen(function* () {
          const sink = yield* EventSink;
          const commandId = testCommandId(1);
          const projectId = projectIdFor(commandId);

          yield* sink.commitCommand(
            ProjectCreate.make({
              commandId,
              workspaceRoot: fixture.project,
              title: Option.none(),
            })
          );

          const create = createThread(projectId, 1);

          yield* sink.commitCommand(create);

          const turns = yield* TurnContent;

          const built = yield* turns.build(
            create.threadId,
            "owner@test",
            input("$shared review this", ["shared"])
          );

          const [first, ...rest] = built.content;

          assert.strictEqual(rest.length, 0);
          assert.strictEqual(first?.type, "text");

          const text = first?.type === "text" ? first.text : "";
          const parsed = parseSkillBlock(text);

          // The project's `shared` wins over the user's.
          assert.strictEqual(
            parsed?.location,
            path.join(
              fixture.project,
              ".agents",
              "skills",
              "shared",
              "SKILL.md"
            )
          );
          assert.strictEqual(parsed?.userMessage, "$shared review this");

          // A thread the shell does not know yet (a launch checking its first message) expands
          // nothing from a project and sends the text as typed.
          const unknown = yield* turns.build(
            createThread(projectId, 2).threadId,
            "owner@test",
            input("$shared hi", ["shared"])
          );

          assert.deepStrictEqual(unknown.content, [
            { type: "text", text: "$shared hi" },
          ]);
        }).pipe(
          Effect.provide(
            TurnContent.layerFrom([textStage, skillExpansionStage]).pipe(
              Layer.provideMerge(
                SkillCatalog.layerProjectOnly(path.join(fixture.home, "nobody"))
              ),
              Layer.provideMerge(ShellTestLayer)
            )
          )
        )
    );
  });
});
