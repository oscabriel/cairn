// The page regions the `next` frame draws (plan look track L7): the composer (the hero on a
// draft's page, the box docked under a thread), the thread page with its transcript, the chat
// header's diff toggle, and the settings page. Each is a Submodel over its slice of the root Model,
// lifted by a root Message.
//
// The thread page and the composer are lazy views over their own inputs, each with its own cache
// (a cached view belongs to one position in the tree), so a keystroke rebuilds only the composer
// and a streamed token only the transcript.

import type { Entry } from "@cairn/protocol/Thread";
import { Equal, Option } from "effect";
import { createLazy } from "foldkit/html";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../../Message.ts";
import type { Model } from "../../Model.ts";
import type { ViewInputs as ThreadInputs } from "../../page/thread/Inputs.ts";
import { launchFailureOf } from "../../page/thread/LaunchFailure.ts";
import type * as ThreadModel from "../../page/thread/Model.ts";
import { AppRoute } from "../../Route.ts";
import { projectOf, threadRowOf } from "../../ThreadRow.ts";
import { subagentRowsInput } from "../../timeline/Subagents.ts";
import { view as composerView } from "../composer/View.ts";
import { settingsPageView } from "../settings/Page.ts";
import type { SettingsSlots } from "../settings/Page.ts";
import * as Thread from "./Thread.ts";

type H = HtmlBuilder<Message>;

const heroComposerLazy = createLazy();

const dockedComposerLazy = createLazy();

const threadPageLazy = createLazy();

const composer = (h: H, composerModel: Model["composer"]): Html =>
  h.submodel({
    slotId: "composer",
    model: composerModel,
    view: composerView,
    toParentMessage: (message) => Message.GotComposerMessage({ message }),
  });

/** The composer docked under an open thread's transcript. */
export const dockedComposer = (model: Model, h: H): Html =>
  dockedComposerLazy(composer, [h, model.composer]);

/**
 * The thread page. Its inputs arrive as plain strings ("" for none) so the lazy view compares them
 * by value: Options built from the shell are new on every render.
 */
const threadPage = (
  h: H,
  thread: Model["thread"],
  workspaceRoot: string,
  failureMessage: string,
  retryUrl: string,
  subagents: ThreadInputs["subagents"]
): Html =>
  h.submodel({
    slotId: "thread",
    model: thread,
    view: Thread.view,
    viewInputs: {
      workspaceRoot:
        workspaceRoot === "" ? Option.none() : Option.some(workspaceRoot),
      launchFailure:
        failureMessage === ""
          ? Option.none()
          : Option.some({
              message: failureMessage,
              retryUrl: retryUrl === "" ? Option.none() : Option.some(retryUrl),
            }),
      subagents,
    },
    toParentMessage: (message) => Message.GotThreadMessage({ message }),
  });

/** The routed thread's page, in a wrapper that leaves the scrolling to the transcript. */
export const threadBody = (model: Model, h: H): Html =>
  AppRoute.match(model.route, {
    Thread: ({ threadId }) => {
      const failure = launchFailureOf(model, threadId);
      const row = threadRowOf(model.shell, threadId);

      const workspaceRoot = Option.orElse(
        Option.flatMap(row, (thread) => thread.worktreePath),
        () =>
          Option.map(
            Option.flatMap(row, (thread) => projectOf(model.shell, thread)),
            ({ workspaceRoot: root }) => root
          )
      );

      return h.div(
        [h.Class("flex min-h-0 flex-1 flex-col")],
        [
          threadPageLazy(threadPage, [
            h,
            model.thread,
            Option.getOrElse(workspaceRoot, () => ""),
            Option.match(failure, {
              onNone: () => "",
              onSome: ({ message }) => message,
            }),
            Option.getOrElse(
              Option.flatMap(failure, ({ retryUrl }) => retryUrl),
              () => ""
            ),
            subagentRowsInput(model.shell, threadId),
          ]),
        ]
      );
    },
    Hero: () => h.empty,
    Draft: () => h.empty,
    Settings: () => h.empty,
    Usage: () => h.empty,
    NotFound: () => h.empty,
  });

const NO_ENTRIES: ReadonlyArray<Entry> = [];

const olderOf = (thread: ThreadModel.Model): ReadonlyArray<Entry> =>
  Option.match(thread.view, {
    onNone: () => NO_ENTRIES,
    onSome: (state) => state.older,
  });

const windowOf = (thread: ThreadModel.Model): ReadonlyArray<Entry> =>
  Option.match(thread.view, {
    onNone: () => NO_ENTRIES,
    onSome: (state) => state.view.entries,
  });

/** The last thread page Model the header's controls were drawn from. */
const headerThread = new Map<"last", ThreadModel.Model>();

/**
 * The thread page Model for the header's controls: the one they were last drawn from while the
 * fields the toggle reads (the diff, the thread id, the entries) are unchanged.
 */
const headerThreadOf = (thread: ThreadModel.Model): ThreadModel.Model => {
  const last = headerThread.get("last");

  if (
    last !== undefined &&
    last.diff === thread.diff &&
    Equal.equals(last.threadId, thread.threadId) &&
    olderOf(last) === olderOf(thread) &&
    windowOf(last) === windowOf(thread)
  ) {
    return last;
  }

  headerThread.set("last", thread);

  return thread;
};

/** The chat header's controls over a thread: the diff toggle. */
export const threadControls = (model: Model, h: H): Html =>
  h.submodel({
    slotId: "thread-header-controls",
    model: headerThreadOf(model.thread),
    view: Thread.headerControls,
    toParentMessage: (message) => Message.GotThreadMessage({ message }),
  });

/** What the frame draws inside the settings page: the role table (plan 6G). */
export type PageSlots = SettingsSlots;

const placeholder = (h: H, text: string): Html =>
  h.div(
    [
      h.Class(
        "flex flex-1 items-center justify-center p-(--space-6) text-ink-2"
      ),
    ],
    [text]
  );

/** The routed page that is not a thread: the hero, a draft, settings, or not found. */
export const page = (model: Model, h: H, slots: PageSlots): Html =>
  AppRoute.match(model.route, {
    Hero: () => heroComposerLazy(composer, [h, model.composer]),
    Draft: () => heroComposerLazy(composer, [h, model.composer]),
    Thread: () => h.empty,
    Settings: () => settingsPageView(model, h, slots),
    Usage: () => h.empty,
    NotFound: ({ path }) => placeholder(h, `Nothing lives at ${path}.`),
  });
