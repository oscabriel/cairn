// Ported from cairn-v1, apps/server/src/Skills.ts at 1a5cd4a (`extension`: the skills section).
// Changed: the text is pi's own skills section (`formatSkillsForPrompt(visible, "read")`, trimmed,
// tagged `skills` as pi's system prompt tags it), rendered from `SkillCatalog`'s cached view and
// held for the length of a run, so a model request in the middle of a turn never sees a changed
// list; a run's first request picks up whatever changed since the last one.
//
// The `skills` section: the skills a thread's model may load, with their files' locations, so a
// thread reads the same list pi would show it in the same cwd.
import type { Context as ChordContext } from "@earendil-works/chord";
import type { PromptInput } from "@earendil-works/pi-durable";
import { defineExtension, LiveDoc, section } from "@earendil-works/pi-durable";
import { Effect, Option } from "effect";

import { ExtensionOrder } from "../brain/Extensions.ts";
import type { CairnExtension } from "../brain/Extensions.ts";
import { RunPins } from "./RunPins.ts";
import { SkillCatalog } from "./SkillCatalog.ts";

/** The section's key, which is also its tag. */
export const SKILLS_SECTION = "skills";

/**
 * Which run a section renders for: the run task of the conversation's `pi.live`, or `idle` outside
 * a run (a compaction's request, say), with the conversation's cwd.
 */
export const runKeyOf = async (
  input: PromptInput,
  context: ChordContext
): Promise<string> => {
  const live = await input.read.snapshot(
    LiveDoc,
    input.conversationId,
    context
  );

  const run = live?.run === undefined ? "idle" : String(live.run.taskId);

  return `${run}\0${input.agent.cwd ?? ""}`;
};

/** The cwd a section renders for. */
export const cwdOf = (input: PromptInput): Option.Option<string> =>
  Option.fromNullishOr(input.agent.cwd);

/** The skills extension over the catalog. */
export const skillsExtension: Effect.Effect<CairnExtension> = Effect.gen(
  function* () {
    const catalog = yield* SkillCatalog;
    const pins = new RunPins<string>();

    return {
      order: ExtensionOrder.skills,
      extension: defineExtension({
        name: "skills",
        sections: [
          section(SKILLS_SECTION, async (input, context) => {
            const key = await runKeyOf(input, context);

            const text = pins.get(
              input.conversationId,
              key,
              () => catalog.refresh(cwdOf(input)).prompt
            );

            return text === "" ? undefined : text;
          }),
        ],
      }),
    };
  }
);
