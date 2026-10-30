// The chat header in the new look: on a phone the sidebar button first, then the thread's name (the
// project's name for its project thread), a quiet word for what the thread is (project thread,
// managed by the project thread, scratch), its status as mark and word from the one thread-state
// function, then the thread page's own controls (the diff toggle), then the shell's actions: Refresh
// on the project thread, and the scratch thread's button. It keeps the `data-chat-header` hook the
// judges read.
//
// The band is drawn by its caller around three parts: the lead and the actions here (the shell's
// Messages) and the page's controls between them, which keep their own Messages.

import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Menu, MessageSquareDashed, RotateCw } from "lucide";

import { classNames } from "../../ui/ClassNames.ts";
import { buttonDefaults } from "../ui/Button.ts";
import { TYPE, WEIGHT_STRONG } from "../ui/Classes.ts";
import { glyph, statusGlyph } from "../ui/Glyph.ts";
import { iconButton } from "../ui/IconButton.ts";
import { TONE_TEXT } from "../ui/Tone.ts";
import type { RowStatus } from "./Derived.ts";
import { Message } from "./Message.ts";

/** What the header says about the open page. */
export interface HeaderContent {
  readonly title: string;
  /** The quiet word after the title: "project thread", "managed by cairn's project thread". */
  readonly role: Option.Option<string>;
  readonly status: Option.Option<RowStatus>;
  /** The open thread is its project's project thread, so Refresh is offered. */
  readonly canRefresh: boolean;
  /** The scratch shortcut's hint: Cmd on an Apple platform, Ctrl elsewhere. */
  readonly scratchHint: string;
}

/** The header band around its parts. */
export const chatHeaderBand = <M>(
  h: HtmlBuilder<M>,
  parts: ReadonlyArray<Html>
): Html =>
  h.header(
    [
      h.DataAttribute("chat-header", "true"),
      h.DataAttribute("testid", "next-chat-header"),
      h.Class(
        "flex h-14 min-h-14 shrink-0 items-center gap-(--space-2) border-b border-stroke-1 bg-surface-ground ps-(--space-2) pe-(--space-2) md:ps-(--space-5) md:pe-(--space-3)"
      ),
    ],
    parts
  );

/** The header's lead: the phone's sidebar button, the title, the role and the status. */
export const headerLead = (
  h: HtmlBuilder<Message>,
  content: HeaderContent
): Html =>
  h.div(
    [h.Class("flex min-w-0 flex-1 items-center gap-(--space-2)")],
    [
      h.span(
        [h.Class("md:hidden")],
        [
          iconButton(
            h,
            {
              ...buttonDefaults<Message>(),
              variant: "ghost",
              label: "Toggle main sidebar",
              onClick: Option.some(Message.ClickedOpenSheet()),
            },
            glyph(h, Menu, "menu", "regular")
          ),
        ]
      ),
      h.h1(
        [
          h.DataAttribute("testid", "next-header-title"),
          h.DataAttribute("slot", "workspace-breadcrumb-text"),
          h.Class(
            classNames("min-w-0 truncate text-ink-1", TYPE.body, WEIGHT_STRONG)
          ),
        ],
        [content.title]
      ),
      Option.match(content.role, {
        onNone: () => h.empty,
        onSome: (role) =>
          h.span(
            [
              h.DataAttribute("testid", "next-header-role"),
              h.Class(
                classNames(
                  "min-w-0 shrink truncate text-ink-3 max-sm:hidden",
                  TYPE.small
                )
              ),
            ],
            [role]
          ),
      }),
      h.span([h.Class("flex-1")]),
      Option.match(content.status, {
        onNone: () => h.empty,
        onSome: (row) =>
          h.span(
            [
              h.DataAttribute("testid", "next-header-status"),
              h.Class(
                classNames(
                  "inline-flex shrink-0 items-center gap-(--space-1-5) whitespace-nowrap text-ink-2 max-sm:hidden",
                  TYPE.small
                )
              ),
            ],
            [
              h.span(
                [
                  h.Class(
                    classNames("inline-flex", TONE_TEXT[row.status.tone])
                  ),
                ],
                [statusGlyph(h, row.status.mark, "regular")]
              ),
              h.span([], [row.status.word]),
            ]
          ),
      }),
    ]
  );

/** The header's actions: Refresh on the project thread, and the scratch thread's button. */
export const headerActions = (
  h: HtmlBuilder<Message>,
  content: HeaderContent
): Html =>
  h.div(
    [h.Class("flex shrink-0 items-center gap-(--space-1)")],
    [
      content.canRefresh
        ? iconButton(
            h,
            {
              ...buttonDefaults<Message>(),
              variant: "ghost",
              label: "Refresh: start a new project thread and archive this one",
              onClick: Option.some(Message.ClickedRefresh()),
              attributes: [h.DataAttribute("testid", "refresh-project-thread")],
            },
            glyph(h, RotateCw, "rotate-cw", "regular")
          )
        : h.empty,
      iconButton(
        h,
        {
          ...buttonDefaults<Message>(),
          variant: "ghost",
          label: `Scratch thread (${content.scratchHint})`,
          onClick: Option.some(Message.ClickedScratchButton()),
          attributes: [h.DataAttribute("testid", "open-scratch")],
        },
        glyph(h, MessageSquareDashed, "message-square-dashed", "regular")
      ),
    ]
  );
