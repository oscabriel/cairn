// The `next` app's layout (plan look track L6), drawn in the root's boundary: the shell's left
// column (or the phone's sheet), and beside it the open page under the new chat header, with the
// hold banner above a thread's transcript, and beside the chat column the work panel (plan 6E) or
// the goal panel (plan 6H) while one is open (a bottom sheet under `lg`); the scratch overlay and the refresh confirm float over
// it. The shell's parts are Submodel views over `model.nextShell` (`View.ts`); the page's own parts
// (the transcript, the composer, the hero and settings pages, the diff toggle) are the root's
// regions, placed beside them rather than inside them, so their Mounts keep the root as their
// render owner.

import { Option, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../../Message.ts";
import type { Model } from "../../Model.ts";
import { classNames } from "../../ui/ClassNames.ts";
import * as Thread from "../page/Thread.ts";
import { FONT_UI } from "../ui/Classes.ts";
import { goalChipView, goalInputsOf, goalPanelView } from "./Goal.ts";
import { chatHeaderBand } from "./Header.ts";
import * as Hold from "./Hold.ts";
import type { Message as ShellMessage } from "./Message.ts";
import { scratchBody, scratchPanel } from "./Scratch.ts";
import { registerShell } from "./ShellLoad.ts";
import { inform, update } from "./Update.ts";
import * as Shell from "./View.ts";
import { workInputsOf, workPanelView, workToggleView } from "./Work.ts";

// The root runs the shell's update through `ShellLoad.ts`, from now on.
registerShell({ update, inform });

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
    model: model.parked,
    view: Hold.view,
    toParentMessage: (message) => Message.GotParkedMessage({ message }),
  });

const routeBody = (
  h: H,
  model: Model,
  regions: ShellRegions
): ReadonlyArray<Html> => {
  if (Predicate.isTagged(model.route, "Thread")) {
    const work = { inputs: workInputsOf(model) };
    const goal = { inputs: goalInputsOf(model) };

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
              ...regions.composerLane(),
            ]
          ),
          h.submodel({
            slotId: "work-panel",
            model: model.nextShell.work,
            view: workPanelView,
            viewInputs: work,
            toParentMessage: toShell,
          }),
          h.submodel({
            slotId: "goal-panel",
            model: model.nextShell.goal,
            view: goalPanelView,
            viewInputs: goal,
            toParentMessage: toShell,
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

const scratch = (h: H, model: Model): Html => {
  const { isOpen, threadId } = model.nextShell.scratch;

  if (!isOpen) {
    return h.empty;
  }

  return h.div(
    [h.DataAttribute("slot", "scratch"), h.Class("contents")],
    [
      h.submodel({
        slotId: "scratch-scrim",
        model: model.nextShell,
        view: Shell.scratchScrimView,
        viewInputs: { placement: "viewport" },
        toParentMessage: toShell,
      }),
      scratchPanel(h, "viewport", [
        h.submodel({
          slotId: "scratch-head",
          model: model.nextShell,
          view: Shell.scratchHeadView,
          toParentMessage: toShell,
        }),
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
        h.submodel({
          slotId: "scratch-foot",
          model: model.nextShell,
          view: Shell.scratchFootView,
          toParentMessage: toShell,
        }),
      ]),
    ]
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
    ]
  );
