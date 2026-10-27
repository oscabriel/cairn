// The settings page: one scroll of sections in t3code's settings geometry. General and Appearance
// are this device's settings (plus auto-settle, which the brain keeps); Notifications holds the push
// toggle the root passes in; Models and providers is read-only apart from the Claude switch, its
// generation cap and the title model; Skills shows the count and an estimate of the prompt they
// add, with Reload; Executor shows the link's state and a way to sign in again.

import type { ExecutorStatus } from "@cairn/protocol/Executor";
import type { ModelCatalog, ProviderStatus } from "@cairn/protocol/Models";
import type { ServerSettings } from "@cairn/protocol/Settings";
import type { SkillList, SkillSummary } from "@cairn/protocol/Skills";
import type { PlanWindow, ProviderUsage } from "@cairn/protocol/Usage";
import { Array, Option } from "effect";
import { Submodel } from "foldkit";
import * as AsyncData from "foldkit/asyncData";
import type { Html, HtmlBuilder } from "foldkit/html";

import { BRIDGE_PROVIDER } from "../composer/UsageMeter.ts";
import { badge } from "../ui/Badge.ts";
import { button, buttonDefaults } from "../ui/Button.ts";
import type { Child } from "../ui/Child.ts";
import { selectView } from "../ui/Select.ts";
import type { SelectOption } from "../ui/Select.ts";
import { switchView } from "../ui/Switch.ts";
import type {
  BooleanSettingKey,
  ChoiceSettingKey,
  ClientSettings,
} from "./ClientSettings.ts";
import {
  settingsHeader,
  settingsPage,
  settingsRow,
  settingsSection,
} from "./Layout.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { formatDayTime, formatUsed } from "./Time.ts";
import { modelValue } from "./Update.ts";

/** What the root passes in: the push toggle, built in the root's boundary. */
export interface SettingsViewInputs {
  readonly notifications: () => Html;
}

type H = HtmlBuilder<Message>;

const none = Option.none<string>();

// A control inside a row: the row's title already names it, so the widget's own label is for
// screen readers only.
const quietLabel = (h: H, control: Html): Html =>
  h.div([h.Class("[&_label]:sr-only [&_input]:hidden")], [control]);

const choice = (
  h: H,
  id: string,
  label: string,
  value: string,
  options: ReadonlyArray<SelectOption>,
  onChange: (value: string) => Message,
  isDisabled = false
): Html =>
  quietLabel(
    h,
    selectView(h, {
      id,
      label,
      value,
      options,
      isDisabled,
      onChange,
      size: "sm",
    })
  );

const toggle = (
  h: H,
  id: string,
  label: string,
  isChecked: boolean,
  onToggle: (isChecked: boolean) => Message,
  isDisabled = false
): Html =>
  quietLabel(
    h,
    switchView(h, {
      id,
      label,
      size: "default",
      isChecked,
      isDisabled,
      onToggle,
    })
  );

const clientChoice = (
  h: H,
  client: ClientSettings,
  key: ChoiceSettingKey,
  label: string,
  options: ReadonlyArray<SelectOption>
): Html =>
  choice(h, `settings-${key}`, label, String(client[key]), options, (value) =>
    Message.SelectedClientSetting({ key, value })
  );

const clientToggle = (
  h: H,
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

const row = (
  h: H,
  id: string,
  title: string,
  description: Option.Option<string>,
  control: Option.Option<Html>,
  status: Option.Option<Child> = Option.none()
): Html => settingsRow(h, { id, title, description, status, control });

/** What a section says while its answer is missing, or why it failed. */
const pending = <A>(
  h: H,
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
    .map((days) => ({
      value: String(days),
      label: autoSettleLabel(days),
    }));

const generalSection = (model: Model, h: H): Html => {
  const { client } = model;

  return settingsSection(
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

const appearanceSection = (model: Model, h: H): Html => {
  const { client } = model;

  return settingsSection(
    h,
    { id: "appearance", title: "Appearance", headerAction: Option.none() },
    [
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

const notificationsSection = (inputs: SettingsViewInputs, h: H): Html =>
  settingsSection(
    h,
    {
      id: "notifications",
      title: "Notifications",
      headerAction: Option.none(),
    },
    [h.div([h.Class("px-3 py-3 sm:px-4")], [inputs.notifications()])]
  );

const STATE_LABEL: Readonly<Record<ProviderStatus["state"], string>> = {
  ready: "Ready",
  missing: "No credential",
  refused: "Refused",
  unknown: "Unknown",
};

const STATE_BADGE: Readonly<
  Record<ProviderStatus["state"], "success" | "outline" | "warning">
> = {
  ready: "success",
  missing: "warning",
  refused: "warning",
  unknown: "outline",
};

const CREDENTIAL_LABEL: Readonly<Record<ProviderStatus["credential"], string>> =
  {
    "api-key": "API key",
    subscription: "Subscription",
    none: "No credential",
  };

const providerRow = (h: H, provider: ProviderStatus): Html =>
  row(
    h,
    `provider-${provider.provider}`,
    provider.name,
    Option.orElse(provider.detail, () =>
      Option.some(CREDENTIAL_LABEL[provider.credential])
    ),
    Option.some(
      badge(
        h,
        STATE_BADGE[provider.state],
        "default",
        [h.DataAttribute("testid", `provider-state-${provider.provider}`)],
        [STATE_LABEL[provider.state]]
      )
    )
  );

const windowLine = (h: H, window: PlanWindow, client: ClientSettings): Html =>
  h.li(
    [
      h.DataAttribute("testid", `plan-window-${window.id}`),
      h.Class("flex flex-col gap-1 py-1.5"),
    ],
    [
      h.div(
        [h.Class("flex items-center justify-between gap-3 text-xs")],
        [
          h.span([h.Class("text-foreground")], [window.label]),
          h.span(
            [
              h.Class(
                window.exhausted ? "text-warning" : "text-muted-foreground"
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
        [h.Class("h-1 overflow-hidden rounded-full bg-muted")],
        [
          h.div([
            h.Class(
              window.exhausted ? "h-full bg-warning" : "h-full bg-primary"
            ),
            h.Style({
              width: `${Math.round(Option.getOrElse(window.used, () => 0) * 100)}%`,
            }),
          ]),
        ]
      ),
    ]
  );

const planWindows = (h: H, model: Model): Html => {
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
            [h.Class("pb-2")],
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

const bridgeRows = (h: H, settings: ServerSettings): ReadonlyArray<Html> => [
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
  h: H,
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

const modelList = (h: H, catalog: ModelCatalog): Html =>
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
          h.Class("flex flex-col pb-2"),
        ],
        catalog.models.map((listing) =>
          h.li(
            [
              h.Key(modelValue(listing)),
              h.Class(
                listing.available
                  ? "flex items-center justify-between gap-3 py-1 text-xs"
                  : "flex items-center justify-between gap-3 py-1 text-xs opacity-64"
              ),
            ],
            [
              h.span(
                [h.Class("min-w-0 truncate text-foreground")],
                [listing.name]
              ),
              h.span(
                [h.Class("shrink-0 font-mono text-muted-foreground")],
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

const modelsSection = (model: Model, h: H): Html =>
  settingsSection(
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

// formatSkillsForPrompt in pi-coding-agent 1.4.0 (core/skills.js): a fixed preamble of about 380
// characters, then per skill its name, description, file path and about 70 characters of tags.
// The path is not on the wire, so an average is assumed.
const PREAMBLE_CHARS = 380;

const PER_SKILL_CHARS = 70 + 60;

/** About how many tokens the skills add to the system prompt (4 characters a token). */
export const skillsPromptTokens = (
  skills: ReadonlyArray<SkillSummary>
): number => {
  const invocable = skills.filter((skill) => skill.modelInvocable);

  if (invocable.length === 0) {
    return 0;
  }

  const chars = invocable.reduce(
    (total, skill) =>
      total + PER_SKILL_CHARS + skill.name.length + skill.description.length,
    PREAMBLE_CHARS
  );

  return Math.round(chars / 4);
};

const skillsSummary = (list: SkillList): string => {
  const total = list.skills.length;
  const invocable = list.skills.filter((skill) => skill.modelInvocable).length;
  const tokens = skillsPromptTokens(list.skills);

  return total === 0
    ? "No skills found."
    : `${total} ${total === 1 ? "skill" : "skills"}, ${invocable} in the model's prompt (about ${tokens.toLocaleString()} tokens).`;
};

const skillsSection = (model: Model, h: H): Html => {
  const reload = button(
    h,
    {
      ...buttonDefaults<Message>(),
      variant: "outline",
      size: "sm",
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

  return settingsSection(
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

const executorSection = (model: Model, h: H): Html =>
  settingsSection(
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
                  status.state === "needs-sign-in" ? "default" : "outline",
                size: "sm",
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

const noticeView = (model: Model, h: H): Html =>
  Option.match(model.notice, {
    onNone: () => h.empty,
    onSome: (notice) =>
      h.div(
        [
          h.DataAttribute("testid", "settings-notice"),
          h.Role("status"),
          h.Class(
            "flex items-start justify-between gap-3 rounded-xl border border-warning/32 bg-warning/8 px-3 py-2 text-sm sm:px-4"
          ),
        ],
        [
          h.span([], [notice]),
          button(
            h,
            {
              ...buttonDefaults<Message>(),
              variant: "ghost",
              size: "xs",
              onClick: Option.some(Message.DismissedNotice()),
            },
            ["Dismiss"]
          ),
        ]
      ),
  });

/** The settings page, as the root embeds it with `h.submodel`. */
export const view = Submodel.defineView<Model, Message, SettingsViewInputs>(
  (model, inputs, h) =>
    h.div(
      [
        h.DataAttribute("testid", "settings-page"),
        h.Class("flex min-h-0 min-w-0 flex-1 flex-col"),
      ],
      [
        settingsHeader(h),
        settingsPage(h, [
          h.h1([h.Class("sr-only")], ["Settings"]),
          noticeView(model, h),
          generalSection(model, h),
          appearanceSection(model, h),
          notificationsSection(inputs, h),
          modelsSection(model, h),
          skillsSection(model, h),
          executorSection(model, h),
        ]),
      ]
    )
);
