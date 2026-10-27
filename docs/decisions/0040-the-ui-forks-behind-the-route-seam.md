---
status: proposed
gate: `judges/behaviour.ts` and the surface scripts green on `next` at 390 and 1,440 px, `judges/typing.ts` with zero dropped keys, and the user's explicit switch
---

# The UI forks behind the route seam, and the fork replaces the classic views

Amends ADR 0015. The look wave builds a `next` set of views beside the classic ones, on one shared store and `packages/client-logic`, picked by a client setting and loaded as a dynamic chunk (the entry bundle is at its gzip ceiling). Phase 2's new screens are built only in `next`. Classic stays frozen under the parity judges until the user switches; then the classic views and the pixel-parity judges are deleted. The phone must be on `next` before the phase 2 gate, because the gate runs from the phone.

New screens have no pixel baseline, so they are judged by ported t3code logic tests, behaviour scripts over the scripted harness at 390 and 1,440 px, and rule checks (no horizontal overflow, 44 px hit targets, tokens only); each preview round the user approves freezes its screenshots as a baseline. Tokens are built for dark and light from the start; preview rounds run in dark.

Decided by the user on 2026-10-27, from the phase 2 area notes.
