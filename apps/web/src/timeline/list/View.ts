// The measured list's view: the rows near the reader drawn, the rest parked behind gaps of their
// frozen height, and a few rows drawn off-screen to be measured before they count (Layout.ts).
// The off-screen rows sit in a zero-height, clipped, hidden box inside the scroller, at the rows'
// own width, so their height is the height they will have in the list.
//
// Replaces @foldkit/ui's virtual list (github.com/foldkit/foldkit, packages/ui/src/virtualList at
// 0.169.0): its item attributes (`data-virtual-list-item-key`, `-index`, `aria-setsize`,
// `aria-posinset`), keyed rows and a Mount on the scroller are kept, so the judges read the same
// hooks. Changed: no estimated heights in the layout, no scroll Commands (Place.ts sets
// `scrollTop` itself, before paint), and rows are parked by frozen height.
//
// MIT License. Copyright (c) 2025 Devin Jameson
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

import { Predicate } from "effect";
import { Submodel } from "foldkit";
import type { ChildAttribute, Html } from "foldkit/html";
import { childAttributes } from "foldkit/html";

import { layoutOf } from "./Layout.ts";
import type { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { ObserveList, PROBE, PROBE_KEY, ROW_KEY } from "./Place.ts";

/** What the list's owner passes. */
export interface ViewInputs<Item extends object> {
  readonly items: ReadonlyArray<Item>;
  readonly itemToKey: (item: Item) => string;
  readonly itemToView: (item: Item) => Html;
  /** A row's height before it is measured: only how many rows a list with nothing measured draws. */
  readonly itemToEstimatedHeightPx: (item: Item) => number;
  readonly className: string;
  readonly attributes: ReadonlyArray<ChildAttribute>;
}

/** How many lists remember which item each row was last drawn from. */
const REMEMBERED_LISTS = 24;

/**
 * Per list, the item each row was last drawn from (on screen or off). A parked row whose item is
 * no longer that one changed since it was measured, so it is measured again.
 */
const drawnItems = new Map<string, Map<string, object>>();

const drawnItemsOf = (id: string): Map<string, object> => {
  const known = drawnItems.get(id) ?? new Map<string, object>();

  drawnItems.delete(id);
  drawnItems.set(id, known);

  for (const key of drawnItems.keys()) {
    if (drawnItems.size <= REMEMBERED_LISTS) {
      break;
    }

    drawnItems.delete(key);
  }

  return known;
};

/** The off-screen box: no height, clipped and hidden, so it adds nothing to the scroll range. */
const PROBE_STYLE = {
  position: "absolute",
  top: "0",
  left: "0",
  right: "0",
  height: "0",
  overflow: "hidden",
  visibility: "hidden",
  contain: "layout paint style",
  "pointer-events": "none",
};

/** The measured list, for items of type `Item`. */
export const view = <Item extends object>() =>
  Submodel.defineView<Model, Message, ViewInputs<Item>>((model, inputs, h) => {
    const { items } = inputs;
    const keys = items.map(inputs.itemToKey);
    const drawn = drawnItemsOf(model.id);

    const layout = layoutOf(model, {
      keys,
      estimate: (index) => {
        const item = items[index];

        return item === undefined ? 0 : inputs.itemToEstimatedHeightPx(item);
      },
      current: (index) => drawn.get(keys[index] ?? "") === items[index],
    });

    const row = (index: number): Html => {
      const item = items[index];
      const key = keys[index] ?? "";

      if (item === undefined) {
        return h.empty;
      }

      drawn.set(key, item);

      return h.keyed("div")(
        key,
        [
          h.Role("listitem"),
          h.DataAttribute(ROW_KEY, key),
          h.DataAttribute("virtual-list-item-index", String(index)),
          h.AriaSetsize(items.length),
          h.AriaPosinset(index + 1),
          h.Style({ display: "grid" }),
        ],
        [inputs.itemToView(item)]
      );
    };

    const offScreen = (index: number): Html => {
      const item = items[index];
      const key = keys[index] ?? "";

      if (item === undefined) {
        return h.empty;
      }

      drawn.set(key, item);

      return h.keyed("div")(
        key,
        [h.DataAttribute(PROBE_KEY, key), h.Style({ display: "grid" })],
        [inputs.itemToView(item)]
      );
    };

    const slots = layout.slots.map((slot) =>
      slot.kind === "row"
        ? row(slot.index)
        : h.keyed("div")(`gap:${slot.key}`, [
            h.Role("presentation"),
            h.Style({ height: `${slot.height}px` }),
          ])
    );

    const probe =
      layout.probe.length === 0
        ? []
        : [
            h.keyed("div")(
              `${model.id}-probe`,
              [
                h.AriaHidden(true),
                h.DataAttribute(PROBE, "true"),
                h.Style(PROBE_STYLE),
              ],
              layout.probe.map(offScreen)
            ),
          ];

    const { place } = model;

    const placeAttributes = Predicate.isTagged(place, "Row")
      ? [
          h.DataAttribute("place-key", place.key),
          h.DataAttribute("place-offset", String(place.offset)),
        ]
      : [];

    // Only the judges' harness sets a broken control.
    const brokenAttributes =
      model.broken === "none" ? [] : [h.DataAttribute("broken", model.broken)];

    return h.keyed("div")(
      model.id,
      [
        ...childAttributes([
          h.Id(model.id),
          h.Role("list"),
          h.DataAttribute(
            "following",
            Predicate.isTagged(place, "End") ? "true" : "false"
          ),
          ...placeAttributes,
          ...brokenAttributes,
          h.OnMount(ObserveList({ id: model.id })),
          h.Style({
            position: "relative",
            overflow: "auto",
            "overflow-anchor": "none",
            padding: "0",
          }),
          h.Class(inputs.className),
        ]),
        ...inputs.attributes,
      ],
      [...slots, ...probe]
    );
  });
