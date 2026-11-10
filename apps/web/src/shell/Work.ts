// The work panel's inputs and the chat header's work button (plan wave 6, 6E; surfaces notes S5
// and S7): for a thread in a tree, its lineage, its steps and its workflows, derived once per change
// of the shell or the thread's documents, and the button that counts them ("2/4 steps",
// "3 subagents") and opens the panel. The panel itself is `WorkPanel.ts`, its own chunk: a cold
// load never draws it (`page/Chunks.ts`).

import { pendingSubagentRequests } from "@cairn/client-logic/SubagentRollup";
import type { ChildStep } from "@cairn/client-logic/SubagentSteps";
import {
  childStepsOf,
  doneStepCount,
  lastRunAnsweredIn,
} from "@cairn/client-logic/SubagentSteps";
import type { Lineage } from "@cairn/client-logic/ThreadLineage";
import {
  hasLineage,
  lineageOf,
  settledOutcomesOf,
} from "@cairn/client-logic/ThreadLineage";
import type { WorkflowGroup } from "@cairn/client-logic/WorkflowSteps";
import { workflowGroupsOf } from "@cairn/client-logic/WorkflowSteps";
import { ThreadId } from "@cairn/protocol/Ids";
import type { ShellSnapshot } from "@cairn/protocol/Shell";
import {
  CHILD_DOCUMENT,
  ChildDocument,
  SUBAGENTS_DOCUMENT,
} from "@cairn/protocol/Subagents";
import type { Entry } from "@cairn/protocol/Thread";
import { WORKFLOWS_DOCUMENT } from "@cairn/protocol/Workflows";
import { Option, Predicate, Schema, Struct } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { ListTree } from "lucide";

import type { Model } from "../Model.ts";
import { buttonClass } from "../ui/Button.ts";
import { classNames } from "../ui/ClassNames.ts";
import type { StatusMark } from "../ui/Glyph.ts";
import { glyph, markOfTone, statusGlyph } from "../ui/Glyph.ts";
import type { Tone } from "../ui/Tone.ts";
import { TONE_TEXT } from "../ui/Tone.ts";
import type { Message } from "./Message.ts";
import { Message as ShellMessage } from "./Message.ts";
import type { WorkState } from "./Model.ts";

type H = HtmlBuilder<Message>;

/** The panel's id, which the header's button controls. */
export const WORK_PANEL_ID = "work-panel";

// ---------------------------------------------------------------------------------------------
// What the panel reads

/** What the work panel shows for the open thread. */
export interface WorkInputs {
  readonly threadId: ThreadId;
  readonly lineage: Lineage;
  /** The open thread's own steps, when it is a subagent with its row. */
  readonly steps: Option.Option<ReadonlyArray<ChildStep>>;
  readonly workflows: ReadonlyArray<WorkflowGroup>;
}

/** What the panel reads of a `cairn.child` document, as the protocol's `ChildDocument` has it. */
const ChildReportOf = ChildDocument.mapFields(Struct.pick(["report"]));

const decodeChildReport = Schema.decodeUnknownOption(ChildReportOf);

/** True when a `cairn.child` document holds the child's `report`. */
const hasReportIn = (document: Schema.Json | undefined): boolean =>
  Option.exists(decodeChildReport(document), ({ report }) => report !== null);

interface Memo {
  readonly shell: ShellSnapshot;
  readonly threadId: string;
  readonly subagents: Schema.Json | undefined;
  readonly workflows: Schema.Json | undefined;
  readonly child: Schema.Json | undefined;
  readonly entries: ReadonlyArray<Entry>;
  readonly inputs: Option.Option<WorkInputs>;
}

// One entry: the inputs last derived, kept while the shell and the documents they read are the
// same objects, so a keystroke in the composer derives nothing and the panel's view keeps its
// drawing. Held outside the Model on purpose, as `timeline/Subagents.ts` holds its memo.
const memo = new Map<"last", Memo>();

const NO_DOCS: Readonly<Record<string, Schema.Json>> = {};

const NO_ENTRIES: ReadonlyArray<Entry> = [];

/** The routed thread's documents and transcript, empty until its view is the routed thread's. */
interface ThreadRecords {
  readonly docs: Readonly<Record<string, Schema.Json>>;
  readonly entries: ReadonlyArray<Entry>;
}

const NO_RECORDS: ThreadRecords = { docs: NO_DOCS, entries: NO_ENTRIES };

const deriveInputs = (
  shell: ShellSnapshot,
  threadId: ThreadId,
  { docs, entries }: ThreadRecords
): Option.Option<WorkInputs> => {
  const lineage = lineageOf(
    threadId,
    shell.threads,
    settledOutcomesOf(docs[SUBAGENTS_DOCUMENT])
  );

  const row = shell.threads.find((thread) => thread.id === threadId);

  const steps =
    row === undefined || Option.isNone(row.lineage)
      ? Option.none()
      : Option.some(
          childStepsOf(row, {
            request: Option.fromUndefinedOr(
              pendingSubagentRequests(shell.threads).get(threadId)
            ),
            hasReport: hasReportIn(docs[CHILD_DOCUMENT]),
            answered: lastRunAnsweredIn(entries),
          })
        );

  const workflows = workflowGroupsOf(docs[WORKFLOWS_DOCUMENT]);

  return hasLineage(lineage) || workflows.length > 0
    ? Option.some({ threadId, lineage, steps, workflows })
    : Option.none();
};

/**
 * What the panel shows for the routed thread; none off a thread's page, or for a thread with no
 * parent, no child and no workflow. The thread page's documents count only once they are the
 * routed thread's.
 */
export const workInputsOf = (
  model: Pick<Model, "route" | "shell"> & {
    readonly thread: Pick<Model["thread"], "threadId" | "view">;
  }
): Option.Option<WorkInputs> => {
  const { route } = model;

  if (!Predicate.isTagged(route, "Thread") || Option.isNone(model.shell)) {
    return Option.none();
  }

  const threadId = ThreadId.make(route.threadId);
  const shell = model.shell.value;

  const records = Option.match(
    Option.filter(model.thread.view, () =>
      Option.contains(model.thread.threadId, threadId)
    ),
    {
      onNone: () => NO_RECORDS,
      onSome: (state): ThreadRecords => ({
        docs: state.view.docs,
        entries: state.view.entries,
      }),
    }
  );

  const { docs, entries } = records;

  const subagents = docs[SUBAGENTS_DOCUMENT];
  const workflows = docs[WORKFLOWS_DOCUMENT];
  const child = docs[CHILD_DOCUMENT];
  const last = memo.get("last");

  if (
    last?.shell === shell &&
    last.threadId === threadId &&
    last.subagents === subagents &&
    last.workflows === workflows &&
    last.child === child &&
    last.entries === entries
  ) {
    return last.inputs;
  }

  const inputs = deriveInputs(shell, threadId, records);

  memo.set("last", {
    shell,
    threadId,
    subagents,
    workflows,
    child,
    entries,
    inputs,
  });

  return inputs;
};

// ---------------------------------------------------------------------------------------------
// Pieces

/** A status mark in its tone: the only colour the panel and the button draw. */
export const mark = (
  h: H,
  tone: Tone,
  which: StatusMark = markOfTone(tone)
): Html =>
  h.span(
    [h.Class(classNames("inline-flex shrink-0", TONE_TEXT[tone]))],
    [statusGlyph(h, which, "regular")]
  );

/** What the steps sum to: failed if one failed, at work while one is now, done when all are. */
const stepsTone = (steps: ReadonlyArray<ChildStep>): Tone => {
  if (steps.some((step) => step.state === "failed")) {
    return "failed";
  }

  if (steps.some((step) => step.state === "now")) {
    return "working";
  }

  return steps.every((step) => step.state === "done") ? "done" : "neutral";
};

/** The header button's count: "2/4 steps" for a subagent's own page. */
export const stepsCountText = (steps: ReadonlyArray<ChildStep>): string =>
  `${String(doneStepCount(steps))}/${String(steps.length)} steps`;

// ---------------------------------------------------------------------------------------------
// The header's button and the panel

/** What the header's button and the panel are drawn from: the routed thread's inputs. */
export interface WorkViewInputs {
  readonly inputs: Option.Option<WorkInputs>;
  /** The window is `lg` or wider: the panel is a column beside the chat, not a modal sheet. */
  readonly isWide: boolean;
}

/** The header's button words: a subagent's steps, else its children, else its workflows. */
export const workToggleText = (inputs: WorkInputs): string => {
  if (Option.isSome(inputs.steps)) {
    return stepsCountText(inputs.steps.value);
  }

  const children =
    inputs.lineage.active.length + inputs.lineage.previous.length;

  if (children > 0) {
    return `${String(children)} ${children === 1 ? "subagent" : "subagents"}`;
  }

  const count = inputs.workflows.length;

  return `${String(count)} ${count === 1 ? "workflow" : "workflows"}`;
};

/** The header's tone for the button's mark: the steps' sum, else whether any child is live. */
const toggleTone = (inputs: WorkInputs): Tone =>
  Option.match(inputs.steps, {
    onSome: stepsTone,
    onNone: () => (inputs.lineage.active.length > 0 ? "working" : "neutral"),
  });

/** The chat header's work button, for a thread with something to show; it shows or hides the panel. */
export const workToggleView = Submodel.defineView<
  WorkState,
  Message,
  WorkViewInputs
>((work, { inputs }, h) =>
  Option.match(inputs, {
    onNone: () => h.empty,
    onSome: (shown) => {
      const tone = toggleTone(shown);

      return h.button(
        [
          h.Type("button"),
          h.DataAttribute("testid", "work-toggle"),
          h.DataAttribute("slot", "button"),
          h.AriaExpanded(work.isOpen),
          h.AriaControls(WORK_PANEL_ID),
          h.AriaLabel(`Work: ${workToggleText(shown)}`),
          h.OnClick(ShellMessage.ClickedWork()),
          h.Class(classNames(buttonClass("secondary", "small"), "shrink-0")),
        ],
        [
          Option.isSome(shown.steps)
            ? mark(h, tone)
            : h.span(
                [h.Class(classNames("inline-flex shrink-0", TONE_TEXT[tone]))],
                [glyph(h, ListTree, "list-tree", "small")]
              ),
          h.span(
            [
              h.DataAttribute("slot", "work-toggle-count"),
              h.Class("tabular-nums"),
            ],
            [workToggleText(shown)]
          ),
        ]
      );
    },
  })
);
