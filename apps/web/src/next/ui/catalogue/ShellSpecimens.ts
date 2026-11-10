// The `next` shell's specimens in the look catalogue (plan look track L6): the rail, the project's
// sidebar list with its project thread and managed threads, the list of a project with no project
// thread, the chat header on the project thread and on a managed thread, the hold banners, the
// scratch overlay empty and holding a thread (with the real composer, U-16), the refresh confirm
// and the usage page, each over the
// shell fixture (`shell/ShellFixtures.ts`), so `judges/look-rules.ts` holds them to the rules. Their
// Messages go nowhere: the catalogue shows states, it does not run the shell.

import { shellRow } from "@cairn/client-logic/ShellRowTestKit";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { composerOn } from "../../../composer/ComposerFixtures.ts";
import { ComposerTarget } from "../../../composer/Model.ts";
import { AppRoute } from "../../../Route.ts";
import { classNames } from "../../../ui/ClassNames.ts";
import { scratchView as scratchComposerView } from "../../composer/View.ts";
import {
  chatHeaderBand,
  headerActions,
  headerLead,
} from "../../shell/Header.ts";
import * as Hold from "../../shell/Hold.ts";
import type { Message as ShellMessage } from "../../shell/Message.ts";
import type { Model as ShellModel } from "../../shell/Model.ts";
import { rail } from "../../shell/Rail.ts";
import type { RailDirection } from "../../shell/Rail.ts";
import { refreshConfirm } from "../../shell/Refresh.ts";
import {
  scratchBody,
  scratchHeadExtras,
  scratchSheet,
} from "../../shell/Scratch.ts";
import {
  DEV,
  MANAGED,
  MYR,
  onProjectThread,
  PROJECT_THREAD,
  SCRATCH_THREAD,
  SHELL,
  shellModelOn,
} from "../../shell/ShellFixtures.ts";
import { sidebarList } from "../../shell/Sidebar.ts";
import {
  headerContentOf,
  railBubblesOf,
  scratchKeysOf,
  sidebarContentOf,
} from "../../shell/View.ts";
import { TYPE } from "../Classes.ts";
import { sheet } from "../Sheet.ts";

/** The favicon the catalogue shows for the project with one: Cairn's own icon, served by Vite. */
const CATALOGUE_FAVICON = "/icons/icon.svg";

type SH = HtmlBuilder<ShellMessage>;

const railOf = (h: SH, model: ShellModel, direction: RailDirection): Html =>
  rail(
    h,
    direction,
    railBubblesOf(model).map((bubble) =>
      bubble.project.id === DEV
        ? { ...bubble, faviconUrl: CATALOGUE_FAVICON }
        : bubble
    )
  );

/** One shell specimen: what it draws, over a shell Model. */
type Draw = (model: ShellModel, h: SH) => Html;

/** A specimen as a Submodel view, so its shell Messages lift into the catalogue's. */
const specimenView = Submodel.defineView<
  { readonly model: ShellModel; readonly draw: Draw },
  ShellMessage
>((specimen, h) => specimen.draw(specimen.model, h));

const BOX =
  "relative flex overflow-hidden rounded-(--radius-medium) border border-stroke-1 bg-surface-ground";

const transcript = <M>(h: HtmlBuilder<M>): Html =>
  h.div(
    [
      h.Class(
        "flex flex-1 flex-col justify-end gap-(--space-3) overflow-y-auto p-(--space-4)"
      ),
    ],
    [
      h.p(
        [
          h.Class(
            classNames(
              "self-end rounded-(--radius-large) border border-stroke-1 bg-surface-raised px-(--space-3) py-(--space-2) text-ink-1",
              TYPE.body
            )
          ),
        ],
        ["What does fsync promise on ext4?"]
      ),
      h.p(
        [h.Class(classNames("text-ink-1", TYPE.body))],
        [
          "That the file's data and metadata reached the device. A new file's directory entry needs its own fsync on the directory.",
        ]
      ),
    ]
  );

const DRAWS: ReadonlyArray<{
  readonly state: string;
  readonly caption: string;
  readonly model: ShellModel;
  readonly draw: Draw;
}> = [
  {
    state: "rail",
    caption: "The rail: a favicon edge to edge, letters, a mark that needs you",
    model: onProjectThread,
    draw: (model, h) =>
      h.div(
        [h.Class(classNames(BOX, "h-64 w-fit"))],
        [railOf(h, model, "column")]
      ),
  },
  {
    state: "rail-row",
    caption: "The rail across the phone's sheet",
    model: onProjectThread,
    draw: (model, h) =>
      h.div([h.Class(classNames(BOX, "w-full"))], [railOf(h, model, "row")]),
  },
  {
    state: "sidebar",
    caption: "The project thread and the threads it manages, with the foot",
    model: onProjectThread,
    draw: (model, h) =>
      h.div(
        [h.Class(classNames(BOX, "h-[38rem] w-full max-w-80"))],
        [sidebarList(h, sidebarContentOf(model))]
      ),
  },
  {
    state: "sidebar-no-project-thread",
    caption: "A project with no project thread yet",
    model: {
      ...shellModelOn(AppRoute.Hero()),
      selectedProjectId: Option.some(MYR),
    },
    draw: (model, h) =>
      h.div(
        [h.Class(classNames(BOX, "h-80 w-full max-w-80"))],
        [sidebarList(h, sidebarContentOf(model))]
      ),
  },
  {
    state: "header-project-thread",
    caption:
      "The header on the project thread: status, Refresh, the scratch thread",
    model: onProjectThread,
    draw: (model, h) => {
      const content = headerContentOf(model);

      return h.div(
        [h.Class(classNames(BOX, "w-full flex-col"))],
        [chatHeaderBand(h, [headerLead(h, content), headerActions(h, content)])]
      );
    },
  },
  {
    state: "header-managed",
    caption: "The header on a managed thread",
    model: shellModelOn(
      AppRoute.Thread({ threadId: MANAGED[0]?.id ?? PROJECT_THREAD })
    ),
    draw: (model, h) => {
      const content = headerContentOf(model);

      return h.div(
        [h.Class(classNames(BOX, "w-full flex-col"))],
        [chatHeaderBand(h, [headerLead(h, content), headerActions(h, content)])]
      );
    },
  },
  {
    state: "refresh",
    caption: "Refresh asks first, with the new thread's first message",
    model: onProjectThread,
    draw: (_model, h) =>
      h.div(
        [h.Class(classNames(BOX, "h-[26rem] w-full"))],
        [
          refreshConfirm(
            h,
            Option.some({
              projectId: SHELL.projects[0]?.id ?? DEV,
              replaces: PROJECT_THREAD,
              text: "Pick up the look track from L7.",
              isSending: false,
              failure: Option.none(),
            }),
            "cairn",
            "contained"
          ),
        ]
      ),
  },
];

const heldRow = (overrides: Partial<ThreadShell>) =>
  Option.some(
    shellRow(5, {
      title: "Steps panel projection",
      ...overrides,
    })
  );

const HOLDS: ReadonlyArray<{
  readonly state: string;
  readonly caption: string;
  readonly model: Hold.Model;
}> = [
  {
    state: "hold-limited",
    caption: "The hold banner: a spent plan window",
    model: {
      ...Hold.initial,
      thread: heldRow({
        activity: "failed",
        lastErrorClass: Option.some("usage_limit"),
      }),
    },
  },
  {
    state: "hold-slot",
    caption: "The hold banner: waiting for a Claude slot",
    model: {
      ...Hold.initial,
      thread: heldRow({
        activity: "running",
        waitingFor: "claude_slot",
      }),
    },
  },
];

/** The scratch overlay as a specimen: the sheet in a box, its transcript, and the real composer. */
const scratchSpecimen = <M>(
  h: HtmlBuilder<M>,
  frame: SpecimenFrame<M>,
  state: string,
  caption: string,
  model: ShellModel,
  hasThread: boolean
): Html =>
  frame.specimen(`shell/${state}`, caption, [
    h.div(
      [h.Class(classNames(BOX, "h-[30rem] w-full"))],
      [
        sheet(
          h,
          {
            ...scratchSheet(h, [
              h.submodel({
                slotId: `look-shell-${state}-head`,
                model: {
                  model,
                  draw: (shell: ShellModel, sh: SH) =>
                    scratchHeadExtras(sh, shell.scratch, scratchKeysOf(shell)),
                },
                view: specimenView,
                toParentMessage: () => frame.ignore,
              }),
            ]),
            onClose: Option.some(frame.ignore),
          },
          [
            scratchBody(
              h,
              hasThread ? Option.some(transcript(h)) : Option.none()
            ),
            h.submodel({
              slotId: `look-shell-${state}-composer`,
              model: composerOn(
                ComposerTarget.Scratch({
                  threadId: hasThread
                    ? Option.some(SCRATCH_THREAD)
                    : Option.none(),
                })
              ),
              view: scratchComposerView,
              toParentMessage: () => frame.ignore,
            }),
          ],
          []
        ),
      ]
    ),
  ]);

/** What the catalogue hands the specimens: its specimen frame and where their Messages go. */
export interface SpecimenFrame<M> {
  readonly specimen: (
    state: string,
    caption: string,
    content: ReadonlyArray<Html>
  ) => Html;
  readonly ignore: M;
}

/** Every shell specimen, framed by the catalogue. */
export const shellSpecimens = <M>(
  h: HtmlBuilder<M>,
  frame: SpecimenFrame<M>
): ReadonlyArray<Html> => [
  ...DRAWS.map(({ caption, draw, model, state }) =>
    frame.specimen(`shell/${state}`, caption, [
      h.submodel({
        slotId: `look-shell-${state}`,
        model: { model, draw },
        view: specimenView,
        toParentMessage: () => frame.ignore,
      }),
    ])
  ),
  scratchSpecimen(
    h,
    frame,
    "scratch-empty",
    "The scratch thread before its first message, with the composer",
    {
      ...onProjectThread,
      scratch: { ...onProjectThread.scratch, isOpen: true },
    },
    false
  ),
  scratchSpecimen(
    h,
    frame,
    "scratch-thread",
    "The scratch thread holding a thread, with the composer",
    {
      ...onProjectThread,
      scratch: {
        isOpen: true,
        threadId: Option.some(SCRATCH_THREAD),
        isBusy: false,
      },
    },
    true
  ),
  ...HOLDS.map(({ caption, model, state }) =>
    frame.specimen(`shell/${state}`, caption, [
      h.div(
        [h.Class("w-full")],
        [
          h.submodel({
            slotId: `look-shell-${state}`,
            model,
            view: Hold.view,
            toParentMessage: (message) => message,
          }),
        ]
      ),
    ])
  ),
];
