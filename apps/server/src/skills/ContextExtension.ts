// Ported from cairn-v1, apps/server/src/PiContext.ts at 1a5cd4a (`extension`: the context section).
// Changed: two sections named, and ordered, as pi's system prompt has them: `addendum`
// (`APPEND_SYSTEM.md`), then `project_context` (the agent dir's and the workspace's context
// files), each read once per run so a turn's prompt stays fixed.
//
// The context sections: the instructions a thread gets from files, as pi would give them to a
// session in the same cwd. Files are read through `ProjectContext`, which leaves out links leaving
// their directory, hard links, oversized files and text the Claude bridge refuses.

import { defineExtension, section } from "@earendil-works/pi-durable";
import { Effect } from "effect";

import { ExtensionOrder } from "../brain/Extensions.ts";
import type { CairnExtension } from "../brain/Extensions.ts";
import type { ContextRead } from "./ProjectContext.ts";
import { ProjectContext } from "./ProjectContext.ts";
import { RunPins } from "./RunPins.ts";
import { cwdOf, runKeyOf } from "./SkillsExtension.ts";

/** The section holding the agent dir's and the workspace's context files. */
export const PROJECT_CONTEXT_SECTION = "project_context";

/** The section holding `APPEND_SYSTEM.md`. */
export const ADDENDUM_SECTION = "addendum";

/** The context extension over `ProjectContext`. */
export const contextExtension: Effect.Effect<CairnExtension> = Effect.gen(
  function* () {
    const context = yield* ProjectContext;
    const pins = new RunPins<ContextRead>();

    const pinned = (
      conversationId: number,
      key: string,
      input: Parameters<typeof cwdOf>[0]
    ) => pins.get(conversationId, key, () => context.read(cwdOf(input)));

    return {
      order: ExtensionOrder.context,
      extension: defineExtension({
        name: "context",
        sections: [
          section(ADDENDUM_SECTION, async (input, chord) => {
            const key = await runKeyOf(input, chord);
            const text = pinned(input.conversationId, key, input).addendum;

            return text === "" ? undefined : text;
          }),
          section(PROJECT_CONTEXT_SECTION, async (input, chord) => {
            const key = await runKeyOf(input, chord);

            const text = pinned(
              input.conversationId,
              key,
              input
            ).projectContext;

            return text === "" ? undefined : text;
          }),
        ],
      }),
    };
  }
);
