# Phase 2 backlog

The work between the phase 1 gate and the phase 2 plan, in order. Sources: the outside-lessons page (`https://plans.gneiss.run/cairn/v2/outside-lessons/`), the redesign sketch, the kickoff's phase 2 section and the decisions of 2026-10-27 (ADRs 0026 and 0027, the design pass note in ADR 0011). Phase 2's build starts only after the phase 1 gate; stage 2 and the planning in stage 3 do not wait for it.

## Stage 1: decisions

Done on 2026-10-27. Two tiers of work (goal threads and approved briefs, ADR 0026), the user at the top with a child asking its parent (ADR 0027), the design pass after the daily-driver day as phase 2's look wave, phase 2 screens ported in behaviour and drawn once in the new look, the sidebar decided in the pass, hands-off goals after phase 2.

## Stage 2: small tasks

None depends on phase 2 or on the open gate. One worktree and branch (`phase2/s2-<n>`) each, merged with `--no-ff` after its judge passes.

2.1 to 2.9 were merged on 2026-10-27 (`pnpm check` green at 1,310 tests). 2.5's decision: no dispatcher change (`spikes/9-http-idle/NOTES.md`). 2.10 is open.

| Task | What | Judge |
| --- | --- | --- |
| 2.1 Lint rules | Vendor Fold's `no-ambient-nondeterminism` and `no-silent-error-swallow` (after checking the license of their source, typeonce-dev/ai-automation); fix the three `randomUUID` files; decide the five `Effect.serviceOption` sites; refresh anti-slop for its four missing rules. | `pnpm check` green, and each rule's test fails on a planted violation. |
| 2.2 Scroll checks | Two new checks in `judges/transcript-scroll.ts`: the scroll range stays steady within 1 px across a wheel gesture, and the reader's place survives a width change. Prompt anchoring waits for the design pass. | Each check fails against a broken control. |
| 2.3 Quiet check | `pnpm check` prints one line on success and the full output on failure. | One green run and one planted-failure run. |
| 2.4 Stream guard | Abort a non-bridge model's stream after 1,000 whitespace characters in a row, as a retryable error (after Ultimate's `server/tool-arguments.ts`). | A unit test on a faux stream. |
| 2.5 HTTP idle spike | Does Node's default undici timeout cut a quiet codex or opencode stream? | `spikes/9-http-idle/NOTES.md` with measured numbers and a decision. |
| 2.6 Memo-map isolation | A test that a layer built for one scope never hands its services to another (after Fold's `SessionIsolation` test). | The test fails with a shared memo map. |
| 2.7 Bridge upstream | `packages/bridge/UPSTREAM.md`: what was kept and changed against pi-claude-bridge (ADR 0017). | Review against the ADR. |
| 2.8 Thread states | `docs/golden/thread-states.md` (after HumanLayer's `golden/session_state_machine.md`). | A test fails if a protocol status is missing from it. |
| 2.9 Research 03 addendum | The t3code nightly's subagent and workflow model at `fe27e8e3` (`ThreadLineageWorkflowRow`, `WorkflowOpeningBlock`, `ThreadRelationshipsControl`, `ProviderSubagentBar`). | Read against `fe27e8e3`. |
| 2.10 Spread rules | Turn on anti-slop's `no-conditional-empty-array-spread`, then `no-conditional-spread` (vendored off by 2.1: 86 and 63 sites). Rewrite `packages/client-logic` and `apps/server` first, then `apps/web`; drop the `Date.now` scan in `brain/Footguns.test.ts`, which the S8 lint rule now covers. | `pnpm check` green with both rules on. |

## Stage 3: the phase 2 plan

Planned the phase 1 way. Area notes in `docs/phase-2/notes/`: subagents and delivery; briefs, goals and approvals UI; workflows, the dispatch ledger and durable events; role aliases, cost and the Codex login; artifacts and portals through porch; UI and tokens. Proposed ADRs for durable events with exactly-once reactors and, if the design pass forks the shell, a UI fork amending ADR 0015. Then `docs/phase-2/plan.md` in waves. Open question carried from ADR 0026: how a workflow's launch approval relates to the briefs of its nodes. Judge: the user's sign-off.

Carried in from stage 2:

- Subagents and delivery: a layer built for a subagent, child thread or workflow node needs a fresh memo map (`Layer.makeMemoMap` with `Layer.buildWithMemoMap`) or `Layer.fresh`. Plain `Layer.build`, `Effect.provide` and an unwrapped `LayerMap` hand a child the parent's or the root's instances (2.6, `apps/server/src/brain/MemoMapIsolation.test.ts`). Candidate for an ADR.
- Transcript: two findings from 2.2, both failing in `judges/transcript-scroll.ts` and listed in its `KNOWN_FAILING` until fixed. `range`: scrolling up into history that was never drawn moves the scroll range by up to 328 px, because the virtual list estimates unmeasured row heights, and the rows visibly jump back. `reflow`: a width change keeps the first visible row and its offset but not the character being read (25 px off at 390 px wide with the row 24 px above the top; more for a long reply). Both belong to "content never moves under you" and could be fixed before the design pass if the daily-driver day shows them.
- Thread states, from 2.8 (`docs/golden/thread-states.md`): fixed on 2026-10-27, a message the user sends clears the manual settle state and ends a snooze, as t3code does (the settle state was never cleared, and a settled thread stayed on Settled when it ran again). Still open: the sidebar's "Waiting" label can never show (a pending request shows "Approval" or "Input" first, and a thread waiting for a Claude slot shows "Working"); nothing but the scripted harness writes the `cancelled` approval status; a new thread's row is idle for one commit before it is marked preparing. Approval outcomes reach no UI yet; the question card in phase 2 is where they land.
- From 2.9 (`docs/phase-2/notes/t3code-nightly.md`), for the plan: t3code's `delegate_task` and its completion delivery are the template for Cairn's subagent tool; the steps panel succeeds `WorkflowOpeningBlock`; the plan card folds into the brief card. Open: may a parent decide its child's approvals, or only its questions (t3code: only questions; ADR 0013 makes the approval the user's gate); an escalated question shown in the parent and kept on the child resolves exactly once from either thread; whether a single workflow node can be stopped without breaking replay (ADR 0012); these screens have no pixel baseline, so behaviour scripts and conformance scenarios judge them.
- Bridge: compare three pi-claude-bridge fixes after `874fa7c` (abort-signal binding in `38980d1` and `1ae18a2`, the queued-steer MCP fix in `8a60b18`) against the port, and check whether the bridge should set `CLAUDE_CODE_MAX_RETRIES=0` and `CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off` as `docs/phase-1/notes/pi-claude-code.md` recommended (2.7).

## Stage 4: the build, as sketched

For the plan, not binding.

1. Foundations: brief, subagent result (with outcome and divergence) and question schemas; durable events; delivery tasks; one thread-state function; subagent and child-to-parent conformance scenarios.
2. Subagents: Fold's tool contract, role aliases resolved at dispatch, a worktree per child, a `Cairn-Thread` commit trailer, Ultimate's routing rules.
3. Briefs and approvals: the Go approval, one question card for approvals, questions and briefs, permission modes that gate, approval push.
4. The look: tokens, the steps panel, the fold line with tallies, the sidebar as decided in the pass, preview rounds.
5. Workflows: the dispatch ledger, approval before launch with cost and "run on 1 item", budgets, the council recipe.
6. Reach: porch artifacts and portals, a tools-only host for pi TUI extensions, the Codex login.

Then the phase 2 gate.

## Later

Ultimate's lander as phase 3's integrate node. A restart tool that memoizes its result, plus booting the next brain beside the old (ADR 0022). Retest the Worker Loader shell and Durable Object residency against spike 1. Hands-off goals (ADR 0026).
