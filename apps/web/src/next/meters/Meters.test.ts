// Scene tests for the meters (plan 6G): the usage page never draws an unknown as zero (an unpriced
// model, an unread window, Codex with no login, OpenCode Go's unreadable plan, a thread with no
// spend); the page asks the brain once per epoch, and again when the rows show new spend; the role
// table rebinds one role by saving the whole table, one change at a time, shows the brain's answer
// and checks the roles again.

import { ThreadId } from "@cairn/protocol/Ids";
import type { ModelCatalog, ModelListing } from "@cairn/protocol/Models";
import {
  DEFAULT_ROLE_TABLE,
  RoleCheck,
  RoleName,
  RoleSpec,
} from "@cairn/protocol/Roles";
import type { RoleTable } from "@cairn/protocol/Roles";
import type { ServerSettings } from "@cairn/protocol/Settings";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import type { ModelSpend, Spend, SpendSummary } from "@cairn/protocol/Spend";
import type { UsageSnapshot } from "@cairn/protocol/Usage";
import { assert, describe, it } from "@effect/vitest";
import { Option, Predicate, Schema } from "effect";
import * as AsyncData from "foldkit/asyncData";
import type { Html, HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";

import {
  CheckRoles,
  FetchMetersCatalog,
  FetchMetersSettings,
  FetchSpend,
  SaveRoleTable,
} from "./Command.ts";
import { Message } from "./Message.ts";
import { initial } from "./Model.ts";
import type { MetersContext, Model } from "./Model.ts";
import { view as rolesView } from "./RolesView.ts";
import { inform, update } from "./Update.ts";
import { view as usageView } from "./UsageView.ts";

const verifier = RoleName.make("@verifier");

const tokens = (input: number) => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: Option.none(),
});

const modelSpend = (
  input: number,
  micros: Option.Option<number>,
  basis: ModelSpend["basis"]
): ModelSpend => ({
  tokens: tokens(input),
  listMicros: Option.map(micros, (value) => Micros.make(value)),
  basis,
});

const SPEND: Spend = {
  tokens: tokens(180_000),
  listMicros: Micros.make(1_250_000),
  unpricedTokens: 60_000,
  unpricedModels: ["opencode-go/beam-free"],
  byModel: {
    "claude-bridge/claude-opus-5-5": modelSpend(
      100_000,
      Option.some(1_000_000),
      "list_on_plan"
    ),
    "opencode-go/beam-free": modelSpend(60_000, Option.none(), "unpriced"),
    "opencode-go/qwen3.8-flash": modelSpend(
      20_000,
      Option.some(250_000),
      "metered"
    ),
  },
  compute: Option.none(),
};

const summary = (
  totalTokens: number,
  listMicros: number,
  unpricedTokens: number,
  budget: SpendSummary["budget"]
): SpendSummary => ({
  totalTokens,
  listMicros: Micros.make(listMicros),
  unpricedTokens,
  budget,
});

const USAGE: UsageSnapshot = {
  providers: [
    {
      provider: "claude-bridge",
      reading: "read",
      windows: [
        {
          id: "five_hour",
          label: "Session",
          used: Option.some(0.42),
          resetsAt: Option.none(),
          exhausted: false,
        },
        {
          id: "seven_day",
          label: "Weekly",
          used: Option.none(),
          resetsAt: Option.none(),
          exhausted: false,
        },
      ],
      checkedAt: Option.none(),
    },
    {
      provider: "opencode-go",
      reading: "unsupported",
      windows: [],
      checkedAt: Option.none(),
    },
  ],
};

const threadA = ThreadId.make("01890a5d-ac96-774b-bcce-b302099a0001");

const threadB = ThreadId.make("01890a5d-ac96-774b-bcce-b302099a0002");

const context = (fields: Partial<MetersContext>): MetersContext => ({
  epoch: 1,
  hasClient: true,
  page: "usage",
  usage: Option.some(USAGE),
  threads: [
    {
      threadId: threadA,
      title: "Port the parser",
      spend: summary(100_000, 1_000_000, 0, "warned"),
    },
    {
      threadId: threadB,
      title: "Free model notes",
      spend: summary(60_000, 0, 60_000, "none"),
    },
  ],
  ...fields,
});

const codexTable: RoleTable = {
  ...DEFAULT_ROLE_TABLE,
  [verifier]: {
    model: { provider: "openai-codex", modelId: "gpt-6-luna" },
    thinkingLevel: Option.none(),
    fallbacks: [],
    note: Option.none(),
  },
};

const settingsWith = (table: RoleTable): ServerSettings => ({
  autoSettleDays: 3,
  titleModel: Option.none(),
  bridgeEnabled: true,
  bridgeGenerationCap: 4,
  roleBindings: table,
  defaultBudget: { ...DEFAULT_BUDGET, maxTokens: 200_000 },
});

const listing = (
  provider: string,
  modelId: string,
  available: boolean
): ModelListing => ({
  provider,
  modelId,
  name: modelId,
  thinkingLevels: ["low", "medium", "high"],
  acceptsImages: false,
  contextWindow: Option.none(),
  available,
});

const CATALOG: ModelCatalog = {
  models: [
    listing("claude-bridge", "claude-opus-5-5", true),
    listing("claude-bridge", "claude-sonnet-5-5", true),
    listing("opencode-go", "gpt-6-luna", true),
  ],
  defaults: {
    model: { provider: "claude-bridge", modelId: "claude-opus-5-5" },
    thinkingLevel: "medium",
  },
};

const Resolution = RoleCheck.fields.resolution.pipe(
  Schema.toTaggedUnion("_tag")
);

const unresolvedVerifier: RoleCheck = {
  spec: "@verifier",
  resolution: Resolution.cases.Unresolved.make({
    reason: "no_ready_model",
    skipped: [
      {
        model: { provider: "openai-codex", modelId: "gpt-6-luna" },
        reason: "missing_credential",
      },
    ],
  }),
  sameFamilyAsWorker: false,
};

const readyVerifier: RoleCheck = {
  spec: "@verifier",
  resolution: Resolution.cases.Resolved.make({
    resolved: {
      spec: RoleSpec.make("@verifier"),
      role: verifier,
      model: { provider: "opencode-go", modelId: "gpt-6-luna" },
      thinkingLevel: null,
      via: "primary",
      skipped: [],
      family: "openai",
      priced: true,
    },
  }),
  sameFamilyAsWorker: false,
};

const loaded = (fields: Partial<MetersContext>): Model => ({
  ...inform(initial, context(fields)).model,
  spend: AsyncData.succeed(SPEND),
  server: AsyncData.succeed(settingsWith(codexTable)),
  catalog: AsyncData.succeed(CATALOG),
  checks: AsyncData.succeed([unresolvedVerifier]),
});

const usageConfig = { update, view: usageView };

const rolesConfig = {
  update,
  view: (model: Model, h: HtmlBuilder<Message>) =>
    rolesView(model, { usageHref: "/usage" }, h),
};

/** Zero as a reading prints it. */
const ZERO = /(?:^|\D)0%|\$0\.00/u;

type VNode = NonNullable<Html>;

const textOf = (node: VNode): string =>
  [
    node.text ?? "",
    ...(node.children ?? []).map((child) =>
      Predicate.isString(child) ? child : textOf(child)
    ),
  ].join("");

/** Every `data-known="false"` reading's words, for the never-zero rule. */
const unknownReadings = (root: VNode): ReadonlyArray<string> => {
  const found: Array<string> = [];
  const pending: Array<VNode> = [root];

  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.data?.attrs?.["data-known"] === "false") {
      found.push(textOf(node));
    }

    for (const child of node.children ?? []) {
      if (!Predicate.isString(child)) {
        pending.push(child);
      }
    }
  }

  return found;
};

describe("the usage page", () => {
  it("asks the brain for each section once the page opens on a client", () => {
    const closed = inform(initial, context({ page: "closed" }));

    assert.lengthOf(closed.commands ?? [], 0);

    const opened = inform(closed.model, context({}));

    assert.deepStrictEqual(
      (opened.commands ?? []).map((command) => command.name),
      ["FetchSpend", "FetchMetersSettings", "FetchMetersCatalog"]
    );

    // The same context again asks nothing; new spend on a row asks for the roll-up again.
    const again = inform(
      update(opened.model, Message.ReceivedSpend({ epoch: 1, spend: SPEND }))
        .model,
      context({})
    );

    assert.lengthOf(again.commands ?? [], 0);

    const more = inform(
      again.model,
      context({
        threads: [
          {
            threadId: threadA,
            title: "Port the parser",
            spend: summary(120_000, 1_200_000, 0, "warned"),
          },
        ],
      })
    );

    assert.deepStrictEqual(
      (more.commands ?? []).map((command) => command.name),
      ["FetchSpend"]
    );
  });

  it("never draws an unknown as zero", () => {
    Scene.scene(
      usageConfig,
      Scene.given(loaded({})),
      Scene.expect(Scene.testId("usage-spend-total")).toHaveText(
        "$1.25 at list price, plus 60k tokens with no price"
      ),
      Scene.expect(
        Scene.selector('[data-model="opencode-go/beam-free"] [data-known]')
      ).toHaveText("No price"),
      Scene.expect(
        Scene.selector('[data-model="opencode-go/beam-free"] [data-known]')
      ).toHaveAttr("data-known", "false"),
      Scene.expect(
        Scene.selector('[data-model="claude-bridge/claude-opus-5-5"]')
      ).toContainText("$1.00 at API list price"),
      Scene.expect(
        Scene.selector(
          `[data-testid="usage-thread"][data-thread-id="${threadB}"]`
        )
      ).toContainText("No price: 60k tokens with no list price"),
      Scene.expect(
        Scene.selector('[data-window="five_hour"] [data-reading]')
      ).toHaveText("42% used"),
      Scene.expect(
        Scene.selector('[data-window="seven_day"] [data-reading]')
      ).toHaveText("Unknown"),
      Scene.expect(
        Scene.selector('[data-window="seven_day"] [role="meter"]')
      ).not.toHaveAttr("aria-valuenow"),
      Scene.expect(
        Scene.selector(
          '[data-testid="usage-plan"][data-provider="openai-codex"]'
        )
      ).toHaveAttr("data-plan-state", "absent"),
      Scene.expect(
        Scene.selector(
          '[data-testid="usage-plan"][data-provider="openai-codex"]'
        )
      ).toContainText("no Codex subscription"),
      Scene.expect(
        Scene.selector(
          '[data-testid="usage-plan"][data-provider="opencode-go"]'
        )
      ).toHaveAttr("data-plan-state", "unsupported"),
      Scene.expect(
        Scene.selector(
          `[data-testid="usage-budget-thread"][data-thread-id="${threadA}"]`
        )
      ).toContainText("Past its warning line"),
      Scene.expect(
        Scene.selector(
          `[data-testid="usage-budget-thread"][data-thread-id="${threadB}"]`
        )
      ).toBeAbsent(),
      Scene.expect(Scene.testId("usage-default-budget")).toContainText(
        "200k tokens"
      ),
      Scene.expect(Scene.testId("usage-default-budget")).toContainText(
        "No limit"
      ),
      Scene.tap(({ html }) => {
        const unknown = unknownReadings(html);

        assert.isAbove(unknown.length, 3);

        for (const words of unknown) {
          assert.notMatch(words, ZERO, `an unknown reads as zero: ${words}`);
        }
      })
    );
  });

  it("reads every plan as unknown before the first frame", () => {
    Scene.scene(
      usageConfig,
      Scene.given(loaded({ usage: Option.none() })),
      Scene.expect(
        Scene.selector(
          '[data-testid="usage-plan"][data-provider="claude-bridge"]'
        )
      ).toHaveAttr("data-plan-state", "waiting"),
      Scene.expect(
        Scene.selector(
          '[data-testid="usage-plan"][data-provider="claude-bridge"]'
        )
      ).toContainText("Unknown"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});

describe("the role table", () => {
  const rebound: RoleTable = {
    ...codexTable,
    [verifier]: {
      model: { provider: "opencode-go", modelId: "gpt-6-luna" },
      thinkingLevel: Option.none(),
      fallbacks: [],
      note: Option.none(),
    },
  };

  it("shows why a role has no ready model, and rebinds it by saving the whole table", () => {
    Scene.scene(
      rolesConfig,
      Scene.given(loaded({ page: "settings" })),
      Scene.expect(
        Scene.selector('[data-role="@verifier"] [data-role-status]')
      ).toHaveText("No ready model"),
      Scene.expect(
        Scene.selector('[data-role="@verifier"] [data-role-detail]')
      ).toContainText("openai-codex/gpt-6-luna has no credential here"),
      Scene.change(
        Scene.label("Model for @verifier"),
        "opencode-go/gpt-6-luna"
      ),
      Scene.Command.expectExact(SaveRoleTable({ table: rebound })),
      Scene.expect(
        Scene.selector('[data-role="@verifier"] [data-slot="status-chip"]')
      ).toHaveText("Saving"),
      // One change at a time: every select waits while the first change is saving.
      Scene.expect(Scene.label("Model for @worker")).toBeDisabled(),
      Scene.expect(Scene.label("Thinking for @verifier")).toBeDisabled(),
      Scene.Command.resolve(
        SaveRoleTable({ table: rebound }),
        Message.SavedRoleTable({ settings: settingsWith(rebound) })
      ),
      Scene.Command.expectExact(CheckRoles({ epoch: 1, table: rebound })),
      Scene.expect(Scene.selector('[data-role="@verifier"]')).toHaveAttr(
        "data-binding",
        "opencode-go/gpt-6-luna"
      ),
      Scene.expect(Scene.label("Model for @verifier")).toHaveValue(
        "opencode-go/gpt-6-luna"
      ),
      Scene.Command.resolve(
        CheckRoles({ epoch: 1, table: rebound }),
        Message.ReceivedRoleChecks({ epoch: 1, checks: [readyVerifier] })
      ),
      Scene.expect(
        Scene.selector('[data-role="@verifier"] [data-role-status]')
      ).toHaveText("Ready"),
      Scene.expect(
        Scene.selector('[data-role="@verifier"] [data-role-detail]')
      ).toContainText("Resolves to opencode-go/gpt-6-luna"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("keeps the old binding and says so when the brain refuses the table", () => {
    Scene.scene(
      rolesConfig,
      Scene.given(loaded({ page: "settings" })),
      Scene.change(Scene.label("Thinking for @worker"), "high"),
      Scene.Command.resolve(
        SaveRoleTable({
          table: {
            ...codexTable,
            [RoleName.make("@worker")]: {
              ...DEFAULT_ROLE_TABLE[RoleName.make("@worker")],
              thinkingLevel: Option.some("high"),
            },
          },
        }),
        Message.FailedRoleSave({ message: "roleBindings: refused." })
      ),
      Scene.expect(Scene.testId("roles-notice")).toContainText(
        "roleBindings: refused."
      ),
      Scene.expect(Scene.selector('[data-role="@verifier"]')).toHaveAttr(
        "data-binding",
        "openai-codex/gpt-6-luna"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("checks every role when the table arrives", () => {
    const opened = inform(initial, context({ page: "settings" })).model;

    const answered = update(
      opened,
      Message.ReceivedServerSettings({
        epoch: 1,
        settings: settingsWith(codexTable),
      })
    );

    assert.deepStrictEqual(
      (answered.commands ?? []).map((command) => command.name),
      [CheckRoles.name]
    );
    assert.deepStrictEqual(
      [FetchSpend.name, FetchMetersSettings.name, FetchMetersCatalog.name],
      ["FetchSpend", "FetchMetersSettings", "FetchMetersCatalog"]
    );
  });
});
