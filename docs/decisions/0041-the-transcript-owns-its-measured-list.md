---
status: proposed
gate: `range` and `reflow` leave `KNOWN_FAILING` in `judges/transcript-scroll.ts` while their broken controls still fail them, and `judges/typing.ts` and the long-task limit hold
---

# The transcript owns its measured list

`@foldkit/ui`'s virtual list estimates the height of rows it has never drawn and throws away measured heights on a width change, which is why scrolling up into unseen history jumps by up to 328 px and a width change loses the reader's place (stage 2.2; `docs/phase-2/notes/surfaces.md`). Neither can be fixed from outside the library. The transcript replaces it with a small list Cairn owns: exact, frozen row heights, off-screen history detached rather than estimated, and a glyph reader anchor that restores the character being read after a width change (after MonoCode's measured history, 176 lines). It is the look wave's first package, confirmed at the end of the daily-driver day.

Decided by the user on 2026-10-27, from the phase 2 area notes.
