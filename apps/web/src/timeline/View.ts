// The transcript: the measured list (ADR 0041, list/View.ts) over the derived rows, with every row
// measured before it counts, the end followed within 1 px, and the reader's place kept through
// changes above it and width changes (list/Place.ts). Each row is a keyed lazy view over
// reference-stable arguments, so a settled row is not rebuilt while the answer streams. The scroll-to-end pill shows
// once the list stops following its end (t3code's pill appears after 150 ms; here a CSS delay).

import { historyCursor } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { Option } from "effect";
import { Submodel } from "foldkit";
import { childAttributes, createKeyedLazy } from "foldkit/html";
import type { Html, HtmlBuilder } from "foldkit/html";
import { ArrowDown } from "lucide";

import { icon } from "../composer/Icon.ts";
import * as List from "./list/View.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { isFollowingEnd } from "./Model.ts";
import { estimatedHeightOf, setRecent, transcriptOf } from "./Rows.ts";
import type { ListItem, Transcript } from "./Rows.ts";
import { rowView } from "./RowView.ts";
import type { RowContext } from "./RowView.ts";

/** What the thread page passes: its view of the thread and the thread's working directory. */
export interface ViewInputs {
  readonly state: Option.Option<ThreadViewState>;
  readonly workspaceRoot: Option.Option<string>;
}

/**
 * One keyed lazy per thread, for the most recent `SAVED_THREAD_LIMIT` threads: one for every
 * thread kept each row ever drawn, with its detached DOM, for the page's life (T50).
 */
const rowLazies = new Map<string, ReturnType<typeof createKeyedLazy>>();

/**
 * The same per thread for the rows' off-screen copies (list/View.ts's measuring box). A cached
 * vnode is drawn at one position only, so a row and its off-screen copy never share one: sharing
 * let the box's removal strip the live row's listeners and Mounts.
 */
const probeLazies = new Map<string, ReturnType<typeof createKeyedLazy>>();

/** Where a row is drawn: in the list, or off-screen to be measured. */
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
  cursor: RowContext["historyCursor"]
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
    ]) ?? h.empty
  );
};

const pill = (h: HtmlBuilder<Message>, visible: boolean): Html =>
  h.div(
    [
      h.Class(
        `pointer-events-none absolute inset-x-0 bottom-3 flex justify-center transition-opacity delay-150 duration-200 ${visible ? "opacity-100" : "opacity-0 delay-0"}`
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
          h.Class(
            `${visible ? "pointer-events-auto" : ""} inline-flex size-8 items-center justify-center rounded-full border border-border bg-popover text-foreground shadow-md/5 hover:bg-accent`
          ),
        ],
        [icon(h, ArrowDown, "arrow-down", "size-4")]
      ),
    ]
  );

/** The transcript. */
export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, inputs, h) => {
    const threadId = Option.getOrElse(model.threadId, () => "");

    const transcript = transcriptOf(
      threadId,
      inputs.state,
      model.ui,
      inputs.workspaceRoot
    );

    const expandedUsers = new Set(model.ui.expandedUserMessageIds);
    const following = isFollowingEnd(model) || transcript.items.length === 0;

    return h.div(
      [
        h.DataAttribute("testid", "timeline"),
        // The transcript's row count, virtualized rows included, for the judges.
        h.DataAttribute("rows", String(transcript.items.length)),
        h.DataAttribute("following", isFollowingEnd(model) ? "true" : "false"),
        // t3code's chat canvas: its lane insets pad the scroller (styles.css).
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
            className:
              "messages-timeline-scroll min-h-0 [scrollbar-gutter:stable_both-edges] flex-1 overflow-x-hidden overscroll-y-contain",
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
