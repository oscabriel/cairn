// The hook contract the `next` views keep (ADR 0040, surfaces note "Fork, judge, switch, delete"):
// the data attributes `judges/behaviour.ts` and the landmark reader (`judges/fixtures/parity/
// Landmarks.ts`) find elements by. Whatever a `next` view draws, the element a judge looks for
// carries the same hook it does in the classic views, so the same judges run on both. Used by tests
// and judges only, never by a view, so it adds nothing to a bundle.

import { Predicate } from "effect";
import type { Html } from "foldkit/html";

/** A drawn element: Foldkit's `Html` without its empty case. */
type VNode = NonNullable<Html>;

/** Hooks matched by their whole name; the value names the element. */
export const HOOK_ATTRIBUTES = [
  "data-testid",
  "data-menu-id",
  "data-slot",
  "data-sidebar-state",
  "data-ui",
  "data-timeline-row-kind",
  "data-message-role",
  "data-thread-item",
  "data-trigger",
  "data-level",
  "data-soft-keyboard",
  "data-resting-block",
] as const;

/** Hook families matched by prefix: the attribute's name is the hook. */
export const HOOK_PREFIXES = [
  "data-chat-",
  "data-composer-",
  "data-changed-files-",
] as const;

const NAMED: ReadonlySet<string> = new Set(HOOK_ATTRIBUTES);

/** Whether an attribute named `name` is part of the hook contract. */
export const isHook = (name: string): boolean =>
  NAMED.has(name) || HOOK_PREFIXES.some((prefix) => name.startsWith(prefix));

// Hooks whose value says which element it is; for the others the name alone is the landmark,
// as the landmark reader keys them (a row kind with its role, a chat hook by name).
const KEYED_BY_VALUE: ReadonlySet<string> = new Set([
  "data-testid",
  "data-menu-id",
  "data-slot",
  "data-timeline-row-kind",
  "data-message-role",
  "data-trigger",
]);

const keyOf = (name: string, value: string | number | boolean): string =>
  KEYED_BY_VALUE.has(name) ? `${name}=${String(value)}` : name;

/**
 * Every hook in a rendered tree, as `name=value` for hooks that name their element and `name`
 * for the rest, sorted and without repeats.
 */
export const hooksOf = (root: VNode): ReadonlyArray<string> => {
  const found = new Set<string>();
  const pending: Array<VNode> = [root];

  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const [name, value] of Object.entries(node.data?.attrs ?? {})) {
      if (isHook(name)) {
        found.add(keyOf(name, value));
      }
    }

    for (const child of node.children ?? []) {
      if (!Predicate.isString(child)) {
        pending.push(child);
      }
    }
  }

  return [...found].toSorted();
};
