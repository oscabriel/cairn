---
status: accepted
gate: S2
---

# Foldkit for the web client

Foldkit is the user's choice of an Effect-native frontend, gated on the two hardest surfaces: the composer and the inbox sidebar. Its risks are an exact `effect@4.0.0` pin (overridden to 4.0.5), a controlled-input keystroke-loss bug (#1697, fixed in 0.169.0, so Cairn pins 0.169.0 or later), a breaking redesign in preview (#1655) and a single maintainer. The fallback is React 19 with `@effect/atom-react`, t3code's own stack.

Gate S2: zero dropped keystrokes at 20 characters per second for 60 s while a transcript streams, on desktop Chromium on the Beelink and iOS-width WebKit on the MacBook, with IME composition; and a reviewer model from another family plus the user judge the sidebar and composer at parity with t3code at 1440 and 390 px.

Passed on 2026-10-21; measured in `spikes/2-foldkit/NOTES.md`. No keystroke was dropped in Chromium (throttled to 6x) or in WebKit on the MacBook, and IME worked. The spike rendered t3code's own markup and CSS, pixel-identical at both widths, and both judges said "same". Matching pixels proves Foldkit can render t3code's surfaces; it does not commit Cairn to t3code's look, which the user may move away from in Phase 1.

The user's direction for phase 1 (2026-10-22): keep the UI basic and functional, leaning toward t3code's look, without copying its distinct brand elements (the name, the logo); a design pass for Cairn's own branding comes later. The composer need not match t3code's inline chips exactly, and Tiptap may still be the right editor.

The design pass (decided 2026-10-27): it starts after the phase 1 gate's daily-driver day and becomes phase 2's look wave, so what that day shows drives it. Phase 2's screens are built once, in the new look: where the t3code nightly has a counterpart (subagent rows, workflow blocks, approval and question panels, the plan card), its behaviour is ported as a port of intent and redrawn; new surfaces (briefs, the steps panel, budgets, role aliases) are designed from scratch. Whether the inbox stays the whole sidebar or becomes the top entry of a project rail is decided in the pass; until a fork is judged and switched to, ADR 0015's parity rule still binds the phase 1 surfaces.
