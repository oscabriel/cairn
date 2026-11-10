// The app's layout (plan look track L6), drawn in the root's boundary: the shell's left
// column (or the phone's sheet), and beside it the open page under the new chat header, with the
// hold banner above a thread's transcript, and beside the chat column the work panel (plan 6E) or
// the goal panel (plan 6H) while one is open and its chunk is in (a bottom sheet under `lg`;
// `page/Chunks.ts`); the scratch overlay, the refresh confirm, the add-project
// picker and the rename and remove dialog float over it. An earlier project thread is read only:
// a bar in place of the composer leads to the project thread (ADR 0048). The shell's parts are Submodel views over `model.nextShell` (`View.ts`); the page's own parts
// (the transcript, the composer, the hero and settings pages, the diff toggle) are the root's
// regions, placed beside them rather than inside them, so their Mounts keep the root as their
// render owner. The chat header carries the connection mark, drawn from the root's connection.

import { Option, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../Message.ts";
import type { Model } from "../Model.ts";
import { chunkModule } from "../page/Chunks.ts";
import * as Pages from "../page/Regions.ts";
import * as Thread from "../page/thread/View.ts";
import { FONT_UI } from "../ui/Classes.ts";
import { classNames } from "../ui/ClassNames.ts";
import { modalSheet } from "../ui/Sheet.ts";
import { connectionMark } from "./ConnectionMark.ts";
import { goalChipView, goalInputsOf } from "./Goal.ts";
import { chatHeaderBand } from "./Header.ts";
import * as Hold from "./Hold.ts";
import { Message as ShellMessage } from "./Message.ts";
import { SCRATCH_FOCUS, scratchBody, scratchSheet } from "./Scratch.ts";
import * as Shell from "./View.ts";
import { workInputsOf, workToggleView } from "./Work.ts";

/** The root's regions the layout places. */
export interface ShellRegions {
  /** The notice bar; empty when there is no notice. */
  readonly notice: () => Html;
  /** The routed page for the hero, a draft, settings and not found. */
  readonly page: () => Html;
  /** The usage page (`/usage`, plan 6G). */
  readonly usage: () => Html;
  /** The open thread's transcript. */
  readonly thread: () => Html;
  /** The thread page's header controls (the diff toggle). */
  readonly threadControls: () => Html;
  /** The composer docked under the transcript, after what its lane holds before it (the request card). */
  readonly composerLane: () => ReadonlyArray<Html>;
}

type H = HtmlBuilder<Message>;

const toShell = (message: ShellMessage): Message =>
  Message.GotNextShellMessage({ message });

const header = (h: H, model: Model, controls: ReadonlyArray<Html>): Html =>
  chatHeaderBand(h, [
    h.submodel({
      slotId: "next-header-lead",
      model: model.nextShell,
      view: Shell.headerLeadView,
      toParentMessage: toShell,
    }),
    connectionMark(h, model.connection),
    ...controls,
    h.submodel({
      slotId: "next-header-actions",
      model: model.nextShell,
      view: Shell.headerActionsView,
      toParentMessage: toShell,
    }),
  ]);

const hold = (h: H, model: Model): Html =>
  h.submodel({
    slotId: "thread-hold",
    model: model.hold,
    view: Hold.view,
    toParentMessage: (message) => message,
  });

/**
 * Under the transcript: the composer's lane, or for an earlier project thread (read only, ADR
 * 0048) the bar that leads to the project thread.
 */
const lane = (
  h: H,
  model: Model,
  regions: ShellRegions
): ReadonlyArray<Html> => {
  if (!Shell.isEarlierThreadOpen(model.nextShell)) {
    return regions.composerLane();
  }

  return [
    h.submodel({
      slotId: "earlier-thread-lane",
      model: model.nextShell,
      view: Shell.earlierLaneView,
      toParentMessage: toShell,
    }),
  ];
};

const routeBody = (
  h: H,
  model: Model,
  regions: ShellRegions
): ReadonlyArray<Html> => {
  if (Predicate.isTagged(model.route, "Thread")) {
    const { isWide } = model.nextShell;
    const work = { inputs: workInputsOf(model), isWide };
    const goal = { inputs: goalInputsOf(model), isWide };

    return [
      h.div(
        [
          h.DataAttribute("slot", "chat-row"),
          h.Class("flex min-h-0 min-w-0 flex-1"),
        ],
        [
          h.div(
            [
              h.DataAttribute("chat-column", "true"),
              h.DataAttribute("chat-column-maximized-away", "false"),
              h.Class(
                "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden"
              ),
            ],
            [
              header(h, model, [
                regions.threadControls(),
                h.submodel({
                  slotId: "work-toggle",
                  model: model.nextShell.work,
                  view: workToggleView,
                  viewInputs: work,
                  toParentMessage: toShell,
                }),
                h.submodel({
                  slotId: "goal-chip",
                  model: model.nextShell.goal,
                  view: goalChipView,
                  viewInputs: goal,
                  toParentMessage: toShell,
                }),
              ]),
              hold(h, model),
              regions.thread(),
              ...lane(h, model, regions),
            ]
          ),
          Option.match(chunkModule("workPanel"), {
            onNone: () => h.empty,
            onSome: ({ workPanelView }) =>
              h.submodel({
                slotId: "work-panel",
                model: model.nextShell.work,
                view: workPanelView,
                viewInputs: work,
                toParentMessage: toShell,
              }),
          }),
          Option.match(chunkModule("goalPanel"), {
            onNone: () => h.empty,
            onSome: ({ goalPanelView }) =>
              h.submodel({
                slotId: "goal-panel",
                model: model.nextShell.goal,
                view: goalPanelView,
                viewInputs: goal,
                toParentMessage: toShell,
              }),
          }),
        ]
      ),
    ];
  }

  if (Predicate.isTagged(model.route, "Usage")) {
    return [header(h, model, []), regions.usage()];
  }

  return [header(h, model, []), regions.page()];
};

/**
 * The scratch overlay while it is shown: a dialog on the sheet holding the scratch thread's
 * transcript and, at its foot, the one composer, which serves the overlay meanwhile (U-16).
 */
const scratch = (h: H, model: Model): Html => {
  const { isOpen, threadId } = model.nextShell.scratch;

  if (!isOpen) {
    return h.empty;
  }

  return modalSheet(
    h,
    {
      ...scratchSheet(h, [
        h.submodel({
          slotId: "scratch-head",
          model: model.nextShell,
          view: Shell.scratchHeadView,
          toParentMessage: toShell,
        }),
      ]),
      role: "dialog",
      focusSelector: Option.some(SCRATCH_FOCUS),
      onClose: toShell(ShellMessage.ClickedCloseScratch()),
      onSettled: toShell(ShellMessage.SettledOverlay()),
    },
    [
      scratchBody(
        h,
        Option.map(threadId, () =>
          h.submodel({
            slotId: "scratch-thread",
            model: model.scratchThread,
            view: Thread.view,
            viewInputs: {
              workspaceRoot: Option.none(),
              launchFailure: Option.none(),
              // The scratch thread has no subagent rows: it spawns none worth a row (plan 6C).
              subagents: Option.none(),
            },
            toParentMessage: (message) =>
              Message.GotScratchThreadMessage({ message }),
          })
        )
      ),
      Pages.scratchComposer(model, h),
    ],
    []
  );
};

/** The whole app in the new look; the root element keeps `#root` and the frame's hooks. */
export const layout = (model: Model, h: H, regions: ShellRegions): Html =>
  h.div(
    [
      // Foldkit replaces the mount node with this element unless the two match, so it keeps
      // index.html's id and with it the #root rules in styles.css (the safe-area top inset).
      h.Id("root"),
      h.DataAttribute("ui", "next"),
      h.DataAttribute("route", model.route._tag),
      h.DataAttribute("slot", "sidebar-wrapper"),
      h.DataAttribute("sidebar-state", "expanded"),
      h.Class(
        classNames(
          "flex h-dvh min-h-0 w-full overflow-hidden bg-surface-ground text-ink-1",
          FONT_UI
        )
      ),
    ],
    [
      h.submodel({
        slotId: "next-shell-column",
        model: model.nextShell,
        view: Shell.columnView,
        toParentMessage: toShell,
      }),
      h.main(
        [
          h.DataAttribute("slot", "sidebar-inset"),
          h.Class(
            "relative flex h-dvh min-h-0 min-w-0 flex-1 flex-col overflow-hidden overscroll-y-none bg-surface-ground"
          ),
        ],
        [regions.notice(), ...routeBody(h, model, regions)]
      ),
      h.submodel({
        slotId: "next-shell-sheet",
        model: model.nextShell,
        view: Shell.sheetView,
        toParentMessage: toShell,
      }),
      scratch(h, model),
      h.submodel({
        slotId: "next-shell-refresh",
        model: model.nextShell,
        view: Shell.refreshView,
        viewInputs: { placement: "viewport" },
        toParentMessage: toShell,
      }),
      h.submodel({
        slotId: "next-shell-add-project",
        model: model.nextShell,
        view: Shell.addProjectView,
        viewInputs: { placement: "viewport" },
        toParentMessage: toShell,
      }),
      h.submodel({
        slotId: "next-shell-manage",
        model: model.nextShell,
        view: Shell.manageView,
        viewInputs: { placement: "viewport" },
        toParentMessage: toShell,
      }),
    ]
  );
