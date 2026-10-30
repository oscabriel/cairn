// The `next` shell's specimens in the look catalogue (plan look track L6): the rail, the project's
// sidebar list with its project thread and managed threads, the list of a project with no project
// thread, the chat header on the project thread and on a managed thread, the hold banners, the
// scratch overlay empty and holding a thread, the refresh confirm and the usage page, each over the
// shell fixture (`shell/ShellFixtures.ts`), so `judges/look-rules.ts` holds them to the rules. Their
// Messages go nowhere: the catalogue shows states, it does not run the shell.

import { shellRow } from "@cairn/client-logic/ShellRowTestKit";
import { TaskId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { AppRoute } from "../../../Route.ts";
import * as Parked from "../../../shell/Parked.ts";
import { classNames } from "../../../ui/ClassNames.ts";
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
  scratchFoot,
  scratchHead,
  scratchPanel,
  scratchScrim,
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
import { usagePage } from "../../shell/Usage.ts";
import {
  headerContentOf,
  railBubblesOf,
  scratchKeysOf,
  sidebarContentOf,
} from "../../shell/View.ts";
import { TYPE } from "../Classes.ts";

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

const transcript = (h: SH): Html =>
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
    state: "scratch-empty",
    caption: "The scratch thread before its first message",
    model: {
      ...onProjectThread,
      scratch: { ...onProjectThread.scratch, isOpen: true },
    },
    draw: (model, h) =>
      h.div(
        [h.Class(classNames(BOX, "h-[30rem] w-full"))],
        [
          scratchScrim(h, "contained"),
          scratchPanel(h, "contained", [
            scratchHead(h, model.scratch, scratchKeysOf(model)),
            scratchBody(h, Option.none()),
            scratchFoot(h, model.scratch, model.failure),
          ]),
        ]
      ),
  },
  {
    state: "scratch-thread",
    caption: "The scratch thread holding a thread, with a draft",
    model: {
      ...onProjectThread,
      scratch: {
        isOpen: true,
        threadId: Option.some(SCRATCH_THREAD),
        draft: "And on a rename?",
        isBusy: false,
      },
    },
    draw: (model, h) =>
      h.div(
        [h.Class(classNames(BOX, "h-[30rem] w-full"))],
        [
          scratchScrim(h, "contained"),
          scratchPanel(h, "contained", [
            scratchHead(h, model.scratch, scratchKeysOf(model)),
            scratchBody(h, Option.some(transcript(h))),
            scratchFoot(h, model.scratch, model.failure),
          ]),
        ]
      ),
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
            }),
            "cairn",
            "contained"
          ),
        ]
      ),
  },
  {
    state: "usage",
    caption: "The usage page, until its meters land",
    model: shellModelOn(AppRoute.Usage()),
    draw: (_model, h) =>
      h.div([h.Class(classNames(BOX, "h-72 w-full flex-col"))], [usagePage(h)]),
  },
];

const parkedRow = (overrides: Partial<ThreadShell>) =>
  Option.some(
    shellRow(5, {
      title: "Steps panel projection",
      activity: "parked",
      parkedTaskIds: [TaskId.make(7)],
      ...overrides,
    })
  );

const HOLDS: ReadonlyArray<{
  readonly state: string;
  readonly caption: string;
  readonly model: Parked.Model;
}> = [
  {
    state: "hold-parked",
    caption: "The hold banner: a parked task, with Retry",
    model: { ...Parked.initial, hasClient: true, thread: parkedRow({}) },
  },
  {
    state: "hold-limited",
    caption: "The hold banner: a spent plan window",
    model: {
      ...Parked.initial,
      hasClient: true,
      thread: parkedRow({
        activity: "failed",
        parkedTaskIds: [],
        lastErrorClass: Option.some("usage_limit"),
      }),
    },
  },
  {
    state: "hold-slot",
    caption: "The hold banner: waiting for a Claude slot",
    model: {
      ...Parked.initial,
      hasClient: true,
      thread: parkedRow({
        activity: "running",
        parkedTaskIds: [],
        waitingFor: "claude_slot",
      }),
    },
  },
];

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
  ...HOLDS.map(({ caption, model, state }) =>
    frame.specimen(`shell/${state}`, caption, [
      h.div(
        [h.Class("w-full")],
        [
          h.submodel({
            slotId: `look-shell-${state}`,
            model,
            view: Hold.view,
            toParentMessage: () => frame.ignore,
          }),
        ]
      ),
    ])
  ),
];
