// The project rail (the user, 2026-10-29): one bubble per folder project, at the far left on a
// desktop and across the top of the sidebar sheet on a phone. A bubble is a squircle with a low
// corner radius, filled edge to edge by the project's favicon (found on the server as t3code finds
// it, `/api/projects/<id>/favicon`), or the project's first letter when it has none. A small mark
// on a bubble says a thread in that project needs the user or is working. No global inbox.

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import type { ProjectId } from "@cairn/protocol/Ids";
import type { ProjectShell } from "@cairn/protocol/Shell";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_RING,
  TYPE,
  WEIGHT_STRONG,
} from "../ui/Classes.ts";
import { statusGlyph } from "../ui/Glyph.ts";
import { TONE_TEXT } from "../ui/Tone.ts";
import type { ProjectMark } from "./Derived.ts";
import { projectLetterOf } from "./Derived.ts";
import { Message } from "./Message.ts";
import type { FaviconState } from "./Model.ts";

/** The address of a project's favicon on the brain. */
export const projectFaviconUrl = (projectId: ProjectId): string =>
  `/api/projects/${encodeURIComponent(projectId)}/favicon`;

/** Which way the rail runs: a column at the left edge, or a row across the sheet's top. */
export type RailDirection = "column" | "row";

/** One bubble as the rail draws it. */
export interface RailBubble {
  readonly project: ProjectShell;
  readonly isSelected: boolean;
  readonly mark: ProjectMark;
  /** How its favicon request ended; none while it loads. */
  readonly favicon: Option.Option<FaviconState>;
  /** Where its favicon is asked for (`projectFaviconUrl` in the app). */
  readonly faviconUrl: string;
}

const MARK_WORDS: Readonly<Record<ProjectMark, string>> = {
  needs: "a thread needs you",
  working: "a thread is working",
  none: "",
};

// A squircle with a low corner radius, so a square favicon fills it edge to edge.
const BUBBLE = classNames(
  "relative grid size-10 shrink-0 cursor-pointer place-items-center rounded-(--radius-medium) border border-stroke-1 bg-surface-raised text-ink-2 pointer-coarse:size-(--hit-target)",
  "hover:border-stroke-2 hover:text-ink-1 aria-current:border-stroke-2 aria-current:bg-surface-overlay aria-current:text-ink-1",
  // The selected ring sits outside the box on a pseudo-element, so the focus ring (an outline)
  // stays the only ring the button itself draws.
  "after:pointer-events-none after:absolute after:-inset-[4px] after:rounded-[calc(var(--radius-medium)+4px)] after:border-[1.5px] after:border-transparent aria-current:after:border-ink-1",
  FOCUS_RING,
  FEEDBACK_MOTION
);

const pip = (h: HtmlBuilder<Message>, mark: ProjectMark): Html =>
  mark === "none"
    ? h.empty
    : h.span(
        [
          h.DataAttribute("testid", "rail-mark"),
          h.Class(
            classNames(
              "absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-(--radius-round) bg-surface-rail",
              TONE_TEXT[mark === "needs" ? "waiting" : "working"]
            )
          ),
        ],
        [statusGlyph(h, mark === "needs" ? "needs" : "busy", "small")]
      );

const face = (
  h: HtmlBuilder<Message>,
  bubble: RailBubble
): ReadonlyArray<Html> => {
  const loaded = Option.contains(bubble.favicon, "loaded");
  const missing = Option.contains(bubble.favicon, "missing");

  const letter = h.span(
    [
      h.DataAttribute("testid", "rail-letter"),
      h.AriaHidden(true),
      h.Class(classNames(TYPE.body, WEIGHT_STRONG, loaded && "invisible")),
    ],
    [projectLetterOf(bubble.project)]
  );

  if (missing) {
    return [letter];
  }

  return [
    letter,
    // Shown once it loads; until then, and when the project has none, the letter shows.
    h.img([
      h.DataAttribute("testid", "rail-favicon"),
      h.Src(bubble.faviconUrl),
      h.Alt(""),
      h.Draggable(false),
      h.OnLoad(Message.LoadedFavicon({ projectId: bubble.project.id })),
      h.OnError(Message.FailedFavicon({ projectId: bubble.project.id })),
      h.Class(
        classNames(
          "absolute inset-0 size-full rounded-[calc(var(--radius-medium)-1px)] object-cover",
          !loaded && "opacity-0"
        )
      ),
    ]),
  ];
};

const bubbleView = (h: HtmlBuilder<Message>, bubble: RailBubble): Html => {
  const words = MARK_WORDS[bubble.mark];

  return h.button(
    [
      h.Type("button"),
      h.DataAttribute("testid", "rail-project"),
      h.AriaLabel(
        words === ""
          ? bubble.project.title
          : `${bubble.project.title}, ${words}`
      ),
      h.Title(bubble.project.title),
      ...onlyIf(bubble.isSelected, h.AriaCurrent("true")),
      h.OnClick(Message.ClickedProject({ projectId: bubble.project.id })),
      h.Class(BUBBLE),
    ],
    [...face(h, bubble), pip(h, bubble.mark)]
  );
};

/** The rail: a bubble per folder project, the selected one ringed. */
export const rail = (
  h: HtmlBuilder<Message>,
  direction: RailDirection,
  bubbles: ReadonlyArray<RailBubble>
): Html =>
  h.nav(
    [
      h.DataAttribute("testid", "shell-rail"),
      h.AriaLabel("Projects"),
      h.Class(
        direction === "column"
          ? "flex w-15 shrink-0 flex-col items-center gap-(--space-2) overflow-y-auto border-e border-stroke-1 bg-surface-rail py-(--space-3)"
          : "flex shrink-0 flex-row items-center gap-(--space-2) overflow-x-auto border-b border-stroke-1 bg-surface-rail px-(--space-4) py-(--space-3)"
      ),
    ],
    bubbles.map((bubble) => bubbleView(h, bubble))
  );
