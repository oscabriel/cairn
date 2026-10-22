---
status: proposed
gate: judges/typing.ts
---

# The composer is a textarea behind an editor seam

The composer's editor is a plain textarea behind one module, `composer/Editor.ts`, that the rest of the composer talks to. The textarea passed spike 2's typing judge on Foldkit 0.169.0; t3code's Tiptap editor would be about 4,000 ported lines and a second typing gate, and the user said the inline chips need not match t3code's. Tiptap stays possible as a later, separate spike that swaps the module behind the seam and must pass the same judge.

Gate: `judges/typing.ts` on the real client: no dropped keystroke at 20 characters a second for 60 seconds while a transcript streams, in Chromium and in WebKit at phone width, with IME composition.
