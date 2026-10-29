// J-roles, the changed-table scenario (docs/phase-2/notes/models.md, "Judges"; ADR 0035), on a
// real pi-durable Harness over pi-ai's faux providers and a migrated in-memory `cairn.sqlite`.
//
// A brief or workflow script is written naming `@judge` while the table binds it to `alpha/a1`.
// Child A is dispatched at once: the dispatching commit creates its conversation and writes the
// resolved model into its `pi.agent`, and it runs. The user then rebinds `@judge` to `beta/b1`.
// Child B is dispatched from the same written spec, calls the `roles` tool, and answers. Child A is
// steered once more. What the scenario reports: each child's `pi.agent` and dispatch record, which
// provider served each request, and what the `roles` tool told child B.
//
// `resolveAt` decides when the spec meets the table: `dispatch` is Cairn's rule (resolve in the
// commit that creates the child); `write` is the broken control, a resolver that reads the table
// when the script is written, which `verdictOf` must catch.

import type { ModelRef } from "@cairn/protocol/Models";
import type { ResolvedRole, RoleTable } from "@cairn/protocol/Roles";
import { DEFAULT_ROLE_TABLE, RoleName } from "@cairn/protocol/Roles";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  AgentDoc,
  configure,
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Option } from "effect";

import { ModelSource } from "../../../apps/server/src/brain/ModelSource.ts";
import { Database } from "../../../apps/server/src/db/Database.ts";
import { migrations } from "../../../apps/server/src/db/Migrations.ts";
import { ModelHealth } from "../../../apps/server/src/models/ModelHealth.ts";
import { PiModelSource } from "../../../apps/server/src/models/PiModelSource.ts";
import { RoleAliases } from "../../../apps/server/src/models/RoleAliases.ts";
import { RolesTool } from "../../../apps/server/src/models/RolesExtension.ts";
import { SettingsStore } from "../../../apps/server/src/models/SettingsStore.ts";

const context = BACKGROUND_CONTEXT;

/** The model `@judge` is bound to when the script is written. */
export const BEFORE: ModelRef = { provider: "alpha", modelId: "a1" };

/** The model the user rebinds `@judge` to before child B's dispatch. */
export const AFTER: ModelRef = { provider: "beta", modelId: "b1" };

/** The spec the script holds. */
export const WRITTEN_SPEC = "@judge";

/** When the written spec meets the table. */
export type ResolveAt = "dispatch" | "write";

/** One child as the scenario saw it after everything ran. */
export interface ChildReport {
  /** The model its dispatch record holds. */
  readonly dispatched: ModelRef;
  /** The model its `pi.agent` holds. */
  readonly agent: Option.Option<ModelRef>;
}

/** What the scenario observed. */
export interface ScenarioReport {
  readonly a: ChildReport;
  /** Child A's `pi.agent` model read right after its dispatch, before the table changed. */
  readonly aBeforeChange: Option.Option<ModelRef>;
  readonly b: ChildReport;
  /** Requests each faux provider served: child A twice, child B twice (the tool call and the answer). */
  readonly calls: { readonly alpha: number; readonly beta: number };
  /** The `roles` tool's text as child B's model received it. */
  readonly rolesToolText: string;
}

const bindingOf = (model: ModelRef): RoleTable[RoleName] => ({
  model,
  thinkingLevel: Option.none(),
  fallbacks: [],
  note: Option.none(),
});

const tableWith = (judge: ModelRef): RoleTable => ({
  ...DEFAULT_ROLE_TABLE,
  [RoleName.make("@judge")]: bindingOf(judge),
});

const patchOf = (judge: ModelRef) => ({
  autoSettleDays: Option.none(),
  titleModel: Option.none(),
  bridgeEnabled: Option.none(),
  bridgeGenerationCap: Option.none(),
  roleBindings: Option.some(tableWith(judge)),
  defaultBudget: Option.none(),
});

const sameModel = (a: ModelRef, b: ModelRef) =>
  a.provider === b.provider && a.modelId === b.modelId;

const text = (model: ModelRef) => `${model.provider}/${model.modelId}`;

/** The text of the newest tool result in a request's transcript. */
const lastToolResultText = (transcript: TranscriptContext): string => {
  const results = transcript.messages.filter(
    (message) => message.role === "toolResult"
  );

  const last = results.at(-1);

  return last === undefined
    ? ""
    : last.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
};

/** Runs the scenario with the spec resolved at `resolveAt`. */
export const runScenario = (resolveAt: ResolveAt) =>
  Effect.gen(function* () {
    const alpha = fauxProvider({
      api: "faux-alpha",
      provider: BEFORE.provider,
      models: [{ id: BEFORE.modelId }],
    });

    const beta = fauxProvider({
      api: "faux-beta",
      provider: AFTER.provider,
      models: [{ id: AFTER.modelId }],
    });

    let rolesToolText = "";

    alpha.setResponses([
      fauxAssistantMessage("child A, first answer"),
      fauxAssistantMessage("child A, steered answer"),
    ]);

    beta.setResponses([
      fauxAssistantMessage([fauxToolCall("roles", {})], {
        stopReason: "toolUse",
      }),
      (transcript) => {
        rolesToolText = lastToolResultText(transcript);

        return fauxAssistantMessage("child B, answer");
      },
    ]);

    const models = createModels();

    models.setProvider(alpha.provider);
    models.setProvider(beta.provider);

    const source = Layer.mock(ModelSource)({
      models: () => models,
      settings: () => ({}),
    });

    const services = yield* Layer.build(
      RolesTool.layerNoDeps.pipe(
        Layer.provideMerge(RoleAliases.layerNoDeps),
        Layer.provideMerge(SettingsStore.layerNoDeps),
        Layer.provide(ModelHealth.layerNoDeps),
        Layer.provide(PiModelSource.layerFromModelSource),
        Layer.provide(source),
        Layer.provide(Database.layerTest(migrations))
      )
    );

    const roles = Context.get(services, RoleAliases);
    const settings = Context.get(services, SettingsStore);
    const tool = Context.get(services, RolesTool);

    yield* settings.update(patchOf(BEFORE));

    const registry = createRegistry();

    registry.install(tool.extension.extension);

    const harness = yield* Effect.acquireRelease(
      Effect.promise(
        async () =>
          await Harness.open(
            new MemoryStorage(),
            { models, registry, settings: {} },
            context
          )
      ),
      (open) =>
        Effect.promise(async () => {
          await open.close(context);
        })
    );

    // The script is written: it holds the spec. The control resolves it here, at write time.
    const atWrite: Option.Option<ResolvedRole> =
      resolveAt === "write"
        ? Option.some(yield* roles.resolve(WRITTEN_SPEC, Option.none()))
        : Option.none();

    /** Resolves the written spec as the strategy says, then creates the child in one commit. */
    const dispatch = Effect.fn("RoleDispatch.dispatch")(function* () {
      const resolved = yield* Option.match(atWrite, {
        onNone: () => roles.resolve(WRITTEN_SPEC, Option.none()),
        onSome: Effect.succeed,
      });

      const id = yield* Effect.promise(
        async () =>
          await harness.commit(async (tx) => {
            const created = await tx.createConversation({
              ownership: { kind: "ownerless" },
            });

            await configure(tx, created.id, {
              model: resolved.model,
              thinkingLevel: resolved.thinkingLevel,
            });

            return created.id;
          }, context)
      );

      return { id, resolved };
    });

    const send = (id: ConversationId, content: string) =>
      Effect.promise(async () => {
        const conversation = await harness.conversation(id, context);

        if (conversation === undefined) {
          throw new Error(`conversation ${String(id)} vanished`);
        }

        await conversation.submit(
          { type: "input", content, requestId: `r-${String(id)}-${content}` },
          context
        );

        await conversation.waitForIdle(context);
      });

    const agentModel = (id: ConversationId) =>
      Effect.promise(async () => {
        const agent = await harness.snapshot(AgentDoc, id, context);

        return Option.map(Option.fromUndefinedOr(agent?.model), (model) => ({
          provider: model.provider,
          modelId: model.modelId,
        }));
      });

    const childA = yield* dispatch();

    yield* send(childA.id, "first");

    const aBeforeChange = yield* agentModel(childA.id);

    // The user rebinds the role while the script waits for its next node.
    yield* settings.update(patchOf(AFTER));

    const childB = yield* dispatch();

    yield* send(childB.id, "first");
    yield* send(childA.id, "steer");

    const report: ScenarioReport = {
      a: {
        dispatched: childA.resolved.model,
        agent: yield* agentModel(childA.id),
      },
      aBeforeChange,
      b: {
        dispatched: childB.resolved.model,
        agent: yield* agentModel(childB.id),
      },
      calls: { alpha: alpha.state.callCount, beta: beta.state.callCount },
      rolesToolText,
    };

    return report;
  }).pipe(Effect.scoped);

/**
 * What the report breaks of ADR 0035, one sentence each; empty when it holds: a child dispatched
 * after the table changed runs on the new binding, a child dispatched before keeps its model, each
 * child's `pi.agent` equals its dispatch record, and the `roles` tool shows the table as it is.
 */
export const verdictOf = (report: ScenarioReport): ReadonlyArray<string> => {
  const failures: Array<string> = [];

  const agentText = (agent: Option.Option<ModelRef>) =>
    Option.match(agent, { onNone: () => "nothing", onSome: text });

  if (!sameModel(report.b.dispatched, AFTER)) {
    failures.push(
      `child B was dispatched on ${text(report.b.dispatched)} though ${WRITTEN_SPEC} was rebound to ${text(AFTER)} before its dispatch`
    );
  }

  if (!sameModel(report.a.dispatched, BEFORE)) {
    failures.push(
      `child A was dispatched on ${text(report.a.dispatched)}, not ${text(BEFORE)}`
    );
  }

  for (const [name, child] of [
    ["A", report.a],
    ["B", report.b],
  ] as const) {
    if (
      !Option.exists(child.agent, (agent) => sameModel(agent, child.dispatched))
    ) {
      failures.push(
        `child ${name}'s pi.agent holds ${agentText(child.agent)}, its dispatch record ${text(child.dispatched)}`
      );
    }
  }

  if (
    !Option.exists(report.aBeforeChange, (agent) =>
      Option.exists(report.a.agent, (after) => sameModel(agent, after))
    )
  ) {
    failures.push(
      `child A's model moved from ${agentText(report.aBeforeChange)} to ${agentText(report.a.agent)} when the table changed`
    );
  }

  if (report.calls.alpha !== 2 || report.calls.beta !== 2) {
    failures.push(
      `alpha served ${report.calls.alpha} requests and beta ${report.calls.beta}; child A should have run twice on alpha and child B twice on beta`
    );
  }

  if (!report.rolesToolText.includes(`@judge: ${text(AFTER)}`)) {
    failures.push(
      `the roles tool did not show @judge on ${text(AFTER)}: ${JSON.stringify(report.rolesToolText)}`
    );
  }

  return failures;
};
