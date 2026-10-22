---
status: proposed
gate: judges/load.ts and judges/push.ts
---

# The PWA loads from inlined boot data, and its service worker only shows pushes

The budget for opening Cairn on the phone is round trips, not bytes. The server inlines the shell snapshot into `index.html` as boot JSON, the page opens its WebSocket as `main.ts`'s first statement, the entry script stays under 288 KiB gzip (amended at wave 4, below) and the CSS under 35 KB, and the diff and settings code load on demand. Each load's timing marks reach the server log as one `load.report` line. The service worker caches nothing: it shows every push (iOS requires it), focuses or opens the thread on a tap, and has no `fetch` handler, so a stale cache can never serve an old client. Pushes go out when a run over 20 seconds finishes or any run fails while no visible client has the thread, and when Executor needs a sign-in; approvals join in phase 2.

Gate: `judges/load.ts` (the load target on the phone profile) and `judges/push.ts` (a push shown once per run, none while the thread is on screen).

## Amendment at wave 4: the entry budget

The 200 KB gzip entry target is relaxed to a 288 KiB ceiling (`ENTRY_JS_BUDGET` in `apps/web/src/Budget.test.ts`); 200 KB stays as a reported target. Measured at wave 4 integration: entry JS 270,240 B gzip, entry CSS 33,155 B gzip, with `diff` and `settings` as lazy chunks. Effect, foldkit and its UI package are about 100 KB gzip before any Cairn code, so 200 KB is out of reach without dropping a framework. The transcript and markdown stay in the entry: splitting them saves about 30 KB gzip, not enough for 200 KB, and adds a round trip to every cold load of a thread page, which is the cost this ADR budgets. The binding bar is the load judge, which passes against the deployed brain with this entry: lan p50 176 ms, p95 201 ms; 4g (60 ms, 10 Mbps) p50 532 ms, p95 535 ms; 5 requests before interactive; 320,668 bytes transferred; the 1,500 ms control fails as designed (p50 1,680 ms).

This ADR stays proposed until the phone stages of the wizard (load and push on the phone) pass.
