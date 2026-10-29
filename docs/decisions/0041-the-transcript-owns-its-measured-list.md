---
status: accepted
gate: `range` and `reflow` leave `KNOWN_FAILING` in `judges/transcript-scroll.ts` while their broken controls still fail them, and `judges/typing.ts` and the long-task limit hold
---

# The transcript owns its measured list

`@foldkit/ui`'s virtual list estimates the height of rows it has never drawn and throws away measured heights on a width change, which is why scrolling up into unseen history jumps by up to 328 px and a width change loses the reader's place (stage 2.2; `docs/phase-2/notes/surfaces.md`). Neither can be fixed from outside the library. The transcript replaces it with a small list Cairn owns: exact, frozen row heights, off-screen history detached rather than estimated, and a glyph reader anchor that restores the character being read after a width change (after MonoCode's measured history, 176 lines). It is the look wave's first package, confirmed at the end of the daily-driver day.

Decided by the user on 2026-10-27, from the phase 2 area notes.

Gate evidence (package L1, 2026-10-29): `judges/transcript-scroll.ts` passed with `KNOWN_FAILING` empty, run under the judge lock on the 2,100-row harness. `range`: the 40-tick gesture travelled 6,400 px up and 6,400 px back down with the scroll range moving 0 px, no `scrollTop` or row reversal (the old list: 328 px steps and 17 reversals). `reflow`: the bookmarked glyph ended 0, 0, 0.5 and 0 px from its place at 900, 1,440, 390 and 1,440 px, worst frame 0.5 px (the old list: 25.3 px, worst 156.3 px). The new `insert-above` (a turn inserted three rows above the first visible one; the list made 510 px of room) and `arrive` (a late checkpoint card in a settled answer above; 156 px) moved the first visible row 0 times in 92 frames each. Broken controls: `--broken estimate` fails `range` (304 px steps, 17 reversals), `--broken reflow` fails `reflow` (129.5 px at 390), `--broken anchor` fails `insert-above` and `arrive` (88 frames moved, up to 24.5 px). Follow phase: 0 long tasks in 6 s. The document held 325 elements on load and after the gesture. `judges/typing.ts` (Chromium, 60 s at 20 cps over 514 history rows): 1,200 of 1,200 keys, IME and menus intact; `judges/behaviour.ts` 22 of 22.

As built, history the list never drew is measured off-screen before it joins the scroll range: up to 20 buffers ahead while the reader follows the end, then only after a pause near the range's top, and never while the reader scrolls, so the range holds under a gesture.
