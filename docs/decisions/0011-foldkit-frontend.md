---
status: proposed
gate: S2
---

# Foldkit for the web client

Foldkit 0.168 is the user's choice of an Effect-native frontend, gated on the two hardest surfaces: the composer and the inbox sidebar. Its risks are an exact `effect@4.0.0` pin (overridden to 4.0.5), an open controlled-input keystroke-loss bug (#1697), a breaking redesign in preview (#1655) and a single maintainer. The fallback is React 19 with `@effect/atom-react`, t3code's own stack.

Gate S2: zero dropped keystrokes at 20 characters per second for 60 s while a transcript streams, on desktop Chromium on the Beelink and iOS-width WebKit on the MacBook, with IME composition; and a reviewer model from another family plus the user judge the sidebar and composer at parity with t3code at 1440 and 390 px.
