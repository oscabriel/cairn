---
status: proposed
gate: judges/load.ts and judges/push.ts
---

# The PWA loads from inlined boot data, and its service worker only shows pushes

The budget for opening Cairn on the phone is round trips, not bytes. The server inlines the shell snapshot into `index.html` as boot JSON, the page opens its WebSocket as `main.ts`'s first statement, the entry script stays under 200 KB gzip and the CSS under 35 KB, and the transcript, markdown, diff and settings code load on demand. Each load's timing marks reach the server log as one `load.report` line. The service worker caches nothing: it shows every push (iOS requires it), focuses or opens the thread on a tap, and has no `fetch` handler, so a stale cache can never serve an old client. Pushes go out when a run over 20 seconds finishes or any run fails while no visible client has the thread, and when Executor needs a sign-in; approvals join in phase 2.

Gate: `judges/load.ts` (the load target on the phone profile) and `judges/push.ts` (a push shown once per run, none while the thread is on screen).
