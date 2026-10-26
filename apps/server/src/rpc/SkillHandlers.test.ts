// `skills.list` and `skills.reload` over a project in the fixture home: the project's skills come
// first and win over the user's, a hidden skill is listed as not model-invocable, and an unknown
// project is `NotFound`.

import { writeFileSync } from "node:fs";
import path from "node:path";

import { ProjectCreate } from "@cairn/protocol/ShellCommands";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { EventSink } from "../shell/EventSink.ts";
import { projectIdFor } from "../shell/ShellCommands.ts";
import {
  ShellTestLayer,
  testCommandId,
  unknownProjectId,
} from "../shell/ShellTestKit.ts";
import { ProjectContext } from "../skills/ProjectContext.ts";
import { SkillCatalog } from "../skills/SkillCatalog.ts";
import { makeFixtureHome } from "../skills/SkillsTestKit.ts";
import type { FixtureHome } from "../skills/SkillsTestKit.ts";
import { skillHandlers } from "./SkillHandlers.ts";

let fixture: FixtureHome;

const handlersLayer = () =>
  Layer.mergeAll(
    SkillCatalog.layerProjectOnly(path.join(fixture.home, "nobody")),
    ProjectContext.layerWorkspaceOnly
  ).pipe(Layer.provideMerge(ShellTestLayer));

const addProject = Effect.gen(function* () {
  const sink = yield* EventSink;
  const commandId = testCommandId(1);

  yield* sink.commitCommand(
    ProjectCreate.make({
      commandId,
      workspaceRoot: fixture.project,
      title: Option.none(),
    })
  );

  return projectIdFor(commandId);
});

describe("the skill handlers", () => {
  beforeEach(() => {
    fixture = makeFixtureHome();
  });

  afterEach(() => {
    fixture.remove();
  });

  it.effect("list a project's skills, sorted, with the project's first", () =>
    Effect.gen(function* () {
      const projectId = yield* addProject;
      const handlers = yield* skillHandlers;
      const list = yield* handlers.list(projectId, Option.none());

      assert.deepStrictEqual(
        list.skills.map((skill) => [skill.name, skill.source]),
        [
          ["local-only", "project"],
          ["shared", "project"],
        ]
      );
      assert.isTrue(list.skills.every((skill) => skill.modelInvocable));
    }).pipe(Effect.provide(handlersLayer()))
  );

  it.effect("list a skill added since, and reload rebuilds", () =>
    Effect.gen(function* () {
      const projectId = yield* addProject;
      const handlers = yield* skillHandlers;

      yield* handlers.list(projectId, Option.none());

      const shared = path.join(
        fixture.project,
        ".agents",
        "skills",
        "shared",
        "SKILL.md"
      );

      writeFileSync(
        shared,
        "---\nname: shared\ndescription: Edited.\ndisable-model-invocation: true\n---\n\n# shared\n"
      );

      const listed = yield* handlers.list(projectId, Option.none());
      const reloaded = yield* handlers.reload(projectId, Option.none());

      for (const list of [listed, reloaded]) {
        const skill = list.skills.find((each) => each.name === "shared");

        assert.strictEqual(skill?.description, "Edited.");
        assert.isFalse(skill?.modelInvocable);
      }
    }).pipe(Effect.provide(handlersLayer()))
  );

  it.effect("refuse an unknown project", () =>
    Effect.gen(function* () {
      const handlers = yield* skillHandlers;

      const error = yield* handlers
        .list(unknownProjectId, Option.some("r1"))
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "NotFound");
    }).pipe(Effect.provide(handlersLayer()))
  );
});
