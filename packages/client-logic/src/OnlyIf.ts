// A list entry only one state has (a view attribute, a child, a menu item) reads as one
// named call in the list, instead of a ternary against an empty array.

/**
 * `items`, in order, when `condition` holds, and no items otherwise. The items are built either
 * way, so pass only values that are cheap and safe to build when `condition` is false; branch in a
 * statement for anything costly or narrowed by the condition.
 */
export const onlyIf = <const Items extends ReadonlyArray<unknown>>(
  condition: boolean,
  ...items: Items
): Items | readonly [] => (condition ? items : []);
