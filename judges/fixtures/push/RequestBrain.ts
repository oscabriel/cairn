// The brain `judges/push.ts --fake` runs in its own process: the whole app (`AppLayer`) over the
// scripted harness, as `dev-main.ts` composes it, with a model that asks for what the judge's message
// says and the notifier's timings shortened so a late push and a reminder come within seconds.
//
// A thread's first message picks the request its run raises:
//
// - `gate: <summary>` calls the `gate` tool, which asks for approval with that summary and waits;
// - `ask: <header> | <question>` calls `ask_user` with one yes-or-no question;
// - anything else is answered `ok`. After a tool result the model answers `done`.

import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { NodeServices } from "@effect/platform-node";
import { Clock, Effect, Layer, Predicate } from "effect";

import {
  AppLayer,
  HarnessBoot,
  ModelHealthLive,
  ReachLive,
  SettingsLive,
  withCatalog,
} from "../../../apps/server/src/AppLayer.ts";
import { EventReactors } from "../../../apps/server/src/brain/EventReactors.ts";
import { ModelSource } from "../../../apps/server/src/brain/ModelSource.ts";
import {
  ScriptedBoot,
  ScriptedHarness,
  ScriptedModel,
  ScriptedStore,
  ScriptedTools,
  scriptedAnswer,
} from "../../../apps/server/src/brain/ScriptedHarness.ts";
import type { ScriptedRequest } from "../../../apps/server/src/brain/ScriptedHarness.ts";
import { SpendFeed } from "../../../apps/server/src/brain/SpendFeed.ts";
import { ServerConfig } from "../../../apps/server/src/Config.ts";
import type { ServerSettings } from "../../../apps/server/src/Config.ts";
import { ExecutorLink } from "../../../apps/server/src/executor/ExecutorLink.ts";
import { Identity } from "../../../apps/server/src/http/Identity.ts";
import { PiHost } from "../../../apps/server/src/pi-host/PiHost.ts";
import { NotifierSettings } from "../../../apps/server/src/push/Notifier.ts";
import {
  judgePortalSettings,
  ReachMachine,
} from "../../../apps/server/src/reach/ReachLayer.ts";
import { Skills } from "../../../apps/server/src/skills/SkillsLayer.ts";

/** The text of the newest user message, or "" when there is none. */
const lastUserText = (request: ScriptedRequest): string => {
  const asked = request.messages.findLast((message) => message.role === "user");

  if (asked === undefined) {
    return "";
  }

  return Predicate.isString(asked.content)
    ? asked.content
    : asked.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
};

/** One tool call, as the scripted model answers it. */
const callTool = (
  name: string,
  args: JsonObject,
  timestamp: number
): AssistantMessage => ({
  ...scriptedAnswer("", timestamp),
  content: [
    {
      type: "toolCall" as const,
      id: `call-${name}-${String(timestamp)}`,
      name,
      arguments: args,
    },
  ],
  stopReason: "toolUse" as const,
});

const JudgeModel = Layer.succeed(
  ScriptedModel,
  ScriptedModel.of({
    answer: (request) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        if (request.messages.at(-1)?.role === "toolResult") {
          return scriptedAnswer("done", now);
        }

        const text = lastUserText(request).trim();

        if (text.startsWith("gate:")) {
          return callTool("gate", { summary: text.slice(5).trim() }, now);
        }

        if (text.startsWith("ask:")) {
          const [header = "", question = ""] = text
            .slice(4)
            .split("|")
            .map((part) => part.trim());

          return callTool(
            "ask_user",
            {
              questions: [
                {
                  header,
                  question,
                  options: [{ label: "Yes" }, { label: "No" }],
                },
              ],
            },
            now
          );
        }

        return scriptedAnswer("ok", now);
      }),
  })
);

/** `gate` asks for approval with its `summary` and says how it was settled. */
const JudgeTools = Layer.succeed(
  ScriptedTools,
  ScriptedTools.of({
    run: (call, api) => {
      if (call.name !== "gate") {
        return Effect.succeed({
          text: `Tool ${call.name} not found`,
          isError: true,
        });
      }

      const { summary } = call.arguments;

      return api
        .ask(Predicate.isString(summary) ? summary : "the gate", false)
        .pipe(
          Effect.map((settled) => ({ text: settled.status, isError: false }))
        );
    },
  })
);

const Harness = Layer.mergeAll(
  Layer.succeed(HarnessBoot, HarnessBoot.of({ resume: Effect.void })),
  EventReactors.layerOff,
  SpendFeed.layerOff
).pipe(
  Layer.provideMerge(
    Layer.effectDiscard(ScriptedBoot.use((boot) => boot.resume)).pipe(
      Layer.provideMerge(ScriptedHarness.layerNoDeps),
      Layer.provide(ScriptedStore.layer),
      Layer.provide(JudgeModel),
      Layer.provide(JudgeTools)
    )
  ),
  Layer.provideMerge(Skills.local),
  Layer.provideMerge(
    withCatalog(ModelSource.layerFaux({ tokensPerSecond: 200, settings: {} }))
  )
);

/** How the judge brain is set up. */
export interface RequestBrainOptions {
  readonly config: Partial<ServerSettings>;
  readonly notifier: NotifierSettings;
}

/** The judge brain as one layer; building it starts the listener on `config.port`. */
export const requestBrain = (options: RequestBrainOptions) =>
  AppLayer.pipe(
    Layer.provideMerge(Harness),
    Layer.provide(PiHost.layerEmpty),
    Layer.provide(ModelHealthLive),
    Layer.provide(SettingsLive),
    Layer.provide(ReachLive),
    Layer.provide(ReachMachine.layerFakePorch),
    Layer.provide(
      judgePortalSettings(
        `cairn-judge-portal-${String(process.pid)}-`,
        0,
        process.env.PATH ?? "/usr/bin:/bin"
      )
    ),
    Layer.provide(ExecutorLink.layerFake),
    Layer.provide(Identity.layerLoopbackOwner),
    Layer.provide(Layer.succeed(NotifierSettings, options.notifier)),
    Layer.provide(ServerConfig.layerWith(options.config)),
    Layer.provide(NodeServices.layer)
  );
