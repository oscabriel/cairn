// Ported from github.com/pingdotgg/t3code, apps/web/src/components/Sidebar.logic.ts, the partition
// and paging in apps/web/src/components/Sidebar.tsx (`partitionSidebarThreads`,
// `SETTLED_TAIL_*`), apps/web/src/projectIdentity.ts and apps/web/src/projectIconColors.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the shelves and their precedence (snoozed,
// settled, pinned, active), the row status and its top label, receding rows, unseen completion,
// title search with content matches after title matches, adjacent-thread traversal, preferred-id
// ordering, the project monogram and colour, the row accessibility label and settled paging (10,
// then 25). Changed: Cairn's shell rows (status comes from `activity` and `pendingRuntimeRequest`,
// with `parked` added beside `failed` and `limited`), one environment, an `Option` where t3code
// returns `null`. Not ported: drag and drop, sweep gestures, multi-select, pull requests, subagent
// lineage and the Working shelf (plan D27), and React hooks.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import type { ProjectId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Array, DateTime, Option, Order } from "effect";

import { effectiveSnoozed, threadWokeAt } from "./ThreadSettled.ts";
import {
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "./ThreadSort.ts";

/** The shelves of the sidebar, top to bottom. */
export type SidebarSection = "pinned" | "active" | "snoozed" | "settled";

/** A thread's shelf. A snooze or a settle wins over a stale pin. */
export const resolveSidebarThreadSection = (input: {
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly pinned: boolean;
}): SidebarSection => {
  if (input.snoozed) {
    return "snoozed";
  }

  if (input.settled) {
    return "settled";
  }

  return input.pinned ? "pinned" : "active";
};

/** The rows of each shelf, each in its own order. */
export interface SidebarPartition<T> {
  readonly pinned: ReadonlyArray<T>;
  readonly active: ReadonlyArray<T>;
  readonly snoozed: ReadonlyArray<T>;
  readonly settled: ReadonlyArray<T>;
}

/** A thread's shelf at `now`. */
export const sectionOf = (
  thread: ThreadShell,
  now: DateTime.Utc
): SidebarSection =>
  resolveSidebarThreadSection({
    snoozed: effectiveSnoozed(thread, now),
    settled: Option.contains(thread.settledOverride, "settled"),
    pinned: Option.isSome(thread.pinnedAt),
  });

/**
 * Splits the shell's threads into shelves at `now`, keeping only `projectFilter`'s threads when
 * one is set. Pinned by pin order, active by active order (activity never reorders it), snoozed by
 * wake time, settled by settle time.
 */
export const partitionSidebarThreads = <T extends ThreadShell>(
  threads: ReadonlyArray<T>,
  now: DateTime.Utc,
  projectFilter: Option.Option<ProjectId> = Option.none()
): SidebarPartition<T> => {
  const shelves: Record<SidebarSection, Array<T>> = {
    pinned: [],
    active: [],
    snoozed: [],
    settled: [],
  };

  // One pass: each visible thread's shelf is resolved once.
  for (const thread of threads) {
    if (
      Option.isNone(thread.archivedAt) &&
      Option.match(projectFilter, {
        onNone: () => true,
        onSome: (projectId) => thread.projectId === projectId,
      })
    ) {
      shelves[sectionOf(thread, now)].push(thread);
    }
  }

  const wakeMs = (thread: T) =>
    Option.match(thread.snoozedUntil, {
      onNone: () => 0,
      onSome: DateTime.toEpochMillis,
    });

  return {
    pinned: sortPinnedThreadsByOrderKey(shelves.pinned),
    active: sortActiveThreadsByOrderKey(shelves.active),
    snoozed: Array.sort(
      shelves.snoozed,
      Order.combine(
        Order.mapInput(Order.Number, wakeMs),
        Order.mapInput(Order.String, (thread: T) => thread.id)
      )
    ),
    settled: sortSettledThreads(shelves.settled),
  };
};

/** How many settled rows show when the shelf first opens. */
export const SETTLED_TAIL_INITIAL_COUNT = 10;

/** How many more settled rows each "Show more" adds. */
export const SETTLED_TAIL_PAGE_COUNT = 25;

/** The settled rows shown after `pages` presses of "Show more", never more than there are. */
export const visibleSettledCount = (total: number, pages: number): number =>
  Math.min(
    total,
    SETTLED_TAIL_INITIAL_COUNT + Math.max(0, pages) * SETTLED_TAIL_PAGE_COUNT
  );

/** The ids in the order the sidebar shows them, given which shelves are open. */
export const visibleThreadOrder = <T extends { readonly id: string }>(
  partition: SidebarPartition<T>,
  shelves: {
    readonly snoozedExpanded: boolean;
    readonly settledExpanded: boolean;
    readonly settledPages: number;
  }
): Array<string> => [
  ...partition.pinned.map((thread) => thread.id),
  ...partition.active.map((thread) => thread.id),
  ...(shelves.snoozedExpanded
    ? partition.snoozed.map((thread) => thread.id)
    : []),
  ...(shelves.settledExpanded
    ? partition.settled
        .slice(
          0,
          visibleSettledCount(partition.settled.length, shelves.settledPages)
        )
        .map((thread) => thread.id)
    : []),
];

/** What a row shows in its status slot, by priority. */
export type SidebarThreadStatus =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "parked"
  | "failed"
  | "limited"
  | "ready";

/**
 * A thread's status: a request for the user first (approval over a question), then busy work,
 * then a parked task, then the latest run's failure (a usage limit reads as limited).
 */
export const resolveSidebarThreadStatus = (
  thread: Pick<
    ThreadShell,
    "activity" | "pendingRuntimeRequest" | "lastErrorClass" | "parkedTaskIds"
  >
): SidebarThreadStatus => {
  if (Option.isSome(thread.pendingRuntimeRequest)) {
    const { kind } = thread.pendingRuntimeRequest.value;

    return kind === "user-input" || kind === "sign-in" ? "input" : "approval";
  }

  if (thread.activity === "preparing" || thread.activity === "running") {
    return "working";
  }

  if (thread.activity === "waiting") {
    return "waiting";
  }

  if (thread.activity === "parked" || thread.parkedTaskIds.length > 0) {
    return "parked";
  }

  if (thread.activity === "failed") {
    return Option.contains(thread.lastErrorClass, "usage_limit")
      ? "limited"
      : "failed";
  }

  return "ready";
};

/** The label in a row's top-right corner, when it has one instead of the row's age. */
export type SidebarTopStatus =
  | "approval"
  | "done"
  | "failed"
  | "limited"
  | "parked"
  | "input"
  | "waiting"
  | "woke"
  | "working";

/** The top label: the status, else "Woke" after an early wake, else "Done" when unseen. */
export const resolveSidebarTopStatus = (input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
}): Option.Option<SidebarTopStatus> => {
  if (input.status !== "ready") {
    return Option.some(input.status);
  }

  if (input.isWoke) {
    return Option.some("woke");
  }

  return input.isUnread ? Option.some("done") : Option.none();
};

/** Only working rows show how long they have been at it. */
export const shouldShowSidebarDuration = (status: SidebarThreadStatus) =>
  status === "working";

/**
 * True when a row should fade back: busy rows always (unless open or selected), and quiet or
 * approval rows once seen. Rows asking a question never recede.
 */
export const shouldRecedeSidebarThread = (input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
  readonly isActive: boolean;
  readonly isSelected: boolean;
}): boolean => {
  if (input.isActive || input.isSelected || input.status === "input") {
    return false;
  }

  if (input.status === "working" || input.status === "waiting") {
    return true;
  }

  if (input.status === "ready" || input.status === "approval") {
    return !input.isUnread && !input.isWoke;
  }

  return false;
};

/**
 * True when the row shows "Woke": a snooze ended (early or on time) after the user last looked,
 * and the thread was not settled since.
 */
export const isThreadWoke = (thread: ThreadShell, now: DateTime.Utc): boolean =>
  !Option.contains(thread.settledOverride, "settled") &&
  Option.exists(threadWokeAt(thread, now), (wokeAt) =>
    Option.match(thread.lastVisitedAt, {
      onNone: () => true,
      onSome: (visitedAt) => DateTime.isLessThan(visitedAt, wokeAt),
    })
  );

export { hasUnseenCompletion } from "./PresentThreadShell.ts";

/** A row's accessible name, and whether it is the open page (`aria-current="page"`). */
export interface SidebarRowAccessibility {
  readonly label: string;
  readonly isCurrentPage: boolean;
}

/** The row's accessible name: title, status and project, without the row's actions. */
export const resolveSidebarRowAccessibility = (input: {
  readonly title: string;
  readonly statusLabel: Option.Option<string>;
  readonly projectDisplayName: Option.Option<string>;
  readonly isActive: boolean;
}): SidebarRowAccessibility => ({
  label: [
    input.title,
    ...Option.toArray(input.statusLabel),
    ...Option.toArray(input.projectDisplayName),
  ]
    .filter((part) => part !== "")
    .join(", "),
  isCurrentPage: input.isActive,
});

/**
 * Threads whose title contains `query` (case-insensitive), then threads whose content matched
 * (`contentMatchIds`), each list in its input order. An empty query finds nothing.
 */
export const searchSidebarThreads = <
  T extends { readonly id: string; readonly title: string },
>(
  threads: ReadonlyArray<T>,
  query: string,
  contentMatchIds: ReadonlySet<string> = new Set()
): Array<T> => {
  const needle = query.trim().toLowerCase();

  if (needle.length === 0) {
    return [];
  }

  const titleMatches = Array.filter(threads, (thread) =>
    thread.title.toLowerCase().includes(needle)
  );

  const contentMatches = Array.filter(
    threads,
    (thread) =>
      !thread.title.toLowerCase().includes(needle) &&
      contentMatchIds.has(thread.id)
  );

  return [...titleMatches, ...contentMatches];
};

/** The ids of threads whose latest visible message contains `query`, Cairn's content match. */
export const previewMatchIds = (
  threads: ReadonlyArray<ThreadShell>,
  query: string
): ReadonlySet<string> => {
  const needle = query.trim().toLowerCase();

  return new Set(
    needle.length === 0
      ? []
      : threads.flatMap((thread) =>
          Option.exists(thread.latestVisibleMessage, (message) =>
            message.text.toLowerCase().includes(needle)
          )
            ? [thread.id]
            : []
        )
  );
};

/** Which way thread traversal moves. */
export type ThreadTraversalDirection = "previous" | "next";

/**
 * The neighbour of the current thread in sidebar order. With no current thread, "next" is the
 * first and "previous" the last; none past either end or for a thread not in the list.
 */
export const resolveAdjacentThreadId = <T>(input: {
  readonly threadIds: ReadonlyArray<T>;
  readonly currentThreadId: Option.Option<T>;
  readonly direction: ThreadTraversalDirection;
}): Option.Option<T> => {
  const { threadIds, currentThreadId, direction } = input;

  return Option.match(currentThreadId, {
    onNone: () =>
      direction === "previous" ? Array.last(threadIds) : Array.head(threadIds),
    onSome: (current) => {
      const index = threadIds.indexOf(current);

      if (index === -1) {
        return Option.none();
      }

      return Array.get(
        threadIds,
        direction === "previous" ? index - 1 : index + 1
      );
    },
  });
};

/**
 * Where to go after a thread leaves the visible list (settled or snoozed while open): the row that
 * followed it, else the one before it, else nowhere.
 */
export const nextThreadAfterLeaving = <T>(
  orderBefore: ReadonlyArray<T>,
  leaving: T
): Option.Option<T> => {
  const index = orderBefore.indexOf(leaving);

  if (index === -1) {
    return Option.none();
  }

  return Option.orElse(Array.get(orderBefore, index + 1), () =>
    Array.get(orderBefore, index - 1)
  );
};

/**
 * `items` with the ones named in `preferredIds` first, in that order; unknown and repeated ids are
 * skipped, and the rest keep their relative order.
 */
export const orderItemsByPreferredIds = <Item, Id>(input: {
  readonly items: ReadonlyArray<Item>;
  readonly preferredIds: ReadonlyArray<Id>;
  readonly getId: (item: Item) => Id;
}): Array<Item> => {
  const emitted = new Set<number>();

  const ordered = Array.flatMap(input.preferredIds, (id) => {
    const index = input.items.findIndex(
      (item, candidate) => !emitted.has(candidate) && input.getId(item) === id
    );

    if (index === -1) {
      return [];
    }

    emitted.add(index);

    return Option.toArray(Array.get(input.items, index));
  });

  return [...ordered, ...input.items.filter((_, index) => !emitted.has(index))];
};

/** The colours a project mark can take, each with its Tailwind text classes. */
export const PROJECT_ICON_COLORS = [
  { value: "gray", className: "text-gray-600 dark:text-gray-400" },
  { value: "red", className: "text-red-600 dark:text-red-400" },
  { value: "orange", className: "text-orange-600 dark:text-orange-400" },
  { value: "amber", className: "text-amber-600 dark:text-amber-400" },
  { value: "yellow", className: "text-yellow-600 dark:text-yellow-400" },
  { value: "lime", className: "text-lime-600 dark:text-lime-400" },
  { value: "green", className: "text-green-600 dark:text-green-400" },
  { value: "emerald", className: "text-emerald-600 dark:text-emerald-400" },
  { value: "teal", className: "text-teal-600 dark:text-teal-400" },
  { value: "cyan", className: "text-cyan-600 dark:text-cyan-400" },
  { value: "sky", className: "text-sky-600 dark:text-sky-400" },
  { value: "blue", className: "text-blue-600 dark:text-blue-400" },
  { value: "indigo", className: "text-indigo-600 dark:text-indigo-400" },
  { value: "violet", className: "text-violet-600 dark:text-violet-400" },
  { value: "purple", className: "text-purple-600 dark:text-purple-400" },
  { value: "fuchsia", className: "text-fuchsia-600 dark:text-fuchsia-400" },
  { value: "pink", className: "text-pink-600 dark:text-pink-400" },
  { value: "rose", className: "text-rose-600 dark:text-rose-400" },
] as const;

/** A project's mark: two letters and a colour, derived from its name. */
export interface ProjectIdentity {
  readonly monogram: string;
  readonly colorClassName: string;
}

const normalizeProjectName = (name: string): string =>
  name.normalize("NFKC").trim();

const projectMonogram = (name: string): string => {
  const words = normalizeProjectName(name).match(/[\p{L}\p{N}]+/gu) ?? [];

  return Option.match(Array.head(words), {
    onNone: () => "PR",
    onSome: (firstWord) => {
      const glyphs = Array.fromIterable(firstWord);
      const first = glyphs[0] ?? "P";

      const second = Option.getOrElse(
        Option.orElse(
          Array.findFirst(glyphs.slice(1), (glyph) => /\p{N}/u.test(glyph)),
          () =>
            words.length > 1
              ? Array.head(Array.fromIterable(words.at(-1) ?? ""))
              : Array.last(glyphs)
        ),
        () => first
      );

      return Array.fromIterable(`${first}${second}`.toUpperCase())
        .slice(0, 2)
        .join("");
    },
  });
};

const projectColorClassName = (name: string): string => {
  const seed =
    normalizeProjectName(name).toLocaleLowerCase("en-US") || "project";

  let index = 0;

  for (const glyph of seed) {
    index =
      (index * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_ICON_COLORS.length;
  }

  return (PROJECT_ICON_COLORS[index] ?? PROJECT_ICON_COLORS[11]).className;
};

/** The mark of a project named `name`: "cairn" is "CN" in amber, as in t3code. */
export const deriveProjectIdentity = (name: string): ProjectIdentity => ({
  monogram: projectMonogram(name),
  colorClassName: projectColorClassName(name),
});

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** How many letters a monogram has, which sets the width its glyphs are fitted to. */
export const monogramGlyphCount = (monogram: string): number =>
  Array.fromIterable(graphemes.segment(monogram)).length;

/** One run of search-result text, highlighted when it matched the query. */
export interface HighlightPart {
  readonly text: string;
  readonly highlighted: boolean;
}

/**
 * `text` cut into runs, every occurrence of `query` (ASCII case-insensitive) highlighted, as
 * t3code's `HighlightedSearchText` marks a match excerpt.
 */
export const splitHighlights = (
  text: string,
  query: string
): ReadonlyArray<HighlightPart> => {
  const needle = query.trim().toLowerCase();

  if (needle.length === 0) {
    return [{ text, highlighted: false }];
  }

  const haystack = text.toLowerCase();
  const parts: Array<HighlightPart> = [];
  let cursor = 0;

  while (cursor < text.length) {
    const match = haystack.indexOf(needle, cursor);

    if (match === -1) {
      parts.push({ text: text.slice(cursor), highlighted: false });
      break;
    }

    if (match > cursor) {
      parts.push({ text: text.slice(cursor, match), highlighted: false });
    }

    parts.push({
      text: text.slice(match, match + needle.length),
      highlighted: true,
    });
    cursor = match + needle.length;
  }

  return parts;
};

/** How far into a message the first match may sit before the excerpt starts at the match instead. */
const EXCERPT_LEAD = 120;

/**
 * The part of a message a search result shows: from the start when the first match is near it,
 * else from a little before the match with a leading ellipsis. None when the message does not
 * contain the query.
 */
export const searchExcerpt = (
  text: string,
  query: string
): Option.Option<string> => {
  const needle = query.trim().toLowerCase();
  const match = text.toLowerCase().indexOf(needle);

  if (needle.length === 0 || match === -1) {
    return Option.none();
  }

  if (match <= EXCERPT_LEAD) {
    return Option.some(text);
  }

  return Option.some(`…${text.slice(match - 40)}`);
};
