// Ported from github.com/pingdotgg/t3code, apps/mobile/src/features/threads/ComposerUsageLimits.tsx
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the content, one account ("Claude") with each
// limit window's share used and its reset time, and a notice line when nothing is known. Changed: a
// compact meter for the composer footer instead of a dismissible sheet; it leads with the window
// nearest its limit (a spent window reads "Limited" with its reset), lists every window in its
// title, and shows only while the composer's model is on the Claude bridge. An unknown share reads
// "unknown", never 0%.
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

import type { PlanWindow, UsageSnapshot } from "@cairn/protocol/Usage";
import { Array, Option, Order } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { formatDayTime, formatUsed } from "../settings/Time.ts";

/** The provider id of Claude through the bridge, whose plan windows the meter shows. */
export const BRIDGE_PROVIDER = "claude-bridge";

/** What the meter reads: the newest usage frame and the provider the composer's model is on. */
export interface UsageMeterInput {
  readonly usage: Option.Option<UsageSnapshot>;
  readonly provider: string;
}

/** How near its limit a window is: spent first, then by share used; unknown sorts last. */
const nearness = (window: PlanWindow): number =>
  window.exhausted ? 2 : Option.getOrElse(window.used, () => -1);

const byNearness = Order.mapInput(Order.flip(Order.Number), nearness);

/** The window nearest its limit, among the bridge's windows. */
export const leadingWindow = (
  input: UsageMeterInput
): Option.Option<PlanWindow> =>
  input.provider === BRIDGE_PROVIDER
    ? Option.flatMap(input.usage, (snapshot) =>
        Option.flatMap(
          Array.findFirst(
            snapshot.providers,
            (provider) => provider.provider === BRIDGE_PROVIDER
          ),
          (provider) => Array.head(Array.sort(provider.windows, byNearness))
        )
      )
    : Option.none();

/** One window as text: "Session 42%", or "Session limited, resets Thu 3:00 PM". */
export const windowText = (window: PlanWindow): string =>
  window.exhausted
    ? `${window.label} limited${Option.match(window.resetsAt, {
        onNone: () => "",
        onSome: (at) => `, resets ${formatDayTime(at)}`,
      })}`
    : `${window.label} ${formatUsed(window.used)}`;

const allWindowsText = (input: UsageMeterInput): string =>
  Option.match(
    Option.flatMap(input.usage, (snapshot) =>
      Array.findFirst(
        snapshot.providers,
        (provider) => provider.provider === BRIDGE_PROVIDER
      )
    ),
    {
      onNone: () => "Claude usage limits",
      onSome: (provider) =>
        ["Claude usage limits", ...provider.windows.map(windowText)].join("\n"),
    }
  );

/** The meter for the composer footer; nothing unless the model is on Claude and a window is known. */
export const usageMeterView = <Message>(
  h: HtmlBuilder<Message>,
  input: UsageMeterInput
): Html =>
  Option.match(leadingWindow(input), {
    onNone: () => h.empty,
    onSome: (window) =>
      h.span(
        [
          h.DataAttribute("testid", "composer-usage-meter"),
          h.DataAttribute("window", window.id),
          h.DataAttribute("exhausted", String(window.exhausted)),
          h.Title(allWindowsText(input)),
          h.Class(
            window.exhausted
              ? "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-warning"
              : "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground"
          ),
        ],
        [
          h.span(
            [
              h.Attribute("aria-hidden", "true"),
              h.Class(
                "relative h-1.5 w-6 overflow-hidden rounded-full bg-muted"
              ),
            ],
            [
              h.span([
                h.Class(
                  window.exhausted
                    ? "absolute inset-y-0 left-0 bg-warning"
                    : "absolute inset-y-0 left-0 bg-primary"
                ),
                h.Style({
                  width: window.exhausted
                    ? "100%"
                    : `${Math.round(Option.getOrElse(window.used, () => 0) * 100)}%`,
                }),
              ]),
            ]
          ),
          windowText(window),
        ]
      ),
  });
