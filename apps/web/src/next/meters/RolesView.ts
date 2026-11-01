// The role table editor (plan wave 6, 6G; ADR 0035, models note M3 and M10), drawn in the `next`
// look as a section of the settings page, in the page's own section and row shape. Each role shows
// what it resolves to now (`roles.check`: ready, on its fallback, or why no model is ready, such as
// a Codex binding with no Codex login), and two selects, which show what it is bound to and rebind
// it: a model from the catalog and a thinking level. A change saves the whole table at once and the row shows the brain's answer; one change
// is in flight at a time. A link leads to the usage page.

import {
  modelChoicesOf,
  modelText,
  roleStatusOf,
  rolesOf,
  thinkingChoicesOf,
} from "@cairn/client-logic/Meters";
import type { ModelListing } from "@cairn/protocol/Models";
import { ThinkingLevel } from "@cairn/protocol/Models";
import type {
  RoleBinding,
  RoleCheck,
  RoleName,
  RoleTable,
} from "@cairn/protocol/Roles";
import * as Select from "@foldkit/ui/select";
import { Array, Option } from "effect";
import { Submodel } from "foldkit";
import * as AsyncData from "foldkit/asyncData";
import type { Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import { button, buttonDefaults } from "../ui/Button.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_RING,
  HIT_HEIGHT,
  TYPE,
  WEIGHT_MEDIUM,
} from "../ui/Classes.ts";
import { markOfTone } from "../ui/Glyph.ts";
import { statusChip } from "../ui/StatusChip.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";

type H = HtmlBuilder<Message>;

const SELECT = classNames(
  "h-8 w-auto min-w-28 max-w-full cursor-pointer rounded-(--radius-small) border border-stroke-2 bg-surface-sunken px-(--space-2) text-ink-1 disabled:cursor-not-allowed disabled:opacity-50",
  TYPE.ui,
  HIT_HEIGHT,
  FOCUS_RING,
  FEEDBACK_MOTION
);

/** A select's id for `role`: the role's name without its `@`. */
const idOf = (role: RoleName, what: string): string =>
  `role-${what}-${role.slice(1)}`;

const choiceSelect = (
  h: H,
  config: {
    readonly id: string;
    readonly label: string;
    readonly value: string;
    readonly options: ReadonlyArray<readonly [string, string]>;
    readonly isDisabled: boolean;
    readonly onChange: (value: string) => Message;
  }
): Html =>
  Select.view(
    {
      id: config.id,
      value: config.value,
      isDisabled: config.isDisabled,
      onChange: config.onChange,
      toView: (attributes) =>
        h.div(
          [h.Class("flex min-w-0 max-w-full")],
          [
            h.label([...attributes.label, h.Class("sr-only")], [config.label]),
            h.select(
              [...attributes.select, h.Class(SELECT)],
              config.options.map(([value, label]) =>
                h.option(
                  [
                    h.Key(value),
                    h.Value(value),
                    h.Selected(value === config.value),
                  ],
                  [label]
                )
              )
            ),
          ]
        ),
    },
    h
  );

const checkOf = (
  checks: ReadonlyArray<RoleCheck>,
  role: RoleName
): Option.Option<RoleCheck> =>
  Array.findFirst(checks, (check) => check.spec === role);

const statusLine = (
  model: Model,
  h: H,
  role: RoleName
): ReadonlyArray<Html> => {
  if (Option.contains(model.saving, role)) {
    return [statusChip(h, { tone: "working", mark: "busy", word: "Saving" })];
  }

  return Option.match(
    Option.flatMap(AsyncData.getData(model.checks), (checks) =>
      checkOf(checks, role)
    ),
    {
      onNone: () => [
        h.span(
          [h.Class(classNames("text-ink-3 italic", TYPE.small))],
          [AsyncData.isFailure(model.checks) ? "Not checked" : "Checking"]
        ),
      ],
      onSome: (check) => {
        const status = roleStatusOf(check);

        return [
          statusChip(
            h,
            {
              tone: status.tone,
              mark: markOfTone(status.tone),
              word: status.word,
            },
            [h.DataAttribute("role-status", status.tone)]
          ),
        ];
      },
    }
  );
};

const detailLine = (model: Model, h: H, role: RoleName): Html =>
  Option.match(
    Option.flatMap(
      Option.flatMap(AsyncData.getData(model.checks), (checks) =>
        checkOf(checks, role)
      ),
      (check) => roleStatusOf(check).detail
    ),
    {
      onNone: () => h.empty,
      onSome: (detail) =>
        h.p(
          [
            h.DataAttribute("role-detail", ""),
            h.Class(classNames("min-w-0 break-words text-ink-2", TYPE.small)),
          ],
          [detail]
        ),
    }
  );

const roleRow = (
  model: Model,
  h: H,
  catalog: ReadonlyArray<ModelListing>,
  role: RoleName,
  binding: RoleBinding
): Html => {
  const isDisabled = Option.isSome(model.saving);

  const models = modelChoicesOf(catalog, binding.model).map(
    (choice) => [choice.value, choice.label] as const
  );

  const levels: ReadonlyArray<readonly [string, string]> = [
    ["", "Model default"],
    ...thinkingChoicesOf(catalog, binding.model, ThinkingLevel.literals).map(
      (level) => [level, level] as const
    ),
  ];

  // A level the catalog does not list for this model stays shown, as the table holds it.
  const levelValue = Option.getOrElse(binding.thinkingLevel, () => "");

  const levelOptions = levels.some(([value]) => value === levelValue)
    ? levels
    : [...levels, [levelValue, `${levelValue} (not listed)`] as const];

  const selects = h.div(
    [
      h.Class(
        "flex min-w-0 max-w-full shrink-0 flex-wrap items-center gap-(--space-2)"
      ),
    ],
    [
      choiceSelect(h, {
        id: idOf(role, "model"),
        label: `Model for ${role}`,
        value: modelText(binding.model),
        options: models,
        isDisabled,
        onChange: (value) => Message.SelectedRoleModel({ role, value }),
      }),
      choiceSelect(h, {
        id: idOf(role, "thinking"),
        label: `Thinking for ${role}`,
        value: levelValue,
        options: levelOptions,
        isDisabled,
        onChange: (value) => Message.SelectedRoleThinking({ role, value }),
      }),
    ]
  );

  return h.li(
    [
      h.DataAttribute("testid", "role-row"),
      h.DataAttribute("role", role),
      h.DataAttribute("binding", modelText(binding.model)),
      h.Class(
        "flex min-w-0 flex-wrap items-center justify-between gap-x-(--space-4) gap-y-(--space-2) px-(--space-4) py-(--space-3)"
      ),
    ],
    [
      h.div(
        [h.Class("flex min-w-0 flex-[1_1_12rem] flex-col gap-(--space-0-5)")],
        [
          h.div(
            [h.Class("flex min-w-0 flex-wrap items-center gap-(--space-2)")],
            [
              h.h3(
                [
                  h.Class(
                    classNames(
                      "min-w-0 text-ink-1 font-(family-name:--font-code)",
                      TYPE.ui,
                      WEIGHT_MEDIUM
                    )
                  ),
                ],
                [role]
              ),
              ...statusLine(model, h, role),
            ]
          ),
          detailLine(model, h, role),
        ]
      ),
      selects,
    ]
  );
};

const tableRows = (model: Model, h: H, table: RoleTable): Html => {
  const catalog = Option.match(AsyncData.getData(model.catalog), {
    onNone: (): ReadonlyArray<ModelListing> => [],
    onSome: (found) => found.models,
  });

  return h.ul(
    [
      h.AriaLabel("Role table"),
      h.Class("flex min-w-0 flex-col [&>*+*]:border-t [&>*+*]:border-stroke-1"),
    ],
    rolesOf(table).flatMap((role) =>
      Option.match(Option.fromUndefinedOr(table[role]), {
        onNone: () => [],
        onSome: (binding) => [roleRow(model, h, catalog, role, binding)],
      })
    )
  );
};

const noticeLine = (model: Model, h: H): Html =>
  Option.match(model.notice, {
    onNone: () => h.empty,
    onSome: (notice) =>
      h.div(
        [
          h.DataAttribute("testid", "roles-notice"),
          h.Role("status"),
          h.Class(
            classNames(
              "flex min-w-0 flex-wrap items-center gap-(--space-2) text-tone-failed",
              TYPE.small
            )
          ),
        ],
        [
          h.span([h.Class("min-w-0 flex-1")], [notice]),
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

const tableBody = (model: Model, h: H): ReadonlyArray<Html> =>
  Option.match(AsyncData.getData(model.server), {
    onSome: (settings) => [tableRows(model, h, settings.roleBindings)],
    onNone: () =>
      Option.match(AsyncData.getError(model.server), {
        onNone: () => [
          h.p(
            [
              h.Class(
                classNames(
                  "px-(--space-4) py-(--space-3) text-ink-3 italic",
                  TYPE.ui
                )
              ),
            ],
            ["Reading the role table..."]
          ),
        ],
        onSome: (error) => [
          h.div(
            [
              h.Class(
                "flex flex-wrap items-center justify-between gap-(--space-2) px-(--space-4) py-(--space-3)"
              ),
            ],
            [
              h.p([h.Class(classNames("text-tone-failed", TYPE.ui))], [error]),
              button(
                h,
                {
                  ...buttonDefaults<Message>(),
                  size: "small",
                  onClick: Option.some(Message.ClickedRetry()),
                },
                ["Try again"]
              ),
            ]
          ),
        ],
      }),
  });

/** What the frame passes in: where the usage page lives. */
export interface RolesViewInputs {
  readonly usageHref: string;
}

/** The role table section of the settings page. */
export const view = Submodel.defineView<Model, Message, RolesViewInputs>(
  (model, inputs, h) =>
    h.section(
      [
        h.DataAttribute("testid", "settings-roles"),
        // The brief card's "Open the role table" links here (`/settings#roles`, plan 6B).
        h.Id("roles"),
        h.AriaLabel("Roles"),
        h.Class("flex min-w-0 flex-col gap-(--space-2)"),
      ],
      [
        h.header(
          [
            h.Class(
              "flex min-h-7 min-w-0 items-center justify-between gap-(--space-4) px-(--space-1)"
            ),
          ],
          [
            h.h2(
              [h.Class(classNames("text-ink-2", TYPE.ui, WEIGHT_MEDIUM))],
              ["Roles"]
            ),
            h.a(
              [
                h.DataAttribute("testid", "settings-usage-link"),
                h.Href(inputs.usageHref),
                h.Class(
                  classNames(
                    "inline-flex items-center rounded-(--radius-small) text-ink-2 underline-offset-4 hover:text-ink-1 hover:underline pointer-coarse:min-h-(--hit-target)",
                    TYPE.small,
                    FOCUS_RING
                  )
                ),
              ],
              ["Spend and plan windows"]
            ),
          ]
        ),
        h.div(
          [
            h.Class(
              "overflow-hidden rounded-(--radius-large) border border-stroke-1 bg-surface-raised text-ink-1 [&>*+*]:border-t [&>*+*]:border-stroke-1"
            ),
          ],
          [
            h.p(
              [
                h.Class(
                  classNames(
                    "px-(--space-4) py-(--space-3) text-ink-2",
                    TYPE.small
                  )
                ),
              ],
              [
                "Briefs and workflows name a role, never a model. A child keeps the model its role had when it started, so a change applies to children started after it.",
              ]
            ),
            ...Option.match(model.notice, {
              onNone: () => [],
              onSome: () => [
                h.div(
                  [h.Class("px-(--space-4) py-(--space-2)")],
                  [noticeLine(model, h)]
                ),
              ],
            }),
            ...tableBody(model, h),
          ]
        ),
      ]
    )
);
