---
status: accepted
gate: S2
---

# Foldkit for the web client

Foldkit is the user's choice of an Effect-native frontend, gated on the two hardest surfaces: the composer and the inbox sidebar. Its risks are an exact `effect@4.0.0` pin (overridden to 4.0.5), a controlled-input keystroke-loss bug (#1697, fixed in 0.169.0, so Cairn pins 0.169.0 or later), a breaking redesign in preview (#1655) and a single maintainer. The fallback is React 19 with `@effect/atom-react`, t3code's own stack.

Gate S2: zero dropped keystrokes at 20 characters per second for 60 s while a transcript streams, on desktop Chromium on the Beelink and iOS-width WebKit on the MacBook, with IME composition; and a reviewer model from another family plus the user judge the sidebar and composer at parity with t3code at 1440 and 390 px.

Passed on 2026-10-21; measured in `spikes/2-foldkit/NOTES.md`. No keystroke was dropped in Chromium (throttled to 6x) or in WebKit on the MacBook, and IME worked. The spike rendered t3code's own markup and CSS, pixel-identical at both widths, and both judges said "same". Matching pixels proves Foldkit can render t3code's surfaces; it does not commit Cairn to t3code's look, which the user may move away from in Phase 1.
