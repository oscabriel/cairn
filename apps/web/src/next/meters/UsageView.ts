// The usage page (plan wave 6, 6G; surfaces note S9, models note M10), drawn in the `next` look: the
// spend ledger (the whole roll-up by model, then each thread with spend recorded), the plan windows
// of each plan Cairn knows (Claude on the bridge, Codex, OpenCode Go, and any other the brain
// reads), and the budgets (the default a brief or launch starts from, then each thread with one).
// Unknown is never drawn as zero: an unpriced model reads "No price" with its tokens, an unread
// window reads Unknown on a hatched track, Codex with no login says so in place of its windows,
// and a thread with no spend recorded is not listed. Every reading carries `data-known`, which the
// `meters` judge reads beside its words.

import {
  budgetLinesOf,
  budgetWordOf,
  modelLinesOf,
  otherPlanProviders,
  PLAN_PROVIDERS,
  planStateOf,
  spendFigureOf,
  summaryFigureOf,
  windowPercentOf,
} from "@cairn/client-logic/Meters";
import type { PlanState, SpendFigure } from "@cairn/client-logic/Meters";
import type { Spend } from "@cairn/protocol/Spend";
import type { PlanWindow } from "@cairn/protocol/Usage";
import { Match, Option } from "effect";
import { Submodel } from "foldkit";
import * as AsyncData from "foldkit/asyncData";
import type { Html, HtmlBuilder } from "foldkit/html";

import { settingsRouter, threadRouter } from "../../Route.ts";
import { formatDayTime } from "../../settings/Time.ts";
import { classNames } from "../../ui/ClassNames.ts";
import { button, buttonDefaults } from "../ui/Button.ts";
import { card, recordLines } from "../ui/Card.ts";
import { TYPE, WEIGHT_MEDIUM, WEIGHT_STRONG } from "../ui/Classes.ts";
import { markOfTone } from "../ui/Glyph.ts";
import { meter } from "../ui/Meter.ts";
import { statusChip } from "../ui/StatusChip.ts";

import "./meters.css";
import { Message } from "./Message.ts";
import type { MeteredThread, Model } from "./Model.ts";

type H = HtmlBuilder<Message>;

/** A reading's words, marked known or unknown for the judge. */
const reading = (h: H, known: boolean, text: string, extra = ""): Html =>
  h.span(
    [
      h.DataAttribute("meter-reading", ""),
      h.DataAttribute("known", known ? "true" : "false"),
      h.Class(
        classNames(
          "min-w-0 break-words tabular-nums",
          known ? "text-ink-1" : "text-ink-3 italic",
          extra
        )
      ),
    ],
    [text]
  );

const quiet = (h: H, text: string): Html =>
  h.p([h.Class(classNames("text-ink-2", TYPE.ui))], [text]);

/** A section's answer while it loads or after it failed, or its body. */
const remoteBody = <A>(
  h: H,
  data: AsyncData.AsyncData<A, string>,
  what: string,
  body: (value: A) => ReadonlyArray<Html>
): ReadonlyArray<Html> =>
  Option.match(AsyncData.getData(data), {
    onSome: body,
    onNone: () =>
      Option.match(AsyncData.getError(data), {
        onNone: () => [reading(h, false, `Reading ${what}...`)],
        onSome: (error) => [
          reading(h, false, `${what} unknown: ${error}`),
          button(
            h,
            {
              ...buttonDefaults<Message>(),
              size: "small",
              onClick: Option.some(Message.ClickedRetry()),
              attributes: [h.DataAttribute("action", "meters-retry")],
            },
            ["Try again"]
          ),
        ],
      }),
  });

const figureLine = (h: H, figure: SpendFigure, strong = false): Html =>
  reading(
    h,
    true,
    figure.text,
    strong ? classNames(TYPE.body, WEIGHT_STRONG) : TYPE.ui
  );

const listRow = (
  h: H,
  attributes: ReadonlyArray<ReturnType<H["DataAttribute"]>>,
  label: Html,
  value: Html
): Html =>
  h.li(
    [
      ...attributes,
      h.Class(
        "flex min-w-0 flex-col gap-(--space-0-5) border-t border-stroke-1 py-(--space-2) first:border-t-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-(--space-3)"
      ),
    ],
    [label, value]
  );

const listLabel = (h: H, text: string): Html =>
  h.span(
    [
      h.Class(
        classNames("min-w-0 break-all text-ink-2", TYPE.ui, WEIGHT_MEDIUM)
      ),
    ],
    [text]
  );

const ledgerBody = (h: H, spend: Spend): ReadonlyArray<Html> => {
  const lines = modelLinesOf(spend);

  return [
    h.div(
      [h.DataAttribute("testid", "usage-spend-total")],
      [figureLine(h, spendFigureOf(spend), true)]
    ),
    lines.length === 0
      ? quiet(h, "No model has spent anything yet.")
      : h.ul(
          [h.AriaLabel("Spend by model"), h.Class("flex flex-col")],
          lines.map((line) =>
            listRow(
              h,
              [
                h.DataAttribute("testid", "usage-model"),
                h.DataAttribute("model", line.model),
                h.DataAttribute("priced", line.priced ? "true" : "false"),
              ],
              listLabel(h, line.model),
              h.span(
                [h.Class("flex min-w-0 flex-col sm:items-end")],
                [
                  reading(h, line.priced, line.price, TYPE.ui),
                  h.span(
                    [
                      h.Class(
                        classNames("text-ink-3 tabular-nums", TYPE.small)
                      ),
                    ],
                    [line.tokens]
                  ),
                ]
              )
            )
          )
        ),
  ];
};

const threadLedger = (
  h: H,
  threads: ReadonlyArray<MeteredThread>
): ReadonlyArray<Html> =>
  threads.length === 0
    ? [quiet(h, "No thread has spend recorded yet.")]
    : [
        h.ul(
          [h.AriaLabel("Spend by thread"), h.Class("flex flex-col")],
          threads.map((thread) =>
            listRow(
              h,
              [
                h.DataAttribute("testid", "usage-thread"),
                h.DataAttribute("thread-id", thread.threadId),
              ],
              h.a(
                [
                  h.Href(threadRouter({ threadId: thread.threadId })),
                  h.Class(
                    classNames(
                      "min-w-0 break-words text-ink-1 underline-offset-4 hover:underline",
                      TYPE.ui,
                      WEIGHT_MEDIUM
                    )
                  ),
                ],
                [thread.title]
              ),
              figureLine(h, summaryFigureOf(thread.spend))
            )
          )
        ),
      ];

const spendSection = (model: Model, h: H): Html =>
  card(
    h,
    {
      tone: "neutral",
      title: "Spend ledger",
      aside: [],
      body: [
        h.div(
          [h.Class("flex flex-col gap-(--space-3)")],
          [
            h.p(
              [h.Class(classNames("text-ink-3", TYPE.small))],
              [
                "Dollars are API list prices. A plan (Claude Code, OpenCode Go) bills nothing per token, so its figure is what the same tokens would cost on the API.",
              ]
            ),
            ...remoteBody(h, model.spend, "Spend", (spend) =>
              ledgerBody(h, spend)
            ),
            h.h4(
              [h.Class(classNames("text-ink-1", TYPE.ui, WEIGHT_STRONG))],
              ["By thread"]
            ),
            ...threadLedger(h, model.context.threads),
          ]
        ),
      ],
      actions: [],
    },
    [h.DataAttribute("testid", "usage-spend")]
  );

const windowMeter = (h: H, window: PlanWindow): Html => {
  const percent = windowPercentOf(window);

  const resets = Option.match(window.resetsAt, {
    onNone: () => "",
    onSome: (at) => `, resets ${formatDayTime(at)}`,
  });

  return h.div(
    [
      h.DataAttribute("window", window.id),
      h.DataAttribute("known", Option.isSome(percent) ? "true" : "false"),
    ],
    [
      meter(h, window.label, {
        value: percent,
        max: 100,
        warnAt: 0.75,
        // Read only while the value is known; an unknown reading shows the meter's own word.
        text: window.exhausted
          ? `Limited${resets}`
          : Option.match(percent, {
              onNone: () => "",
              onSome: (used) => `${String(used)}% used${resets}`,
            }),
      }),
    ]
  );
};

const planBody = (h: H, state: PlanState): ReadonlyArray<Html> =>
  Match.value(state).pipe(
    Match.discriminatorsExhaustive("kind")({
      waiting: () => [
        reading(h, false, "Unknown: no reading has arrived yet."),
      ],
      absent: ({ why }) => [reading(h, false, why)],
      unreadable: () => [
        reading(
          h,
          false,
          "Unknown: the last reading failed or changed shape, so its windows are not shown."
        ),
      ],
      unsupported: () => [
        reading(h, false, "This plan publishes no windows Cairn can read."),
      ],
      read: ({ windows }) =>
        windows.length === 0
          ? [reading(h, false, "Read, but it reported no windows.")]
          : windows.map((window) => windowMeter(h, window)),
    })
  );

const planCard = (
  h: H,
  provider: string,
  name: string,
  state: PlanState
): Html =>
  h.section(
    [
      h.DataAttribute("testid", "usage-plan"),
      h.DataAttribute("provider", provider),
      h.DataAttribute("plan-state", state.kind),
      h.Class(
        "flex min-w-0 flex-col gap-(--space-2) rounded-(--radius-small) border border-stroke-1 bg-surface-sunken p-(--space-3)"
      ),
    ],
    [
      h.h4([h.Class(classNames("text-ink-1", TYPE.ui, WEIGHT_STRONG))], [name]),
      ...planBody(h, state),
    ]
  );

const plansSection = (model: Model, h: H): Html => {
  const { usage } = model.context;

  const fixed = PLAN_PROVIDERS.map(([provider, name]) =>
    planCard(h, provider, name, planStateOf(usage, provider))
  );

  const others = otherPlanProviders(usage).map((provider) =>
    planCard(h, provider, provider, planStateOf(usage, provider))
  );

  return card(
    h,
    {
      tone: "neutral",
      title: "Plan windows",
      aside: [],
      body: [
        h.div(
          [h.Class("grid min-w-0 gap-(--space-3) lg:grid-cols-2")],
          [...fixed, ...others]
        ),
      ],
      actions: [],
    },
    [h.DataAttribute("testid", "usage-plans")]
  );
};

const budgetThreads = (
  h: H,
  threads: ReadonlyArray<MeteredThread>
): ReadonlyArray<Html> => {
  const rows = threads.flatMap((thread) =>
    Option.match(budgetWordOf(thread.spend.budget), {
      onNone: () => [],
      onSome: (word) => [
        listRow(
          h,
          [
            h.DataAttribute("testid", "usage-budget-thread"),
            h.DataAttribute("thread-id", thread.threadId),
            h.DataAttribute("budget", thread.spend.budget),
          ],
          h.span(
            [h.Class("flex min-w-0 flex-col gap-(--space-1)")],
            [
              listLabel(h, thread.title),
              statusChip(h, {
                tone: word.tone,
                mark: markOfTone(word.tone),
                word: word.word,
              }),
            ]
          ),
          figureLine(h, summaryFigureOf(thread.spend))
        ),
      ],
    })
  );

  return rows.length === 0
    ? [quiet(h, "No thread has a budget now.")]
    : [
        h.ul(
          [h.AriaLabel("Threads with a budget"), h.Class("flex flex-col")],
          rows
        ),
      ];
};

const budgetsSection = (model: Model, h: H): Html =>
  card(
    h,
    {
      tone: "neutral",
      title: "Budgets",
      aside: [],
      body: [
        h.div(
          [h.Class("flex flex-col gap-(--space-3)")],
          [
            h.h4(
              [h.Class(classNames("text-ink-1", TYPE.ui, WEIGHT_STRONG))],
              ["Default for a brief or workflow"]
            ),
            ...remoteBody(h, model.server, "The default budget", (settings) => [
              h.div(
                [h.DataAttribute("testid", "usage-default-budget")],
                [recordLines(h, budgetLinesOf(settings.defaultBudget))]
              ),
            ]),
            h.h4(
              [h.Class(classNames("text-ink-1", TYPE.ui, WEIGHT_STRONG))],
              ["Threads with a budget"]
            ),
            ...budgetThreads(h, model.context.threads),
          ]
        ),
      ],
      actions: [],
    },
    [h.DataAttribute("testid", "usage-budgets")]
  );

/** The usage page. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(
    [
      h.DataAttribute("testid", "usage-page"),
      h.Class(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-surface-ground"
      ),
    ],
    [
      h.div(
        [
          h.Class(
            "mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-(--space-4) p-(--space-4) sm:p-(--space-6)"
          ),
        ],
        [
          h.header(
            [
              h.Class(
                "flex min-w-0 flex-wrap items-baseline justify-between gap-(--space-2) max-md:ps-(--space-8)"
              ),
            ],
            [
              h.h1(
                [h.Class(classNames("text-ink-1", TYPE.title, WEIGHT_STRONG))],
                ["Usage"]
              ),
              h.a(
                [
                  h.DataAttribute("testid", "usage-roles-link"),
                  h.Href(settingsRouter()),
                  h.Class(
                    classNames(
                      "text-accent-text underline-offset-4 hover:underline",
                      TYPE.ui
                    )
                  ),
                ],
                ["Rebind roles in Settings"]
              ),
            ]
          ),
          spendSection(model, h),
          plansSection(model, h),
          budgetsSection(model, h),
        ]
      ),
    ]
  )
);
