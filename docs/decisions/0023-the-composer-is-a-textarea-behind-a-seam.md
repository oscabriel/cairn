---
status: accepted
gate: judges/typing.ts
---

# The composer is a textarea behind an editor seam

The composer's editor is a plain textarea behind one module, `composer/Editor.ts`, that the rest of the composer talks to. The textarea passed spike 2's typing judge on Foldkit 0.169.0; t3code's Tiptap editor would be about 4,000 ported lines and a second typing gate, and the user said the inline chips need not match t3code's. Tiptap stays possible as a later, separate spike that swaps the module behind the seam and must pass the same judge.

Gate: `judges/typing.ts` on the real client: no dropped keystroke at 20 characters a second for 60 seconds while a transcript streams, in Chromium and in WebKit at phone width, with IME composition.

## Gate result (2026-10-22)

- Chromium (wave 5 step 2): 1,200 of 1,200 keys at desktop width and at phone width with 4x CPU throttle, stream ok, IME composition ok, menus ok.
- WebKit at phone width (Playwright WebKit on the MacBook, macOS 27.2, against commit 2c91fc1): 1,200 of 1,200 keys in 60 s at 20 a second while 484 rows streamed, match, 1 late key (0 ms), menus path, skill and slash-command ok, no errors.
- IME composition was judged in Chromium only: Playwright's WebKit has no way to drive a composition, so `typing.ts` reports `ime: skipped` there. Accepted on that basis; typing on the iPhone itself (wizard stages 4 and 8) is the real-device check.
- `judges/load.ts --browser webkit` against the deployed brain on the same run: lan p50 358 ms, p95 390 ms, 6 requests before interactive.
