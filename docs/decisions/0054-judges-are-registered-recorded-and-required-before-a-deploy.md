---
status: proposed
gate: `pnpm check` green with `judges/index.test.ts`, `judges/lib/Record.test.ts`, `ops/cairn/idle-guard.test.ts` and `apps/server/src/push/NightlyFailedRoute.test.ts` passing; then on the Beelink, `node judges/run-set.ts` passes on a clean commit and `ops/cairn/deploy.sh` deploys it without `--override`, and the user receives the nightly's failure push on the phone from a night that failed (or from `systemctl --user start cairn-nightly-failed.service`)
---

# Judges are registered, recorded and required before a deploy

"A step is done when its outside judge says so" assumes someone knows which judges exist, runs them and reads them. Until now nothing did: `judges/` held about seventy judges with no index, a pass lived only in commit messages and wave notes, the only judge on a timer (the durability nightly) failed for ten nights without anyone hearing of it, and `main` reached the deploy with nothing beyond `pnpm check` recorded on it (review findings C-1, C-2, V-3 and V-6, 2026-11-09).

## Decisions

1. **Every judge has an entry in `judges/index.ts`.** One entry per judge: its name, its files, what it proves (the kickoff target or ADR gate it holds), how it runs (`check`, `nightly`, `set`, `wizard`, `hand`), what it costs (free, or which real model and roughly how much, and the flags that change that), what it needs (a browser, the deployed brain, Docker, porch) and its broken control, or `none` so the gap is visible. `judges/index.test.ts` in `pnpm check` fails when a `.ts` or `.sh` file at the top of `judges/` has no entry or an entry names a missing file. Adding a judge means adding its entry in the same change.
2. **A judge run leaves a record.** When a free judge ends it appends one JSON line to `~/cairn-judges/records.jsonl` (`judges/lib/Record.ts`; `CAIRN_JUDGE_RECORDS` moves it): the judge, its arguments, the commit, whether the tree was clean, pass or fail (its exit code), the numbers on its last JSON line, the time and the cost. A TypeScript judge does it with one `recordOnExit(import.meta)` call; a shell judge sources `judges/lib/record.sh`; the nightly writes its own line with its step counts. The file lives outside the repo, so a record never needs a commit, and an unrecorded run is not evidence. `node judges/status.ts` prints the registry joined with each judge's last record on a commit, and a handoff quotes it.
3. **A deploy needs a passing pre-deploy set.** `SET` in `judges/index.ts` is every free judge that needs no model, no deployed brain, no Docker and no porch, read-only checks first, kill judges, browser judges, then the systemd ones. `node judges/run-set.ts` runs it in order under the judge lock (`flock /tmp/cairn-judge.lock`), records each result and the set's own line, and exits non-zero if any failed. `ops/cairn/deploy.sh` refuses a commit whose newest set run on a clean tree did not pass, and refuses unless every live thread is idle or failed with an empty queue (`ops/cairn/idle-guard.sh`), checked before anything moves and again just before the restart. `--override` deploys past either and prints which it overrode; the nightly and pi pin guards keep no override.
4. **A failed nightly reaches the user.** `cairn-nightly.service` names `cairn-nightly-failed.service` in `OnFailure=`. That unit posts to `POST /_cairn/notify/nightly-failed` on the brain's loopback port, which pushes one fixed message ("The nightly judges failed", with where its log is) to every subscribed device through the notifier. The route answers only a process on this host, as `/_cairn/health` does: 404 to anything through Caddy or from another address, 403 to anything with an `Origin` or fetch metadata header, and it never reads a body, so a caller chooses only that the push goes, never what it says.

## Consequences

- The set takes a few hours, so a deploy waits for a quiet stretch; `--override` exists for an urgent fix, and says so on every use.
- A paid judge (bridge, OpenCode Go, the deployed brain) is not in the set and records nothing yet; its row in `status.ts` says "no record", which is the honest answer.
- A judge another change adds must come with its entry, or `pnpm check` fails.
