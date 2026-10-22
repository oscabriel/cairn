// What the skills package gives the composition roots: the two services (`SkillCatalog`,
// `ProjectContext`) as one layer per brain, and the three Cairn extensions as sources for
// `ExtensionSet.ts`. `live` reads the owner's pi setup through the brain's `PiConfig` (shared with
// the model runtime, so one resolve serves both); `local` reads project files only, for the
// scripted dev brain and tests that must not read the owner's `~/.pi/agent`.
import { homedir } from "node:os";

import { Effect, Layer } from "effect";

import type { CairnExtension } from "../brain/Extensions.ts";
import { cairnSectionExtension } from "./CairnSectionExtension.ts";
import { contextExtension } from "./ContextExtension.ts";
import { ProjectContext } from "./ProjectContext.ts";
import { SkillCatalog } from "./SkillCatalog.ts";
import { skillsExtension } from "./SkillsExtension.ts";

/** The `cairn`, `skills` and context extensions, for the production list in `ExtensionSet.ts`. */
export const skillExtensionSources: ReadonlyArray<
  Effect.Effect<CairnExtension>
> = [Effect.succeed(cairnSectionExtension), skillsExtension, contextExtension];

/** The skill and context services of one brain. */
export const Skills = {
  /** Over the brain's `PiConfig` (needs `ServerConfig`): the deployed brain and pi-durable judges. */
  live: Layer.mergeAll(SkillCatalog.layer, ProjectContext.layer),
  /** Project files only: no user skills, no agent dir. */
  local: Layer.mergeAll(
    SkillCatalog.layerProjectOnly(process.env.HOME ?? homedir()),
    ProjectContext.layerWorkspaceOnly
  ),
};
