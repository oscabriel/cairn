// Scene tests for the meters (plan 6G): the usage page never draws an unknown as zero (an unpriced
// model, an unread window, Codex with no login, OpenCode Go's unreadable plan, a thread with no
// spend); and the page asks the brain once per epoch, and again when the rows show new spend.

import { ThreadId } from "@cairn/protocol/Ids";
import type { ServerSettings } from "@cairn/protocol/Settings";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import type { ModelSpend, Spend, SpendSummary } from "@cairn/protocol/Spend";
import type { UsageSnapshot } from "@cairn/protocol/Usage";
import { assert, describe, it } from "@effect/vitest";
import { Option, Predicate } from "effect";
import * as AsyncData from "foldkit/asyncData";
import type { Html } from "foldkit/html";
import * as Scene from "foldkit/scene";

import { FetchThreadBudget, SaveBudget } from "./Command.ts";
import { Message } from "./Message.ts";
import { BudgetTarget, initial } from "./Model.ts";
import type { MetersContext, Model } from "./Model.ts";
import { inform, update } from "./Update.ts";
import { view as usageView } from "./UsageView.ts";

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

const SETTINGS: ServerSettings = {
  autoSettleDays: 3,
  titleModel: Option.none(),
  bridgeEnabled: true,
  bridgeGenerationCap: 4,
  defaultBudget: { ...DEFAULT_BUDGET, maxTokens: 200_000 },
};

const loaded = (fields: Partial<MetersContext>): Model => ({
  ...inform(initial, context(fields)).model,
  spend: AsyncData.succeed(SPEND),
  server: AsyncData.succeed(SETTINGS),
});

const usageConfig = { update, view: usageView };

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

/** The usage page's context with one row at `totalTokens`. */
const row = (totalTokens: number) => ({
  threads: [
    {
      threadId: threadA,
      title: "Port the parser",
      spend: summary(totalTokens, 1_200_000, 0, "within"),
    },
  ],
});

describe("the usage page", () => {
  it("asks the brain for each section once the page opens on a client", () => {
    const closed = inform(initial, context({ page: "closed" }));

    assert.lengthOf(closed.commands ?? [], 0);

    const opened = inform(closed.model, context({}));

    assert.deepStrictEqual(
      (opened.commands ?? []).map((command) => command.name),
      ["FetchSpend", "FetchMetersSettings"]
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

  it("keeps one spend roll-up out at a time during a run, and asks again for spend that came meanwhile", () => {
    const opened = inform(initial, context({}));

    const answeredOnce = update(
      opened.model,
      Message.ReceivedSpend({ epoch: 1, spend: SPEND })
    ).model;

    const first = inform(answeredOnce, context(row(120_000)));
    const second = inform(first.model, context(row(150_000)));

    assert.deepStrictEqual(
      [first.commands ?? [], second.commands ?? []].map((commands) =>
        commands.map((command) => command.name)
      ),
      [["FetchSpend"], []],
      "a second spend.get went out while the first was still out"
    );

    // The first answer is older than the rows: the newer spend is asked for now.
    const answered = update(
      second.model,
      Message.ReceivedSpend({ epoch: 1, spend: SPEND })
    );

    assert.deepStrictEqual(
      (answered.commands ?? []).map((command) => command.name),
      ["FetchSpend"]
    );

    const settled = update(
      answered.model,
      Message.ReceivedSpend({ epoch: 1, spend: SPEND })
    );

    assert.lengthOf(settled.commands ?? [], 0);
  });
});

describe("the usage page's budgets (ADR 0047)", () => {
  const DEFAULT_TARGET = BudgetTarget.members[0].make({});

  it("changes the default budget a brief or workflow starts from, in dollars and tokens", () => {
    const saved = {
      ...DEFAULT_BUDGET,
      maxListMicros: Micros.make(5_000_000),
      maxTokens: 200_000,
    };

    Scene.scene(
      usageConfig,
      Scene.given(loaded({})),
      Scene.click(Scene.role("button", { name: "Change default budget" })),
      Scene.expect(Scene.label("Tokens")).toHaveValue("200000"),
      Scene.expect(Scene.label("Dollars at API list price")).toHaveValue(""),
      Scene.type(Scene.label("Dollars at API list price"), "5"),
      Scene.click(Scene.role("button", { name: "Save budget" })),
      Scene.Command.expectExact(
        SaveBudget({ target: DEFAULT_TARGET, budget: saved })
      ),
      Scene.Command.resolve(
        SaveBudget,
        Message.SavedBudget({
          target: DEFAULT_TARGET,
          budget: saved,
          settings: Option.some({ ...SETTINGS, defaultBudget: saved }),
        })
      ),
      Scene.expect(Scene.testId("usage-default-budget")).toContainText(
        "$5.00 at list price"
      ),
      Scene.expect(Scene.testId("usage-budget-form")).not.toExist(),
      Scene.expect(Scene.testId("usage-budget-saved")).toContainText(
        "Default budget saved"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("sets a thread's own budget from its row, through budget.declare", () => {
    const target = BudgetTarget.members[1].make({
      threadId: threadA,
      title: "Port the parser",
    });

    const budget = { ...DEFAULT_BUDGET, maxTokens: 300_000 };

    Scene.scene(
      usageConfig,
      Scene.given(loaded({})),
      Scene.inside(
        Scene.selector(
          `[data-testid="usage-thread"][data-thread-id="${threadA}"]`
        ),
        Scene.click(Scene.role("button", { name: "Set budget" }))
      ),
      Scene.Command.resolve(
        FetchThreadBudget,
        Message.ReceivedThreadBudget({
          threadId: threadA,
          budget: Option.none(),
        })
      ),
      Scene.type(Scene.label("Tokens"), "300000"),
      Scene.click(Scene.role("button", { name: "Save budget" })),
      Scene.Command.expectExact(SaveBudget({ target, budget })),
      Scene.Command.resolve(
        SaveBudget,
        Message.SavedBudget({ target, budget, settings: Option.none() })
      ),
      Scene.expect(Scene.testId("usage-budget-saved")).toContainText(
        "Budget set for Port the parser"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("saves nothing that is not a budget, and says why", () => {
    Scene.scene(
      usageConfig,
      Scene.given(loaded({})),
      Scene.click(Scene.role("button", { name: "Change default budget" })),
      Scene.type(Scene.label("Dollars at API list price"), "lots"),
      Scene.click(Scene.role("button", { name: "Save budget" })),
      Scene.expect(Scene.testId("usage-budget-form-hint")).toContainText(
        "Dollars must be an amount above zero"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  const threadTarget = BudgetTarget.members[1].make({
    threadId: threadA,
    title: "Port the parser",
  });

  const standing = {
    ...DEFAULT_BUDGET,
    maxListMicros: Micros.make(5_000_000),
    maxTokens: 500_000,
    warnAt: 0.9,
  };

  it("fills a thread's form from the line it stands at, so a save keeps the limits left alone", () => {
    Scene.scene(
      usageConfig,
      Scene.given(loaded({})),
      Scene.inside(
        Scene.selector(
          `[data-testid="usage-thread"][data-thread-id="${threadA}"]`
        ),
        Scene.click(Scene.role("button", { name: "Set budget" }))
      ),
      Scene.Command.expectExact(FetchThreadBudget({ threadId: threadA })),
      // Nothing can be saved over a line not read yet.
      Scene.expect(
        Scene.role("button", { name: "Save budget" })
      ).toBeDisabled(),
      Scene.expect(Scene.testId("usage-budget-form-hint")).toContainText(
        "Reading"
      ),
      Scene.Command.resolve(
        FetchThreadBudget,
        Message.ReceivedThreadBudget({
          threadId: threadA,
          budget: Option.some(standing),
        })
      ),
      Scene.expect(Scene.label("Dollars at API list price")).toHaveValue(
        "5.00"
      ),
      Scene.expect(Scene.label("Tokens")).toHaveValue("500000"),
      Scene.type(Scene.label("Dollars at API list price"), "10"),
      Scene.click(Scene.role("button", { name: "Save budget" })),
      Scene.Command.expectExact(
        SaveBudget({
          target: threadTarget,
          budget: { ...standing, maxListMicros: Micros.make(10_000_000) },
        })
      ),
      Scene.Command.resolve(
        SaveBudget,
        Message.SavedBudget({
          target: threadTarget,
          budget: { ...standing, maxListMicros: Micros.make(10_000_000) },
          settings: Option.none(),
        })
      ),
      Scene.expect(Scene.testId("usage-budget-saved")).toContainText(
        "Budget set for Port the parser"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("says a thread's budget was removed when the save names no limit", () => {
    const removed = { ...standing, maxListMicros: null, maxTokens: null };

    Scene.scene(
      usageConfig,
      Scene.given(loaded({})),
      Scene.inside(
        Scene.selector(
          `[data-testid="usage-thread"][data-thread-id="${threadA}"]`
        ),
        Scene.click(Scene.role("button", { name: "Set budget" }))
      ),
      Scene.Command.resolve(
        FetchThreadBudget,
        Message.ReceivedThreadBudget({
          threadId: threadA,
          budget: Option.some(standing),
        })
      ),
      Scene.type(Scene.label("Dollars at API list price"), ""),
      Scene.type(Scene.label("Tokens"), ""),
      Scene.click(Scene.role("button", { name: "Save budget" })),
      Scene.Command.expectExact(
        SaveBudget({ target: threadTarget, budget: removed })
      ),
      Scene.Command.resolve(
        SaveBudget,
        Message.SavedBudget({
          target: threadTarget,
          budget: removed,
          settings: Option.none(),
        })
      ),
      Scene.expect(Scene.testId("usage-budget-saved")).toContainText(
        "Budget removed for Port the parser"
      ),
      Scene.expect(Scene.testId("usage-budget-saved")).not.toContainText(
        "At its line"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("keeps a thread's form closed to saves when its line could not be read", () => {
    Scene.scene(
      usageConfig,
      Scene.given(loaded({})),
      Scene.inside(
        Scene.selector(
          `[data-testid="usage-thread"][data-thread-id="${threadA}"]`
        ),
        Scene.click(Scene.role("button", { name: "Set budget" }))
      ),
      Scene.Command.resolve(
        FetchThreadBudget,
        Message.FailedThreadBudget({
          threadId: threadA,
          message: "The brain is restarting.",
        })
      ),
      Scene.expect(Scene.testId("usage-budget-form-hint")).toContainText(
        "The brain is restarting."
      ),
      Scene.expect(
        Scene.role("button", { name: "Save budget" })
      ).toBeDisabled(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("keeps the form whose save is out, and lands each answer only on its own form", () => {
    const threadBTarget = BudgetTarget.members[1].make({
      threadId: threadB,
      title: "Free model notes",
    });

    const budget = { ...DEFAULT_BUDGET, maxTokens: 300_000 };

    const opened = update(
      loaded({}),
      Message.ClickedEditBudget({ target: threadTarget })
    ).model;

    const read = update(
      opened,
      Message.ReceivedThreadBudget({ threadId: threadA, budget: Option.none() })
    ).model;

    const typed = update(
      read,
      Message.ChangedBudgetTokens({ value: "300000" })
    ).model;

    const saving = update(typed, Message.ClickedSaveBudget());

    assert.deepStrictEqual(
      (saving.commands ?? []).map((command) => command.name),
      ["SaveBudget"]
    );

    // Another row's Set budget, and Cancel, wait for the save's answer.
    const other = update(
      saving.model,
      Message.ClickedEditBudget({ target: threadBTarget })
    );

    const cancelled = update(other.model, Message.ClickedCancelBudget());

    assert.lengthOf(other.commands ?? [], 0);
    assert.deepStrictEqual(
      Option.map(cancelled.model.form, (form) => form.target),
      Option.some(threadTarget)
    );

    // An answer for another form never closes this one or writes its error here.
    const stray = update(
      cancelled.model,
      Message.FailedSaveBudget({
        target: threadBTarget,
        message: "Not this one.",
      })
    ).model;

    assert.deepStrictEqual(
      Option.map(stray.form, (form) => [form.saving, form.error]),
      Option.some([true, Option.none()])
    );

    const strayed = update(
      stray,
      Message.SavedBudget({
        target: threadBTarget,
        budget,
        settings: Option.none(),
      })
    ).model;

    assert.isTrue(Option.isSome(strayed.form));

    const landed = update(
      strayed,
      Message.SavedBudget({
        target: threadTarget,
        budget,
        settings: Option.none(),
      })
    ).model;

    assert.isTrue(Option.isNone(landed.form));
    assert.isTrue(
      Option.exists(landed.saved, (text) => text.includes("Port the parser"))
    );
  });
});
