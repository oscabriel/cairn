---
status: proposed
gate: on the driver, `pnpm check` green; `judges/behaviour.ts --strict`, `surfaces.ts`, `rollup.ts`, `rows-subagent.ts`, `work-panel.ts`, `meters.ts`, `typing.ts chromium`, `transcript-scroll.ts`, `load.ts --local`, `subagent-flows.ts`, `workflow-surfaces.ts`, `goal-chip.ts` at their last Playwright results with their controls still failing, and `look.ts capture --strict` rules passing; the user decides what `look.ts check` does about any pixel difference
---

# Browser judges drive system Chromium

Amends ADR 0014 and ADR 0023, and the kickoff's Composer and Tools targets.

The user removed Playwright from the machine on 2026-11-04: `~/.cache/ms-playwright` is gone, so `chromium.launch()` could not start and no browser judge could run. The rule now is that no UI check uses Playwright, whether the MCP server, the CLI or the npm package. The system browser is `/usr/bin/chromium`.

## Decisions

1. **The judges have their own driver.** `judges/lib/Browser.ts`, with `Cdp.ts`, `BrowserKeys.ts` and `BrowserPageScript.ts`, launches `/usr/bin/chromium --headless=new` (`CAIRN_CHROMIUM` overrides it) over `--remote-debugging-pipe`, with no new dependency. It covers exactly the part of Playwright's API the 23 browser judge files call, under the same names and defaults: contexts, pages, chained locators with auto-waiting and strict single-match behaviour, actionability before a click, real key events, touch, routes, WebSocket routes, init scripts and screenshots. `judges/lib/Browser.test.ts` judges it against a real Chromium inside `pnpm check`, with broken controls for strictness and auto-waiting. `agent-browser` stays for by-hand checks: one process per action is too coarse for the typing and scroll judges.
2. **WebKit leaves automated judging.** The user tests on a real iPhone by hand. This amends the kickoff's Composer target, which named iOS-width WebKit, and ADR 0023's WebKit tier: `judges/typing.ts` and `judges/load.ts` drop their WebKit branches and flags. The soft-keyboard check and `typing.ts --mobile` run in Chromium's iPhone emulation, which is what they ran in on the Beelink before.
3. **The Playwright MCP server goes.** The stdio relay serves `convex` alone, and its shared headless Chrome on port 3775 goes with the server, which amends ADR 0014. The kickoff's Tools target narrows to the servers that remain, and `judges/tools.ts` covers those. Port 3775 is free.
4. **The browser is no longer pinned.** Playwright pinned its Chromium build; the system package moves when the machine updates. A rendering change therefore shows up as drift in `judges/look.ts check`, as a Playwright upgrade did, and needs the user's approval for a new frozen round like any other.

Decided by the user on 2026-11-04.

Evidence so far (2026-11-04, Chromium 154.0.8037.97, uncommitted in a worktree off `a160935`): `pnpm check` green with 2,700 tests. `behaviour.ts --strict` 39 of 39, `surfaces.ts` 10 of 10, `rollup.ts` 8 of 8, `rows-subagent.ts` 12 of 12, `work-panel.ts` 4 of 4, `meters.ts` 2 of 2 (one check since ADR 0043, at two widths), `typing.ts chromium` 1,200 of 1,200 keys with 0 slow views, `transcript-scroll.ts` no failing check, `load.ts --local` lan p50 250 ms and 4g p50 611 ms, `subagent-flows.ts` 8 of 8, `workflow-surfaces.ts` 4 of 4, `goal-chip.ts` 8 of 8; all 30 `--broken` controls fail, as do `load.ts`'s held-document control and `look.ts`'s planted ones. `look.ts capture --strict` holds 40 shots with no rule finding. `look.ts check` fails on round 10: 37 of 40 shots byte-identical, and 3 drifted, which is the user's to judge. This stays proposed until the user has.
