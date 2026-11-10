// The room the hero's `/`, `@` and `$` menu drawer has (U-21): the drawer lies over the headline,
// above the box, so the box never moves when it opens; it must then never be taller than the space
// between the top of the page's scrolled content and the box, or its first rows sit above the
// page's top edge, where no scroll reaches (a phone with its keyboard up, a short window). That
// space depends on where the centred block lands, which only the browser knows, so it is measured:
// whenever the page or the block resizes, the room is written to `--hero-drawer-room` on the block,
// and the hero's classes (`hero/Hero.ts`) cap the drawer's list by it, less a margin. It lives with the
// composer, whose Message it answers with, as `Footer.ts`'s measuring does.

import { Effect } from "effect";
import { Mount } from "foldkit";

import { Message } from "./Message.ts";

/** The custom property the room is written to, in pixels; `hero/Hero.ts`'s classes read it. */
const DRAWER_ROOM_PROPERTY = "--hero-drawer-room";

/** Where the box and the page's scroller sit on screen, and how far the scroller is scrolled. */
export interface RoomReading {
  /** The top of the scroller's padding box, on screen. */
  readonly scrollerTop: number;
  readonly scrollTop: number;
  /** The top of the composer box, on screen. */
  readonly boxTop: number;
}

/**
 * The drawer's room: from the top of the scroller's content (which a scroll reaches) to the top of
 * the box, whole pixels, never negative.
 */
export const drawerRoomOf = (reading: RoomReading): number =>
  Math.max(
    0,
    Math.floor(reading.boxTop - reading.scrollerTop + reading.scrollTop)
  );

/** The box the drawer sits on: the composer card's wrapper. */
const BOX = "[data-slot=composer-shell]";

/**
 * Keeps `--hero-drawer-room` on the hero's block (`element`) while it is shown: measured now and
 * whenever the page's scroller or the block resizes (a window or keyboard change, the headline
 * wrapping, the box growing), since either moves the centred box.
 */
export const KeepDrawerRoom = Mount.define("KeepDrawerRoom", {
  messages: [Message.StartedHeroDrawerRoom],
  execute: ({ element }) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const scroller = element.parentElement;

          const measure = () => {
            const box = element.querySelector(BOX);

            if (scroller === null || box === null) {
              return;
            }

            const room = drawerRoomOf({
              scrollerTop:
                scroller.getBoundingClientRect().top + scroller.clientTop,
              scrollTop: scroller.scrollTop,
              boxTop: box.getBoundingClientRect().top,
            });

            if (element instanceof HTMLElement) {
              element.style.setProperty(DRAWER_ROOM_PROPERTY, `${room}px`);
            }
          };

          const observer = new ResizeObserver(measure);

          observer.observe(element);

          if (scroller !== null) {
            observer.observe(scroller);
          }

          measure();

          return observer;
        }),
        (observer) =>
          Effect.sync(() => {
            observer.disconnect();
          })
      );

      return Message.StartedHeroDrawerRoom();
    }),
});
