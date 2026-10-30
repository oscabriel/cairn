// The parent banner (plan wave 6, 6D; surfaces note S6; ADR 0027): above a thread's composer, while
// any of its subagents (or theirs) asks the user something, one line says so ("Subagent needs
// approval", "2 subagents need input"), names each asking child as a link to its thread, and
// offers "Open approval" or "Open question" for the first, whose own card answers it. It hides
// while the thread asks the user something itself, since its request card then has the lane (an
// escalated question is the parent's own mirror, answered on that card). The rows' rollup is the
// one thread-state function's; this banner reads the same rollup (`parentBannerOf`).
//
// The behaviour is t3code's `childInputBannerItem` (ChatView.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92), drawn in the Stone look with L3's banner frame. It
// draws no state of its own: the shell rows decide it, so a reload or a second device shows the
// same banner.

import "./rollup.css";
import { parentBannerOf } from "@cairn/client-logic/SubagentRollup";
import type { ParentBanner } from "@cairn/client-logic/SubagentRollup";
import { ThreadId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Option, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Model } from "../../Model.ts";
import { threadRouter } from "../../Route.ts";
import { classNames } from "../../ui/ClassNames.ts";
import { bannerClass } from "../ui/Banner.ts";
import { buttonClass } from "../ui/Button.ts";
import { FOCUS_RING, TYPE, WEIGHT_MEDIUM } from "../ui/Classes.ts";
import { statusGlyph } from "../ui/Glyph.ts";
import { TONE_TEXT } from "../ui/Tone.ts";

/** What the banner shows for the open thread, if anything. */
export const parentBannerFor = (
  model: Pick<Model, "route" | "shell">
): Option.Option<ParentBanner<ThreadShell>> => {
  const { route } = model;

  if (!Predicate.isTagged(route, "Thread")) {
    return Option.none();
  }

  return Option.flatMap(model.shell, (shell) =>
    parentBannerOf(ThreadId.make(route.threadId), shell.threads)
  );
};

const childLink = <Message>(
  h: HtmlBuilder<Message>,
  child: ThreadShell,
  isLast: boolean
): Html =>
  h.span(
    [h.Class("whitespace-nowrap")],
    [
      h.a(
        [
          h.DataAttribute("testid", "parent-banner-child"),
          h.DataAttribute("thread-id", child.id),
          h.Href(threadRouter({ threadId: child.id })),
          h.Class(
            classNames(
              "rounded-(--radius-small) text-ink-2 underline decoration-stroke-2 underline-offset-2 hover:text-ink-1",
              FOCUS_RING
            )
          ),
        ],
        [child.title]
      ),
      isLast ? "" : ",",
    ]
  );

/** The banner, or nothing; a sibling of the request card in the composer's lane. */
export const parentBanner = <Message>(
  model: Pick<Model, "route" | "shell">,
  h: HtmlBuilder<Message>
): Html =>
  Option.match(parentBannerFor(model), {
    onNone: () => h.empty,
    onSome: (banner) =>
      h.div(
        [
          h.DataAttribute("testid", "parent-banner"),
          h.DataAttribute("request", banner.request),
          h.Class(
            "mx-auto w-full max-w-(--lane-width) px-(--space-3) pt-(--space-2)"
          ),
        ],
        [
          h.div(
            [
              h.DataAttribute("slot", "banner"),
              h.DataAttribute("tone", "waiting"),
              h.Role("status"),
              h.Class(bannerClass("waiting")),
            ],
            [
              h.div(
                [
                  h.Class(
                    "flex min-w-0 flex-[1_1_16rem] items-start gap-(--space-2)"
                  ),
                ],
                [
                  h.span(
                    [h.Class(classNames("mt-0.5", TONE_TEXT.waiting))],
                    [statusGlyph(h, "needs", "regular")]
                  ),
                  h.p(
                    [h.Class("min-w-0 break-words")],
                    [
                      h.span(
                        [
                          h.DataAttribute("slot", "parent-banner-title"),
                          h.Class(WEIGHT_MEDIUM),
                        ],
                        [banner.title]
                      ),
                      " ",
                      h.span(
                        [h.Class(classNames("text-ink-2", TYPE.ui))],
                        banner.children.flatMap((child, index) => [
                          index > 0 ? " " : "",
                          childLink(
                            h,
                            child,
                            index === banner.children.length - 1
                          ),
                        ])
                      ),
                    ]
                  ),
                ]
              ),
              h.div(
                [h.Class("ms-auto flex shrink-0 flex-wrap gap-(--space-2)")],
                [
                  h.a(
                    [
                      h.DataAttribute("testid", "parent-banner-open"),
                      h.Href(threadRouter({ threadId: banner.first.id })),
                      h.Class(buttonClass("secondary", "small")),
                    ],
                    [
                      banner.request === "approval"
                        ? "Open approval"
                        : "Open question",
                    ]
                  ),
                ]
              ),
            ]
          ),
        ]
      ),
  });
