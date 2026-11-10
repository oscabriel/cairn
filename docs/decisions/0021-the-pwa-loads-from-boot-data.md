---
status: accepted
gate: judges/load.ts and judges/push.ts
---

# The PWA loads from inlined boot data, and its service worker only shows pushes

The budget for opening Cairn on the phone is round trips, not bytes. The server inlines the shell snapshot into `index.html` as boot JSON, the page opens its WebSocket as `main.ts`'s first statement, the entry script stays one file under its gzip ceiling (288 KiB at wave 4, 315.5 KiB since 2026-11-10; both amendments below) and the CSS under 35 KB, and the views a cold load never draws (the diff panel and the settings page among them) load on demand. Each load's timing marks reach the server log as one `load.report` line. The service worker caches nothing: it shows every push (iOS requires it), focuses or opens the thread on a tap, and has no `fetch` handler, so a stale cache can never serve an old client. Pushes go out when a run over 20 seconds finishes or any run fails while no visible client has the thread, and when Executor needs a sign-in; approvals join in phase 2.

Gate: `judges/load.ts` (the load target on the phone profile) and `judges/push.ts` (a push shown once per run, none while the thread is on screen).

## Amendment at wave 4: the entry budget

The 200 KB gzip entry target is relaxed to a 288 KiB ceiling (`ENTRY_JS_BUDGET` in `apps/web/src/Budget.test.ts`); 200 KB stays as a reported target. Measured at wave 4 integration: entry JS 270,240 B gzip, entry CSS 33,155 B gzip, with `diff` and `settings` as lazy chunks. Effect, foldkit and its UI package are about 100 KB gzip before any Cairn code, so 200 KB is out of reach without dropping a framework. The transcript and markdown stay in the entry: splitting them saves about 30 KB gzip, not enough for 200 KB, and adds a round trip to every cold load of a thread page, which is the cost this ADR budgets. The binding bar is the load judge, which passes against the deployed brain with this entry: lan p50 176 ms, p95 201 ms; 4g (60 ms, 10 Mbps) p50 532 ms, p95 535 ms; 5 requests before interactive; 320,668 bytes transferred; the 1,500 ms control fails as designed (p50 1,680 ms).

This ADR stays proposed until the phone stages of the wizard (load and push on the phone) pass.

## Gate result (2026-10-22, Phase 1 wizard)

- Phone cold loads (stage 3, installed PWA on the iPhone over the tailnet, direct path): 138, 140 and 137 ms to the interactive mark against 1,000 ms.
- Phone paste (stage 4): paste to request 76 ms, upload and prepare 200 ms, send to provider request 43 ms, 319 ms in all against 2,000 ms; the model read the word.
- Push (stage 2): `judges/push.ts --send` delivered to one device (web.push.apple.com 201); the user saw it on the locked phone and the tap opened the PWA.

## Amendment 2026-11-10: the entry ceiling, and what earns a raise

The entry JS ceiling is 315.5 KiB gzip (323,072 B, `ENTRY_JS_BUDGET`): 316,724 B measured on 2026-11-10 with about 2% headroom. Since wave 4 the ceiling had been raised to just above each build, from 288 KiB through 300 and 315 to 326 KiB (seven raises, the last over a 332,947 B entry), and the check that kept settings out of the entry passed on nothing once the 7A cutover drew every view from the entry, so the number judged nothing (review finding W-8).

What changed: the views a cold load never draws are chunks of their own (`apps/web/src/next/page/Chunks.ts`): the settings page, the usage page with its budget forms, the model picker and the composer's other menus, the add-project picker, the work and goal panels, the refresh confirm and the rename and remove dialog, beside the diff panel and syntax highlighting as before. Their state, Messages and updates stay in the entry, so the Model is whole from the first update. A chunk is fetched the first time its view is wanted, and every chunk once more a second after the page is interactive, so a later open draws at once; a view drawn before its chunk arrives draws nothing until it does, a picker takes its focus on arrival, and a failed fetch says so in the notice bar and is tried again on the next open. The entry stays one script (a Rolldown code-splitting group in `apps/web/vite.config.ts`), so the requests before interactive are unchanged: `index.html`, the entry script, the CSS and `/ws`. `Budget.test.ts` fails when the entry is more than one script, and names a module of each deferred view that must not be in the entry's static closure, whatever imports it.

What earns a raise from now on: a named feature drawn on a thread list or a thread's first page, which therefore cannot load later, with its measured cost in gzip bytes, approved in the commit that raises the number. Anything a cold load does not draw goes into a chunk instead. The binding bar stays `judges/load.ts`.
