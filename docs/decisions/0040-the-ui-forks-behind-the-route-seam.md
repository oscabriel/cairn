---
status: accepted
gate: `judges/behaviour.ts` and the surface scripts green on `next` at 390 and 1,440 px, `judges/typing.ts` with zero dropped keys, and the user's explicit switch
---

# The UI forks behind the route seam, and the fork replaces the classic views

Amends ADR 0015. The look wave builds a `next` set of views beside the classic ones, on one shared store and `packages/client-logic`, picked by a client setting and loaded as a dynamic chunk (the entry bundle is at its gzip ceiling). Phase 2's new screens are built only in `next`. Classic stays frozen under the parity judges until the user switches; then the classic views and the pixel-parity judges are deleted. The phone must be on `next` before the phase 2 gate, because the gate runs from the phone.

New screens have no pixel baseline, so they are judged by ported t3code logic tests, behaviour scripts over the scripted harness at 390 and 1,440 px, and rule checks (no horizontal overflow, 44 px hit targets, tokens only); each preview round the user approves freezes its screenshots as a baseline. Tokens are built for dark and light from the start; preview rounds run in dark.

Decided by the user on 2026-10-27, from the phase 2 area notes.

Accepted at the cutover (plan 7A, 2026-10-30), on the user's switch. Gate evidence on `main` with `next` as the only views: `judges/behaviour.ts --strict` 30 of 30 at 390 and 1,440 px (its `footer-measure` control fails 980 and 820 as it should); the surface scripts `surfaces.ts` 10 of 10, `rollup.ts` 8 of 8, `rows-subagent.ts` 12 of 12, `work-panel.ts` 4 of 4, `meters.ts` 4 of 4; `judges/typing.ts chromium` 1,200 of 1,200 keys, none dropped; `transcript-scroll.ts` with no check failing and its controls caught; `look.ts capture --strict` 32 of 32 clean; `load.ts --local` p50 196 ms on LAN and 572 ms on 4G with 4 requests. As built, the frame is in the entry bundle, not a chunk: with the classic views gone, a second fetch would only add a round trip. The `ui` setting, `?ui=` and the parity judges are deleted; the classic sidebar's state stays for its clock, key bindings and visits.

Amended: the fork ended on 2026-11-10: `next/` (`apps/web/src/next/`) was folded into the feature folders, so one feature is one folder again: the frame is `apps/web/src/Frame.ts`, the shell `apps/web/src/shell/`, the primitives and the look catalogue `apps/web/src/ui/`, and the design tokens `apps/web/src/tokens.css` (unchanged by a byte). No source path is named `next` any more; the name is kept on purpose in names of these kinds, not every one listed: the frame's `data-ui="next"` attribute, the root Model's `nextShell` names, the chat header's `next-chat-header` and `next-header-*` test ids and the shell's `next-header-*` and `next-shell-*` slot ids, the scratch thread's storage key, the behaviour judge's report and screenshot folder, a few local names in the judges and the timeline harness, sample paths in the judges' fixtures and frozen look rounds, and the comments of the hash-frozen `tokens.css` (glossary: Next (views)). No view, behaviour or bundle changed (review finding W-6).
