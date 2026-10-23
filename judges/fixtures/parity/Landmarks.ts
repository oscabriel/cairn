/// <reference lib="dom" />
// Landmarks for the parity judges (plan 4F): the elements both apps mark with the same hooks, read
// from a live page with their boxes and computed tokens. judges/capture.ts writes one file per
// state; judges/parity-structure.ts compares t3code's file with Cairn's; judges/behaviour.ts reads
// the composer footer part.
import { Schema } from "effect";
import type { Page } from "playwright";

/** A rectangle in CSS pixels of the viewport. */
export const Rect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

/** One landmark element: its key, box and the computed tokens the structure judge compares. */
export const Landmark = Schema.Struct({
  key: Schema.String,
  box: Rect,
  tokens: Schema.Record(Schema.String, Schema.String),
  className: Schema.String,
});

/** How a footer block (`data-resting-block`) shows at one width. */
export const FooterBlockState = Schema.Literals([
  "full",
  "icon-only",
  "hidden",
]);

/** What the composer footer shows at one width, for judges/behaviour.ts. */
export const FooterReading = Schema.Struct({
  composerWidth: Schema.Finite,
  blocks: Schema.Record(Schema.String, FooterBlockState),
  /** Whether the overflow menu button ("More composer controls") shows. */
  overflow: Schema.Boolean,
});

export const LandmarkFile = Schema.Struct({
  footer: FooterReading,
  landmarks: Schema.Array(Landmark),
});

export type LandmarkFile = typeof LandmarkFile.Type;

/**
 * Reads every landmark on the page. A landmark is an element carrying a shared hook: `data-testid`,
 * `data-timeline-row-kind` (with `data-message-role` when present), a `data-chat-*`,
 * `data-composer-*` or `data-changed-files-*` attribute, or `data-slot`; an `h1` and a labelled
 * `nav` (`nav=Settings breadcrumb`) count too.
 * Keys repeat with an index; transcript rows count from the end (`row:message#-1` is the last),
 * because the two lists virtualize different amounts of history above the view.
 */
export const readLandmarks = async (page: Page): Promise<LandmarkFile> =>
  Schema.decodeSync(LandmarkFile)(
    await page.evaluate(() => {
      const COLOURS = new Set(["color", "background-color"]);

      // Colours are compared as the pixel they paint: t3code's tokens compute to `rgb()` and
      // Cairn's to `oklab()`, the same colour written two ways.
      const probe = document
        .createElement("canvas")
        .getContext("2d", { willReadFrequently: true });

      const asRgba = (value: string): string => {
        if (probe === null) {
          return value;
        }

        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = "#000";
        probe.fillStyle = value;
        probe.fillRect(0, 0, 1, 1);

        const [red, green, blue, alpha] = probe.getImageData(0, 0, 1, 1).data;

        return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
      };

      const TOKENS = [
        "font-size",
        "line-height",
        "font-weight",
        "color",
        "background-color",
        "padding-top",
        "padding-right",
        "padding-bottom",
        "padding-left",
        "border-radius",
        "border-top-width",
      ];

      // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
      const keyOf = (element: HTMLElement | SVGElement): string | null => {
        const { testid, timelineRowKind, messageRole, slot } = element.dataset;

        if (testid !== undefined) {
          return `testid=${testid}`;
        }

        if (timelineRowKind !== undefined) {
          return messageRole === undefined
            ? `row:${timelineRowKind}`
            : `row:${timelineRowKind}:${messageRole}`;
        }

        const hook = [...element.attributes].find(
          (attribute) =>
            attribute.name.startsWith("data-chat-") ||
            attribute.name.startsWith("data-composer-") ||
            attribute.name.startsWith("data-changed-files-")
        );

        if (hook !== undefined) {
          return hook.name;
        }

        if (slot !== undefined && !slot.startsWith("toast")) {
          return `slot=${slot}`;
        }

        // Breadcrumbs carry no data hook in t3code, so a labelled nav counts by its label.
        const navLabel =
          element.tagName === "NAV"
            ? (element.getAttribute("aria-label") ?? undefined)
            : undefined;

        if (navLabel !== undefined) {
          return `nav=${navLabel}`;
        }

        return element.tagName === "H1" ? "h1" : null;
      };

      const found = [
        ...document.querySelectorAll<HTMLElement | SVGElement>("body *"),
      ].flatMap((element) => {
        const key = keyOf(element);
        const box = element.getBoundingClientRect();

        if (key === null || box.width === 0 || box.height === 0) {
          return [];
        }

        const style = getComputedStyle(element);

        if (style.visibility === "hidden" || style.display === "none") {
          return [];
        }

        return [
          {
            key,
            box: {
              x: Math.round(box.x * 2) / 2,
              y: Math.round(box.y * 2) / 2,
              width: Math.round(box.width * 2) / 2,
              height: Math.round(box.height * 2) / 2,
            },
            tokens: Object.fromEntries(
              TOKENS.map((token) => [
                token,
                COLOURS.has(token)
                  ? asRgba(style.getPropertyValue(token))
                  : style.getPropertyValue(token),
              ])
            ),
            className:
              element.getAttribute("class")?.replaceAll(/\s+/gu, " ") ?? "",
          },
        ];
      });

      const counts = new Map<string, number>();
      const totals = new Map<string, number>();

      for (const landmark of found) {
        totals.set(landmark.key, (totals.get(landmark.key) ?? 0) + 1);
      }

      const landmarks = found.map((landmark) => {
        const seen = counts.get(landmark.key) ?? 0;

        counts.set(landmark.key, seen + 1);

        const index = landmark.key.startsWith("row:")
          ? seen - (totals.get(landmark.key) ?? 0)
          : seen;

        return { ...landmark, key: `${landmark.key}#${index}` };
      });

      const editor = document.querySelector('[data-testid="composer-editor"]');
      const form = editor?.closest("form") ?? editor?.parentElement ?? null;

      // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
      const shows = (element: Element) =>
        element.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        });

      const blocks = Object.fromEntries(
        [...document.querySelectorAll<HTMLElement>("[data-resting-block]")].map(
          (block): readonly [string, typeof FooterBlockState.Type] => {
            const name = block.dataset.restingBlock ?? "";

            if (block.dataset.composerBlockHidden === "true" || !shows(block)) {
              return [name, "hidden"];
            }

            return [
              name,
              block.dataset.composerBlockIconOnly === "true"
                ? "icon-only"
                : "full",
            ];
          }
        )
      );

      return {
        footer: {
          composerWidth: Math.round(form?.getBoundingClientRect().width ?? 0),
          blocks,
          overflow: [
            ...document.querySelectorAll(
              '[aria-label="More composer controls"]'
            ),
          ].some(shows),
        },
        landmarks,
      };
    })
  );
