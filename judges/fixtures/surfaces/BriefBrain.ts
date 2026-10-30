// The scripted brain the brief card judge (judges/surfaces.ts, `brief-go`, plan 6B) drives: a parent
// that proposes one brief naming the role the user's message names, children that answer at once,
// and two role tables (`BRIEF_ROLES`) that disagree about one role. The subagent tools are the
// scripted harness's own (briefs, Go, Send back, the child's thread, settlement notes and the wake);
// no provider is called and nothing is billed.
//
// - The parent (the seeded thread): a message "brief @<role> <tag>" is answered with one
//   `subagent_spawn` of "Count the files <tag>" with that role; once the tool answered it says
//   "Waiting for Go.". Anything else it is given (a Send back's notes, a child's wake) is answered
//   "Parent read: <what it was given>", so the judge reads what reached the parent, and how often.
// - A child answers "Counted 3 files." at once.
// - Roles: the brain's settings table binds `@worker` to the faux model the scripted brain lists,
//   so `roles.check` resolves it; the scripted harness's own table also binds `@reviewer`, which
//   the settings do not. A brief naming `@reviewer` is asked (as when the table changed after the
//   ask), and `roles.check` then finds no `@reviewer`: Go is blocked on an unbound role.

import { DEFAULT_ROLE_TABLE, RoleName } from "@cairn/protocol/Roles";
import type { RoleTable } from "@cairn/protocol/Roles";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { Clock, Effect, Layer, Option } from "effect";

import { messageText } from "../../../apps/server/src/brain/CommitFeed.ts";
import { FAUX_MODEL } from "../../../apps/server/src/brain/ModelSource.ts";
import {
  ScriptedModel,
  ScriptedTools,
  scriptedAnswer,
} from "../../../apps/server/src/brain/ScriptedHarness.ts";
import type { CairnBrain, CairnRoles } from "../parity/CairnApp.ts";
import { PARITY_THREAD_ID } from "../parity/CairnApp.ts";

/** What a child answers. */
export const CHILD_ANSWER = "Counted 3 files.";

/** The role the brain's table binds and `roles.check` resolves. */
export const BOUND_ROLE = "@worker";

/** The role only the scripted harness binds: unbound for `roles.check`. */
export const UNBOUND_ROLE = "@reviewer";

const binding = {
  model: FAUX_MODEL,
  thinkingLevel: Option.some("medium" as const),
  fallbacks: [],
  note: Option.none(),
};

const settingsTable: RoleTable = {
  ...DEFAULT_ROLE_TABLE,
  [RoleName.make(BOUND_ROLE)]: binding,
};

/** The two tables: the brain's settings, and the scripted harness's with `@reviewer` too. */
export const BRIEF_ROLES: CairnRoles = {
  settings: settingsTable,
  scripted: { ...settingsTable, [RoleName.make(UNBOUND_ROLE)]: binding },
};

const ASK = /^brief (?<role>@[a-z-]+) (?<tag>.+)$/u;

const parentAnswer = (messages: ReadonlyArray<Message>, now: number) => {
  const last = messages.at(-1);

  if (last === undefined) {
    return scriptedAnswer("Noted.", now);
  }

  if (last.role === "toolResult") {
    return scriptedAnswer("Waiting for Go.", now);
  }

  const given = messageText(last).trim();
  const asked = ASK.exec(given);

  if (asked !== null) {
    const role = asked.groups?.role ?? "";
    const tag = asked.groups?.tag ?? "";

    return fauxAssistantMessage(
      [
        fauxToolCall(
          "subagent_spawn",
          {
            description: `Count the files ${tag}`.trim(),
            brief: "Count the TypeScript files under src and say how many.",
            role,
          },
          { id: `spawn-${String(now)}` }
        ),
      ],
      { stopReason: "toolUse" }
    );
  }

  return scriptedAnswer(`Parent read: ${given}`, now);
};

const BriefModel = Layer.succeed(
  ScriptedModel,
  ScriptedModel.of({
    answer: (request) =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        request.threadId === PARITY_THREAD_ID
          ? parentAnswer(request.messages, now)
          : scriptedAnswer(CHILD_ANSWER, now)
      ),
  })
);

/** The brief card judge's brain: the proposing parent and its children, over the echo tool. */
export const briefBrain: CairnBrain = {
  model: BriefModel,
  tools: ScriptedTools.layerEcho,
};
