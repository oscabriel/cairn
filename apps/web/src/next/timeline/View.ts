// The `next` transcript (plan look track L7): classic's transcript (`timeline/View.ts`) over the
// same Submodel, with the `next` rows (`RowView.ts`), the subagent groups and the way back in
// place (6C), and the scroll-to-end pill in the Stone look. The list is classic's measured list
// (ADR 0041): every row is measured before it counts, the end is followed within 1 px, and the
// reader's place holds through changes above it. Each row is a keyed lazy view over
// reference-stable arguments, one cache per thread and per place a row is drawn (the list, or the
// off-screen measuring box), held apart from classic's so the two never share a drawing.

import { historyCursor } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { Option } from "effect";
import { Submodel } from "foldkit";
import { childAttributes, createKeyedLazy } from "foldkit/html";
import type { Html, HtmlBuilder } from "foldkit/html";
import { ArrowDown } from "lucide";

import { icon } from "../../composer/Icon.ts";
import * as List from "../../timeline/list/View.ts";
import { Message } from "../../timeline/Message.ts";
import type { Model } from "../../timeline/Model.ts";
import { isFollowingEnd } from "../../timeline/Model.ts";
import {
  estimatedHeightOf,
  setRecent,
  transcriptOf,
} from "../../timeline/Rows.ts";
import type { ListItem, Transcript } from "../../timeline/Rows.ts";
import type { RowContext } from "../../timeline/RowView.ts";
import { withSubagentItems } from "../../timeline/Subagents.ts";
import type { SubagentShells } from "../../timeline/Subagents.ts";
import { classNames } from "../../ui/ClassNames.ts";
import { FEEDBACK_MOTION, FOCUS_RING, HIT_TARGET } from "../ui/Classes.ts";
import { rowView } from "./RowView.ts";

/**
 * What the thread page passes: its view of the thread, the thread's working directory, and the
 * shell rows its subagent rows read.
 */
export interface ViewInputs {
  readonly state: Option.Option<ThreadViewState>;
  readonly workspaceRoot: Option.Option<string>;
  readonly subagents: Option.Option<SubagentShells>;
}

/** One keyed lazy per thread for the rows the list draws, for the most recent threads. */
const rowLazies = new Map<string, ReturnType<typeof createKeyedLazy>>();

/** The same for the rows' off-screen copies, so a row and its copy never share a drawing. */
const probeLazies = new Map<string, ReturnType<typeof createKeyedLazy>>();

type RowPosition = "list" | "offScreen";

const rowLazyFor = (threadId: string, position: RowPosition) => {
  const lazies = position === "list" ? rowLazies : probeLazies;

  return setRecent(
    lazies,
    threadId,
    // oxlint-disable-next-line foldkit/lazy-view-stable-references -- made once per thread and position and kept in its map, so its cache lives as long as the thread stays recent
    lazies.get(threadId) ?? createKeyedLazy()
  );
};

const listView = List.view<ListItem>();

const renderRow = (
  h: HtmlBuilder<Message>,
  item: ListItem,
  threadId: string,
  workspaceRoot: string,
  highlightedLanguages: ReadonlyArray<string>,
  highlightedCode: number,
  copiedRowId: Option.Option<string>,
  expanded: boolean,
  retryPrompt: RowContext["retryPrompt"],
  history: RowContext["history"],
  cursor: RowContext["historyCursor"],
  subagents: RowContext["subagents"]
): Html =>
  rowView(h, item, {
    threadId,
    workspaceRoot:
      workspaceRoot === "" ? Option.none() : Option.some(workspaceRoot),
    highlightedLanguages,
    highlightedCode,
    copiedRowId,
    expanded,
    retryPrompt,
    history,
    historyCursor: cursor,
    subagents,
  });

/** The copy feedback only for the row it belongs to, so other rows keep their lazy views. */
const copiedFor = (
  copied: Option.Option<string>,
  rowId: string
): Option.Option<string> =>
  Option.filter(copied, (id) => id === rowId || id.startsWith(`${rowId}:`));

const NO_COPY: Option.Option<string> = Option.none();

const NO_PROMPT: RowContext["retryPrompt"] = Option.none();

const NO_CURSOR: RowContext["historyCursor"] = Option.none();

const NO_SHELLS: RowContext["subagents"] = Option.none();

const itemView = (
  h: HtmlBuilder<Message>,
  model: Model,
  threadId: string,
  inputs: ViewInputs,
  transcript: Transcript,
  item: ListItem,
  position: RowPosition
): Html => {
  const copied = copiedFor(model.copiedRowId, item.id);

  const prompt =
    item.kind === "error"
      ? Option.fromUndefinedOr(transcript.prompts.get(item.entry.turnId))
      : NO_PROMPT;

  const cursor =
    item.kind === "history"
      ? Option.flatMap(inputs.state, historyCursor)
      : NO_CURSOR;

  return (
    rowLazyFor(threadId, position)(item.id, renderRow, [
      h,
      item,
      threadId,
      Option.getOrElse(inputs.workspaceRoot, () => ""),
      model.highlightedLanguages,
      model.highlightedCode,
      Option.isSome(copied) ? copied : NO_COPY,
      model.ui.expandedUserMessageIds.includes(item.id),
      prompt,
      item.kind === "history" ? model.history : "idle",
      cursor,
      // Only the subagent items read the shell, so a shell change redraws no other row.
      item.kind === "subagents" || item.kind === "parent-link"
        ? inputs.subagents
        : NO_SHELLS,
    ]) ?? h.empty
  );
};

/** Each derived transcript with its subagent items, so the same transcript keeps one copy. */
const withItems = new WeakMap<
  Transcript,
  { readonly items: ReadonlyArray<ListItem>; readonly transcript: Transcript }
>();

const withSubagents = (
  transcript: Transcript,
  state: ViewInputs["state"],
  model: Model
): Transcript => {
  const items = withSubagentItems(transcript.items, state, model.ui);

  if (items === transcript.items) {
    return transcript;
  }

  const known = withItems.get(transcript);

  if (known?.items === items) {
    return known.transcript;
  }

  const placed: Transcript = { ...transcript, items };

  withItems.set(transcript, { items, transcript: placed });

  return placed;
};

const PILL_CLASS = classNames(
  "inline-flex size-8 cursor-pointer items-center justify-center rounded-full border border-stroke-2 bg-surface-overlay text-ink-1 hover:bg-select-2 [&_svg]:size-4",
  HIT_TARGET,
  FOCUS_RING,
  FEEDBACK_MOTION
);

/** The scroll-to-end pill, shown once the list stops following its end (after 150 ms). */
const pill = (h: HtmlBuilder<Message>, visible: boolean): Html =>
  h.div(
    [
      h.Class(
        `pointer-events-none absolute inset-x-0 bottom-(--space-3) flex justify-center transition-opacity delay-150 duration-200 ${visible ? "opacity-100" : "opacity-0 delay-0"}`
      ),
    ],
    [
      h.button(
        [
          h.Type("button"),
          h.AriaLabel("Scroll to the end"),
          h.DataAttribute("testid", "scroll-to-end"),
          h.DataAttribute("visible", visible ? "true" : "false"),
          h.Disabled(!visible),
          h.OnClick(Message.ClickedScrollToEnd()),
          h.Class(`${visible ? "pointer-events-auto" : ""} ${PILL_CLASS}`),
        ],
        [icon(h, ArrowDown, "arrow-down", "")]
      ),
    ]
  );

/** The `next` transcript. */
export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => {
    const threadId = Option.getOrElse(model.threadId, () => "");

    const derived = transcriptOf(
      threadId,
      inputs.state,
      model.ui,
      inputs.workspaceRoot
    );

    const transcript: Transcript = Option.isSome(inputs.subagents)
      ? withSubagents(derived, inputs.state, model)
      : derived;

    const expandedUsers = new Set(model.ui.expandedUserMessageIds);
    const following = isFollowingEnd(model) || transcript.items.length === 0;

    return h.div(
      [
        h.DataAttribute("testid", "timeline"),
        h.DataAttribute("rows", String(transcript.items.length)),
        h.DataAttribute("following", isFollowingEnd(model) ? "true" : "false"),
        h.DataAttribute("chat-canvas", "true"),
        h.Style({ "--chat-timeline-gutter": "6px" }),
        h.Class("relative flex min-h-0 flex-1 flex-col"),
      ],
      [
        h.submodel({
          slotId: model.ui.list.id,
          model: model.ui.list,
          view: listView,
          viewInputs: {
            items: transcript.items,
            itemToKey: (item) => item.id,
            itemToView: (item) =>
              itemView(h, model, threadId, inputs, transcript, item, "list"),
            itemToOffScreenView: (item) =>
              itemView(
                h,
                model,
                threadId,
                inputs,
                transcript,
                item,
                "offScreen"
              ),
            itemToEstimatedHeightPx: (item) =>
              estimatedHeightOf(item, expandedUsers),
            // The list draws each row as a grid of one implicit column, which grows to its row's
            // min-content (a long unbroken path, a wide code block), and its inline `overflow: auto`
            // beats a class: the column is held to the list's width and sideways scroll is shut, so
            // a wide row cuts or scrolls inside itself and never moves the transcript (the phone run).
            className:
              "messages-timeline-scroll min-h-0 [scrollbar-gutter:stable_both-edges] flex-1 overflow-x-hidden! overscroll-y-contain [&>*]:grid-cols-[minmax(0,1fr)]",
            attributes: childAttributes([
              h.DataAttribute("testid", "timeline-scroll"),
            ]),
          },
          toParentMessage: (message) => Message.GotListMessage({ message }),
        }),
        pill(h, !following),
      ]
    );
  }
);
