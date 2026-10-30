// The `next` settings page (plan look track L7): classic's page (`settings/View.ts`, over the
// settings Submodel, its Messages and update) in the Stone look, under L6's chat header, which
// already says "Settings", so the page draws no header of its own. Sections are titled groups of
// rows on one raised box with hairlines between rows; each row has its title, what it does, and
// its control (a select or a switch, `Controls.ts`) on the right, or under it when the page is
// narrow. Statuses are status chips (a provider ready, a credential missing); plan windows are
// grey bars, with the waiting tone only on a spent one.
//
// Classic draws no row for which views draw the app (it would change its page); this page does:
// "Views", Next or Classic, so the phone can go back without editing the address (ADR 0040).

import { skillsPromptTokens } from "@cairn/client-logic/SkillsPrompt";
import type { ExecutorStatus } from "@cairn/protocol/Executor";
import type { ModelCatalog, ProviderStatus } from "@cairn/protocol/Models";
import type { ServerSettings } from "@cairn/protocol/Settings";
import type { SkillList } from "@cairn/protocol/Skills";
import type { PlanWindow, ProviderUsage } from "@cairn/protocol/Usage";
import { Array, Option } from "effect";
import { Submodel } from "foldkit";
import * as AsyncData from "foldkit/asyncData";
import type { Html, HtmlBuilder } from "foldkit/html";

import { BRIDGE_PROVIDER } from "../../composer/UsageMeter.ts";
import type {
  BooleanSettingKey,
  ChoiceSettingKey,
  ClientSettings,
} from "../../settings/ClientSettings.ts";
import { Message } from "../../settings/Message.ts";
import type { Model } from "../../settings/Model.ts";
import { formatDayTime, formatUsed } from "../../settings/Time.ts";
import { modelValue } from "../../settings/Update.ts";
import type { SettingsViewInputs } from "../../settings/View.ts";
import type { Child } from "../../ui/Child.ts";
import { classNames } from "../../ui/ClassNames.ts";
import type { SelectOption } from "../../ui/Select.ts";
import { button, buttonDefaults } from "../ui/Button.ts";
import { TYPE, WEIGHT_MEDIUM, WEIGHT_STRONG } from "../ui/Classes.ts";
import type { StatusMark } from "../ui/Glyph.ts";
import { statusChip } from "../ui/StatusChip.ts";
import type { Tone } from "../ui/Tone.ts";
import { select, switchControl } from "./Controls.ts";

const none = Option.none<string>();

// ---------------------------------------------------------------------------------------------
// Layout

/** The page: its own scroll, a readable column, the sections apart. */
const page = (h: HtmlBuilder<Message>, children: ReadonlyArray<Child>): Html =>
  h.div(
    [h.Class("flex min-h-0 flex-1 flex-col")],
    [
      h.div(
        [
          h.DataAttribute("settings-page-scroll", ""),
          h.Class(
            "flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]"
          ),
        ],
        [
          h.div(
            [
              h.Class(
                "mx-auto flex w-full max-w-3xl flex-col gap-(--space-8) px-(--space-3) pt-(--space-6) pb-(--space-12) sm:px-(--space-6)"
              ),
            ],
            children
          ),
        ]
      ),
    ]
  );

/** A titled section whose rows share one raised box, a hairline between rows. */
const section = (
  h: HtmlBuilder<Message>,
  config: {
    readonly id: string;
    readonly title: string;
    readonly headerAction: Option.Option<Html>;
  },
  rows: ReadonlyArray<Child>
): Html =>
  h.section(
    [
      h.Id(config.id),
      h.DataAttribute("testid", `settings-section-${config.id}`),
      h.Class("flex flex-col gap-(--space-2)"),
    ],
    [
      h.div(
        [
          h.DataAttribute("settings-scroll-target", ""),
          h.Class(
            "flex min-h-7 items-center justify-between gap-(--space-4) px-(--space-1)"
          ),
        ],
        [
          h.h2(
            [h.Class(classNames("text-ink-2", TYPE.ui, WEIGHT_MEDIUM))],
            [config.title]
          ),
          Option.getOrElse(config.headerAction, () => h.empty),
        ]
      ),
      h.div(
        [
          h.Class(
            "overflow-hidden rounded-(--radius-large) border border-stroke-1 bg-surface-raised [&>*+*]:border-t [&>*+*]:border-stroke-1"
          ),
        ],
        rows
      ),
    ]
  );

/** A row: its title, what it does and its status on the left, its control on the right. */
const settingsRow = (
  h: HtmlBuilder<Message>,
  config: {
    readonly id: string;
    readonly title: string;
    readonly description: Option.Option<string>;
    readonly status: Option.Option<Child>;
    readonly control: Option.Option<Html>;
  },
  children: ReadonlyArray<Child> = []
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "settings-row"),
      h.DataAttribute("settings-row", config.id),
      h.Class("@container/settings-row px-(--space-4) py-(--space-3)"),
    ],
    [
      h.div(
        [
          h.Class(
            "flex flex-col gap-(--space-2) @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-(--space-4)"
          ),
        ],
        [
          h.div(
            [h.Class("flex min-w-0 flex-col gap-(--space-0-5)")],
            [
              h.h3(
                [h.Class(classNames("text-ink-1", TYPE.ui, WEIGHT_MEDIUM))],
                [config.title]
              ),
              Option.match(config.description, {
                onNone: () => h.empty,
                onSome: (description) =>
                  h.p(
                    [h.Class(classNames("max-w-xl text-ink-2", TYPE.small))],
                    [description]
                  ),
              }),
              Option.match(config.status, {
                onNone: () => h.empty,
                onSome: (status) =>
                  h.div(
                    [
                      h.DataAttribute("testid", `settings-status-${config.id}`),
                      h.Class(classNames("text-ink-3", TYPE.small)),
                    ],
                    [status]
                  ),
              }),
            ]
          ),
          Option.match(config.control, {
            onNone: () => h.empty,
            onSome: (control) =>
              h.div(
                [
                  h.Class(
                    "flex w-full min-w-0 items-center gap-(--space-2) @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end"
                  ),
                ],
                [control]
              ),
          }),
        ]
      ),
      ...children,
    ]
  );

const row = (
  h: HtmlBuilder<Message>,
  id: string,
  title: string,
  description: Option.Option<string>,
  control: Option.Option<Html>,
  status: Option.Option<Child> = Option.none()
): Html => settingsRow(h, { id, title, description, status, control });

// ---------------------------------------------------------------------------------------------
// Controls

const choice = (
  h: HtmlBuilder<Message>,
  id: string,
  label: string,
  value: string,
  options: ReadonlyArray<SelectOption>,
  onChange: (value: string) => Message,
  isDisabled = false
): Html => select(h, { id, label, value, options, isDisabled, onChange });

const toggle = (
  h: HtmlBuilder<Message>,
  id: string,
  label: string,
  isChecked: boolean,
  onToggle: (isChecked: boolean) => Message
): Html =>
  switchControl(h, {
    id,
    label,
    showLabel: false,
    isChecked,
    isDisabled: false,
    onToggle,
  });

const clientChoice = (
  h: HtmlBuilder<Message>,
  client: ClientSettings,
  key: ChoiceSettingKey,
  label: string,
  options: ReadonlyArray<SelectOption>
): Html =>
  choice(h, `settings-${key}`, label, String(client[key]), options, (value) =>
    Message.SelectedClientSetting({ key, value })
  );

const clientToggle = (
  h: HtmlBuilder<Message>,
  client: ClientSettings,
  key: BooleanSettingKey,
  label: string
): Html =>
  toggle(h, `settings-${key}`, label, client[key], (isChecked) =>
    Message.ToggledClientSetting({ key, isChecked })
  );

const sizes = (from: number, to: number): ReadonlyArray<SelectOption> =>
  Array.range(from, to).map((size) => ({
    value: String(size),
    label: `${size}px`,
  }));

/** What a section says while its answer is missing, or why it failed. */
const pending = <A>(
  h: HtmlBuilder<Message>,
  id: string,
  data: AsyncData.AsyncData<A, string>,
  onData: (value: A) => ReadonlyArray<Html>
): ReadonlyArray<Html> =>
  AsyncData.matchData(data, {
    onEmpty: () => [
      row(
        h,
        `${id}-loading`,
        "Loading",
        Option.some("Asking the brain."),
        Option.none()
      ),
    ],
    onFailure: (message) => [
      row(
        h,
        `${id}-failed`,
        "Not available",
        Option.some(message),
        Option.none()
      ),
    ],
    onData,
  });

// ---------------------------------------------------------------------------------------------
// Sections

const AUTO_SETTLE_DAYS = [0, 1, 3, 7, 14, 30] as const;

const autoSettleLabel = (days: number): string => {
  if (days === 0) {
    return "Never";
  }

  return days === 1 ? "After 1 day" : `After ${days} days`;
};

const autoSettleOptions = (current: number): ReadonlyArray<SelectOption> =>
  Array.dedupe([...AUTO_SETTLE_DAYS, current])
    .toSorted((left, right) => left - right)
    .map((days) => ({ value: String(days), label: autoSettleLabel(days) }));

const generalSection = (model: Model, h: HtmlBuilder<Message>): Html => {
  const { client } = model;

  return section(
    h,
    { id: "general", title: "General", headerAction: Option.none() },
    [
      row(
        h,
        "send-shortcut",
        "Send shortcut",
        Option.some("What Enter does in the composer."),
        Option.some(
          clientChoice(h, client, "sendShortcut", "Send shortcut", [
            { value: "enter", label: "Enter sends" },
            {
              value: "mod-enter-multiline",
              label: "Mod+Enter sends, Enter adds a line",
            },
            { value: "mod-enter", label: "Mod+Enter sends" },
          ])
        )
      ),
      row(
        h,
        "follow-up",
        "Follow-up behaviour",
        Option.some("What a message sent during a run does."),
        Option.some(
          clientChoice(h, client, "followUpBehavior", "Follow-up behaviour", [
            { value: "queue", label: "Queue after the run" },
            { value: "steer", label: "Steer the run" },
          ])
        )
      ),
      row(
        h,
        "timestamp-format",
        "Timestamp format",
        none,
        Option.some(
          clientChoice(h, client, "timestampFormat", "Timestamp format", [
            { value: "locale", label: "System default" },
            { value: "12-hour", label: "12-hour" },
            { value: "24-hour", label: "24-hour" },
          ])
        )
      ),
      row(
        h,
        "confirm-delete",
        "Confirm thread deletion",
        Option.some("Ask before a thread is deleted."),
        Option.some(
          clientToggle(
            h,
            client,
            "confirmThreadDelete",
            "Confirm thread deletion"
          )
        )
      ),
      row(
        h,
        "composer-collapse",
        "Collapse the composer on scroll",
        Option.some("Fold the composer while the transcript scrolls up."),
        Option.some(
          clientToggle(
            h,
            client,
            "composerCollapseOnScroll",
            "Collapse the composer on scroll"
          )
        )
      ),
      ...pending(h, "auto-settle", model.server, (settings: ServerSettings) => [
        row(
          h,
          "auto-settle",
          "Auto-settle",
          Option.some(
            "Quiet threads move to the settled shelf on every device."
          ),
          Option.some(
            choice(
              h,
              "settings-auto-settle",
              "Auto-settle",
              String(settings.autoSettleDays),
              autoSettleOptions(settings.autoSettleDays),
              (value) => Message.SelectedAutoSettleDays({ value })
            )
          )
        ),
      ]),
    ]
  );
};

const appearanceSection = (model: Model, h: HtmlBuilder<Message>): Html => {
  const { client } = model;

  return section(
    h,
    { id: "appearance", title: "Appearance", headerAction: Option.none() },
    [
      row(
        h,
        "ui",
        "Views",
        Option.some(
          "Next draws Cairn in the new look; Classic is the look it had before. Each device keeps its own."
        ),
        Option.some(
          clientChoice(h, client, "ui", "Views", [
            { value: "next", label: "Next" },
            { value: "classic", label: "Classic" },
          ])
        )
      ),
      row(
        h,
        "theme",
        "Theme",
        none,
        Option.some(
          clientChoice(h, client, "theme", "Theme", [
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ])
        )
      ),
      row(
        h,
        "font-size-interface",
        "Interface font size",
        none,
        Option.some(
          clientChoice(
            h,
            client,
            "fontSizeInterface",
            "Interface font size",
            sizes(12, 20)
          )
        )
      ),
      row(
        h,
        "font-size-prompt",
        "Composer font size",
        none,
        Option.some(
          clientChoice(
            h,
            client,
            "fontSizePrompt",
            "Composer font size",
            sizes(12, 20)
          )
        )
      ),
      row(
        h,
        "font-size-code",
        "Code font size",
        none,
        Option.some(
          clientChoice(
            h,
            client,
            "fontSizeCode",
            "Code font size",
            sizes(10, 18)
          )
        )
      ),
      row(
        h,
        "chat-width",
        "Chat width",
        none,
        Option.some(
          clientChoice(h, client, "chatWidth", "Chat width", [
            { value: "comfortable", label: "Comfortable" },
            { value: "wide", label: "Wide" },
            { value: "full", label: "Full" },
          ])
        )
      ),
      row(
        h,
        "diff-layout",
        "Diff layout",
        none,
        Option.some(
          clientChoice(h, client, "diffLayout", "Diff layout", [
            { value: "stacked", label: "Stacked" },
            { value: "split", label: "Side by side" },
          ])
        )
      ),
    ]
  );
};

const notificationsSection = (
  inputs: SettingsViewInputs,
  h: HtmlBuilder<Message>
): Html =>
  section(
    h,
    {
      id: "notifications",
      title: "Notifications",
      headerAction: Option.none(),
    },
    [
      h.div(
        [h.Class("px-(--space-4) py-(--space-3)")],
        [inputs.notifications()]
      ),
    ]
  );

const STATE_LABEL: Readonly<Record<ProviderStatus["state"], string>> = {
  ready: "Ready",
  missing: "No credential",
  refused: "Refused",
  unknown: "Unknown",
};

const STATE_TONE: Readonly<Record<ProviderStatus["state"], Tone>> = {
  ready: "done",
  missing: "waiting",
  refused: "failed",
  unknown: "neutral",
};

const STATE_MARK: Readonly<Record<ProviderStatus["state"], StatusMark>> = {
  ready: "done",
  missing: "needs",
  refused: "failed",
  unknown: "idle",
};

const CREDENTIAL_LABEL: Readonly<Record<ProviderStatus["credential"], string>> =
  {
    "api-key": "API key",
    subscription: "Subscription",
    none: "No credential",
  };

const providerRow = (h: HtmlBuilder<Message>, provider: ProviderStatus): Html =>
  row(
    h,
    `provider-${provider.provider}`,
    provider.name,
    Option.orElse(provider.detail, () =>
      Option.some(CREDENTIAL_LABEL[provider.credential])
    ),
    Option.some(
      statusChip(
        h,
        {
          tone: STATE_TONE[provider.state],
          mark: STATE_MARK[provider.state],
          word: STATE_LABEL[provider.state],
        },
        [h.DataAttribute("testid", `provider-state-${provider.provider}`)]
      )
    )
  );

const windowLine = (
  h: HtmlBuilder<Message>,
  window: PlanWindow,
  client: ClientSettings
): Html =>
  h.li(
    [
      h.DataAttribute("testid", `plan-window-${window.id}`),
      h.Class("flex flex-col gap-(--space-1) py-(--space-1-5)"),
    ],
    [
      h.div(
        [
          h.Class(
            classNames(
              "flex items-center justify-between gap-(--space-3)",
              TYPE.small
            )
          ),
        ],
        [
          h.span([h.Class("text-ink-1")], [window.label]),
          h.span(
            [
              h.Class(
                window.exhausted
                  ? "text-tone-waiting"
                  : "text-ink-2 tabular-nums"
              ),
            ],
            [
              window.exhausted ? "Limited" : `${formatUsed(window.used)} used`,
              ...Option.match(window.resetsAt, {
                onNone: () => [],
                onSome: (at) => [
                  `, resets ${formatDayTime(at, client.timestampFormat)}`,
                ],
              }),
            ]
          ),
        ]
      ),
      h.div(
        [h.Class("h-1 overflow-hidden rounded-(--radius-round) bg-select-2")],
        [
          h.div([
            h.Class(
              window.exhausted ? "h-full bg-tone-waiting" : "h-full bg-ink-2"
            ),
            h.Style({
              width: `${Math.round(Option.getOrElse(window.used, () => 0) * 100)}%`,
            }),
          ]),
        ]
      ),
    ]
  );

const planWindows = (h: HtmlBuilder<Message>, model: Model): Html => {
  const usage: Option.Option<ProviderUsage> = Option.flatMap(
    model.usage,
    (snapshot) =>
      Array.findFirst(
        snapshot.providers,
        (provider) => provider.provider === BRIDGE_PROVIDER
      )
  );

  return Option.match(usage, {
    onNone: () =>
      row(
        h,
        "plan-windows",
        "Claude plan windows",
        Option.some(
          "No plan windows reported yet. They appear once Claude is set up and probed."
        ),
        Option.none()
      ),
    onSome: (provider) =>
      settingsRow(
        h,
        {
          id: "plan-windows",
          title: "Claude plan windows",
          description: Option.some(
            "How much of each Claude subscription window is spent."
          ),
          status: Option.map(
            provider.checkedAt,
            (at) => `Checked ${formatDayTime(at, model.client.timestampFormat)}`
          ),
          control: Option.none(),
        },
        [
          h.ul(
            [h.Class("pt-(--space-1)")],
            provider.windows.map((window) =>
              windowLine(h, window, model.client)
            )
          ),
        ]
      ),
  });
};

const GENERATION_CAPS = Array.range(1, 16).map((cap) => ({
  value: String(cap),
  label: cap === 1 ? "1 at a time" : `${cap} at a time`,
}));

const bridgeRows = (
  h: HtmlBuilder<Message>,
  settings: ServerSettings
): ReadonlyArray<Html> => [
  row(
    h,
    "bridge-enabled",
    "Claude through the subscription",
    Option.some(
      "Offers Claude models through Claude Code. Off, no new Claude turn starts; threads already on Claude keep their history."
    ),
    Option.some(
      toggle(
        h,
        "settings-bridge-enabled",
        "Claude through the subscription",
        settings.bridgeEnabled,
        (isChecked) => Message.ToggledBridge({ isChecked })
      )
    )
  ),
  row(
    h,
    "bridge-cap",
    "Claude generations at once",
    Option.some("More wait for a Claude slot."),
    Option.some(
      choice(
        h,
        "settings-bridge-cap",
        "Claude generations at once",
        String(settings.bridgeGenerationCap),
        GENERATION_CAPS,
        (value) => Message.SelectedGenerationCap({ value }),
        !settings.bridgeEnabled
      )
    )
  ),
];

const titleModelRow = (
  h: HtmlBuilder<Message>,
  settings: ServerSettings,
  catalog: ModelCatalog
): Html =>
  row(
    h,
    "title-model",
    "Title model",
    Option.some("The model that names new threads and their branches."),
    Option.some(
      choice(
        h,
        "settings-title-model",
        "Title model",
        Option.match(settings.titleModel, {
          onNone: () => "",
          onSome: modelValue,
        }),
        [
          { value: "", label: "First line of the message" },
          ...catalog.models
            .filter((listing) => listing.available)
            .map((listing) => ({
              value: modelValue(listing),
              label: listing.name,
            })),
        ],
        (value) => Message.SelectedTitleModel({ value })
      )
    )
  );

const modelList = (h: HtmlBuilder<Message>, catalog: ModelCatalog): Html =>
  settingsRow(
    h,
    {
      id: "models",
      title: "Models",
      description: Option.some(
        `${catalog.models.length} ${catalog.models.length === 1 ? "model" : "models"} from pi's configuration. New threads start on ${catalog.defaults.model.provider}/${catalog.defaults.model.modelId}.`
      ),
      status: Option.none(),
      control: Option.none(),
    },
    [
      h.ul(
        [
          h.DataAttribute("testid", "settings-model-list"),
          h.Class("flex flex-col pt-(--space-1)"),
        ],
        catalog.models.map((listing) =>
          h.li(
            [
              h.Key(modelValue(listing)),
              h.Class(
                classNames(
                  "flex items-center justify-between gap-(--space-3) py-(--space-1)",
                  TYPE.small,
                  listing.available ? "" : "opacity-60"
                )
              ),
            ],
            [
              h.span([h.Class("min-w-0 truncate text-ink-1")], [listing.name]),
              h.span(
                [
                  h.Class(
                    "min-w-0 truncate font-(family-name:--font-code) text-ink-3"
                  ),
                ],
                [
                  listing.available
                    ? modelValue(listing)
                    : `${modelValue(listing)} (no credential)`,
                ]
              ),
            ]
          )
        )
      ),
    ]
  );

const modelsSection = (model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    h,
    {
      id: "models",
      title: "Models and providers",
      headerAction: Option.none(),
    },
    [
      ...pending(h, "providers", model.providers, (providers) =>
        providers.map((provider) => providerRow(h, provider))
      ),
      planWindows(h, model),
      ...pending(h, "bridge", model.server, (settings) =>
        bridgeRows(h, settings)
      ),
      ...pending(h, "catalog", model.catalog, (catalog) => [
        ...Option.match(AsyncData.getData(model.server), {
          onNone: () => [],
          onSome: (settings) => [titleModelRow(h, settings, catalog)],
        }),
        modelList(h, catalog),
      ]),
    ]
  );

const skillsSummary = (list: SkillList): string => {
  const total = list.skills.length;
  const invocable = list.skills.filter((skill) => skill.modelInvocable).length;
  const tokens = skillsPromptTokens(list.skills);

  return total === 0
    ? "No skills found."
    : `${total} ${total === 1 ? "skill" : "skills"}, ${invocable} in the model's prompt (about ${tokens.toLocaleString()} tokens).`;
};

const skillsSection = (model: Model, h: HtmlBuilder<Message>): Html => {
  const reload = button(
    h,
    {
      ...buttonDefaults<Message>(),
      size: "small",
      onClick: Option.some(Message.ClickedReloadSkills()),
      isDisabled:
        !model.context.hasClient ||
        Option.isNone(model.skillsProject) ||
        AsyncData.isPending(model.skills),
    },
    ["Reload"]
  );

  const projectPicker =
    model.context.projects.length > 1
      ? [
          row(
            h,
            "skills-project",
            "Project",
            Option.some(
              "Skills come from pi's configuration and the project's .agents/skills."
            ),
            Option.some(
              choice(
                h,
                "settings-skills-project",
                "Project",
                Option.match(model.skillsProject, {
                  onNone: () => "",
                  onSome: String,
                }),
                model.context.projects.map((project) => ({
                  value: project.id,
                  label: project.title,
                })),
                (value) => Message.SelectedSkillsProject({ value })
              )
            )
          ),
        ]
      : [];

  return section(
    h,
    { id: "skills", title: "Skills", headerAction: Option.some(reload) },
    [
      ...projectPicker,
      ...Option.match(model.skillsProject, {
        onNone: () => [
          row(
            h,
            "skills-none",
            "No project",
            Option.some("Add a project to see its skills."),
            Option.none()
          ),
        ],
        onSome: () =>
          pending(h, "skills", model.skills, (list) => [
            row(
              h,
              "skills-count",
              "Skills",
              Option.some(skillsSummary(list)),
              Option.none()
            ),
          ]),
      }),
    ]
  );
};

const EXECUTOR_LABEL: Readonly<Record<ExecutorStatus["state"], string>> = {
  connected: "Connected",
  "needs-sign-in": "Needs sign-in",
  unreachable: "Unreachable",
  disabled: "Off",
};

const executorSection = (model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    h,
    { id: "executor", title: "Executor", headerAction: Option.none() },
    [
      ...pending(h, "executor", model.executor, (status) => [
        row(
          h,
          "executor-status",
          "Executor",
          Option.orElse(status.detail, () =>
            Option.some("Tools from Executor are offered to every thread.")
          ),
          Option.some(
            button(
              h,
              {
                ...buttonDefaults<Message>(),
                variant:
                  status.state === "needs-sign-in" ? "primary" : "secondary",
                size: "small",
                onClick: Option.some(Message.ClickedSignIn()),
                isDisabled:
                  !model.context.hasClient || status.state === "disabled",
              },
              ["Sign in again"]
            )
          ),
          Option.some(
            h.span(
              [h.DataAttribute("testid", "executor-state")],
              [
                EXECUTOR_LABEL[status.state],
                ...Option.match(status.checkedAt, {
                  onNone: () => [],
                  onSome: (at) => [
                    `, checked ${formatDayTime(at, model.client.timestampFormat)}`,
                  ],
                }),
              ]
            )
          )
        ),
      ]),
    ]
  );

const noticeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.notice, {
    onNone: () => h.empty,
    onSome: (notice) =>
      h.div(
        [
          h.DataAttribute("testid", "settings-notice"),
          h.Role("status"),
          h.Class(
            classNames(
              "flex items-center justify-between gap-(--space-3) rounded-(--radius-medium) border border-stroke-2 bg-tone-waiting-wash px-(--space-4) py-(--space-2) text-ink-1",
              TYPE.ui
            )
          ),
        ],
        [
          h.span([], [notice]),
          button(
            h,
            {
              ...buttonDefaults<Message>(),
              variant: "ghost",
              size: "small",
              onClick: Option.some(Message.DismissedNotice()),
            },
            ["Dismiss"]
          ),
        ]
      ),
  });

/** The `next` settings page, as the frame embeds it with `h.submodel`. */
export const view = Submodel.defineView<Model, Message, SettingsViewInputs>(
  (model, inputs, h) =>
    h.div(
      [
        h.DataAttribute("testid", "settings-page"),
        h.Class("flex min-h-0 min-w-0 flex-1 flex-col bg-surface-ground"),
      ],
      [
        page(h, [
          h.h1([h.Class(classNames("sr-only", WEIGHT_STRONG))], ["Settings"]),
          noticeView(model, h),
          generalSection(model, h),
          appearanceSection(model, h),
          notificationsSection(inputs, h),
          modelsSection(model, h),
          inputs.roleTable(),
          skillsSection(model, h),
          executorSection(model, h),
        ]),
      ]
    )
);
