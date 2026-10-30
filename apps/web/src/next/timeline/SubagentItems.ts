// The placing of the transcript's subagent items (plan 6C), in the `next` chunk so the entry does
// not carry it: a group of the children a parent spawned between two of its messages, after the
// work that spawned them and before the model's next words, and at the top of a child's
// transcript, below the history control, the way back to its parent. The items come from the
// thread's own view (its spawn calls, briefs, registry and notes), so their keys never depend on
// the shell. `timeline/Subagents.ts` calls these through what `SubagentRows.ts` registers.

import {
  parentThreadIdOf,
  spawnCallsOf,
  subagentLinksOf,
} from "@cairn/client-logic/SubagentRuntime";
import type { SubagentLink } from "@cairn/client-logic/SubagentRuntime";
import { threadEntries } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import type { ThreadId } from "@cairn/protocol/Ids";
import { Option } from "effect";

import type { ThreadUi } from "../../timeline/Model.ts";
import type { ListItem } from "../../timeline/Rows.ts";
import { PARENT_LINK_ID, subagentGroupId } from "../../timeline/Subagents.ts";
import type {
  ParentLinkItem,
  SubagentsItem,
} from "../../timeline/Subagents.ts";

/** A list item's time, for placing a group; none for the history control and the way back. */
const timeOf = (item: ListItem): Option.Option<number> => {
  if (item.kind === "history" || item.kind === "parent-link") {
    return Option.none();
  }

  if (item.kind === "working" || item.kind === "thinking") {
    return item.createdAt;
  }

  return Option.some(item.createdAt);
};

const WORK_LOG = new Set(["work", "work-toggle", "work-live", "thinking"]);

/**
 * Where a group of children spawned at `at` goes: after the last item at or before that time, and
 * after the work that follows it, so the group comes after the tools of the step that spawned it
 * and before the model's next words.
 */
const slotOf = (items: ReadonlyArray<ListItem>, at: number): number => {
  let slot = 0;

  for (const [index, item] of items.entries()) {
    if (Option.exists(timeOf(item), (time) => time <= at)) {
      slot = index + 1;
    }
  }

  while (slot < items.length && WORK_LOG.has(items[slot]?.kind ?? "")) {
    slot += 1;
  }

  return slot;
};

/** The items of the transcript with the subagent groups and the way back put in place. */
const placeItems = (
  items: ReadonlyArray<ListItem>,
  links: ReadonlyArray<SubagentLink>,
  parent: Option.Option<ThreadId>,
  expanded: ReadonlySet<string>
): ReadonlyArray<ListItem> => {
  const groups = new Map<number, Array<SubagentLink>>();

  for (const link of links) {
    const slot = slotOf(items, link.call.createdAt);
    const group = groups.get(slot) ?? [];

    group.push(link);
    groups.set(slot, group);
  }

  const groupAt = (slot: number): ReadonlyArray<SubagentsItem> => {
    const group = groups.get(slot);
    const first = group?.[0];

    if (group === undefined || first === undefined) {
      return [];
    }

    const id = subagentGroupId(first.call.callId);

    return [
      {
        kind: "subagents",
        id,
        createdAt: first.call.createdAt,
        links: group,
        expanded: expanded.has(id),
      },
    ];
  };

  const placed: Array<ListItem> = [];

  for (const [index, item] of items.entries()) {
    placed.push(...groupAt(index), item);
  }

  placed.push(...groupAt(items.length));

  return Option.match(parent, {
    onNone: () => placed,
    onSome: (parentThreadId) => {
      const link: ParentLinkItem = {
        kind: "parent-link",
        id: PARENT_LINK_ID,
        parentThreadId,
      };

      // Below the history control, as t3code puts its "Subagent of" divider.
      const at = placed[0]?.kind === "history" ? 1 : 0;

      return [...placed.slice(0, at), link, ...placed.slice(at)];
    },
  });
};

interface ItemsMemo {
  readonly items: ReadonlyArray<ListItem>;
  readonly view: ThreadViewState["view"];
  readonly older: ThreadViewState["older"];
  readonly expanded: ThreadUi["expandedWorkGroupIds"];
  readonly placed: ReadonlyArray<ListItem>;
}

const itemsMemo = new Map<"last", ItemsMemo>();

/**
 * The transcript's items with the open thread's subagent groups and, for a subagent, the way back
 * to its parent; the same array while nothing they read changed.
 */
export const placeSubagentItems = (
  items: ReadonlyArray<ListItem>,
  state: Option.Option<ThreadViewState>,
  ui: ThreadUi
): ReadonlyArray<ListItem> => {
  if (Option.isNone(state)) {
    return items;
  }

  const { view, older } = state.value;
  const last = itemsMemo.get("last");

  if (
    last !== undefined &&
    last.items === items &&
    last.view === view &&
    last.older === older &&
    last.expanded === ui.expandedWorkGroupIds
  ) {
    return last.placed;
  }

  const placed = placeItems(
    items,
    subagentLinksOf({ entries: threadEntries(state.value), docs: view.docs }),
    parentThreadIdOf(view.docs),
    new Set(ui.expandedWorkGroupIds)
  );

  itemsMemo.set("last", {
    items,
    view,
    older,
    expanded: ui.expandedWorkGroupIds,
    placed,
  });

  return placed;
};

/**
 * Every key a subagent item of `state` can take, for the list to keep their heights when the view
 * changes shape: a group per spawn call (only a group's first call names it) and the way back.
 */
export const subagentItemKeys = (
  state: Option.Option<ThreadViewState>
): ReadonlyArray<string> =>
  Option.match(state, {
    onNone: () => [],
    onSome: (found) => [
      PARENT_LINK_ID,
      ...spawnCallsOf(threadEntries(found)).map((call) =>
        subagentGroupId(call.callId)
      ),
    ],
  });
