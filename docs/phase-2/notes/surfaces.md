# Phase 2 notes: surfaces and the look wave

Written 2026-10-27 for the stage 3 planner. Scope: the screens phase 2 adds, what the design pass (ADR 0011's last paragraph, phase 2's look wave) needs before it starts, and the judges for screens that have no pixel baseline. It prepares decisions and makes none: palette, layout, the sidebar and every visual choice stay with the pass and the user. Cairn is read at `e73dd9c`. t3code is read at `fe27e8e3` (ADR 0015); where this note leans on `docs/phase-2/notes/t3code-nightly.md` it says so, and three citations it adds (`ThreadDetailsPanel.tsx`, `ThreadDetailsCard.tsx`, `threadDetailsCardLayout.ts`) were read here. Line numbers are at the named commit.

## Summary

1. **Twelve surfaces, eight with a nightly counterpart.** Approval and question card, subagent rows, lineage panel, child-request rollup, steps panel (successor of `WorkflowOpeningBlock`), the fold line's tallies, the plan-window meter and the brief's reading view have one in whole or part. Goal thread, brief and Go, workflow launch approval, dollar meters, artifact entries and portal entries are new. Section "Inventory" gives each one's data, states and 390 px behaviour.
2. **Phase 1 has none of the approval-shaped UI.** `thread.respond` exists in the protocol (`packages/protocol/src/Thread.ts:307-313`) and no web code calls it; `docs/golden/thread-states.md` says "There is no approval card yet". The approval record carries one `summary` line, `tool` and `kind` (`apps/server/src/brain/CairnDocs.ts:84-100`), so even t3code's command-in-a-mono-block panel cannot be drawn until the record carries the call's detail. The brief and the question are payloads the record does not have either.
3. **The client has no lineage, subagent or workflow field.** `ThreadShell` (`packages/protocol/src/Shell.ts:117-156`) has no parent; the thread stream's visible documents are five (`VISIBLE_DOCUMENTS`, `packages/protocol/src/Thread.ts:57-63`). Each client-logic port header lists subagents as "not ported". Every surface below needs a protocol addition, listed under "Protocol additions", and each addition re-runs `judges/wire-budget.ts` (ADR 0020).
4. **Re-theming is cheap; redrawing is not.** Views use 538 semantic colour utilities against 14 palette utilities and 9 hex or rgb literals, and about 100 semantic properties sit in one file (`apps/web/src/styles.css`, 2,432 lines, t3code's `index.css` kept verbatim). Swapping `:root` re-colours almost everything. But the view modules a new look redraws are about 12.7k lines (sidebar 3.3k, composer 3.0k, timeline 1.8k, `ui/` 1.5k, hero 0.7k, diff, settings, push and the root view 2.5k).
5. **Fork the views, share the store.** The route seam is `page` and `view` in `apps/web/src/View.ts:194-338` over `AppRoute` (`Route.ts:19-25`). A `next` frame beside the classic one, picked by a client setting, shares `Model`, `Update`, `Message`, the connection and all of `packages/client-logic` (27 modules), as HumanLayer's "share data, fork UI" does. The entry bundle is already at its 288 KiB gzip ceiling against a 200 KB target (`apps/web/src/Budget.test.ts:16-29`), so `next` must load as a dynamic chunk, like settings and diff.
6. **"Content never moves under you" has two measured failures and a known cause.** Run today on the 2,100-row harness: `range` going up has a 328 px largest step in the scroll range, a 1,377 px spread, 26 steps over 1 px and 17 scrollTop reversals; `reflow` to 390 px leaves the read character 25.3 px off (156.3 px at the worst frame), while 900 px holds at 0.3 px. Causes are in installed `@foldkit/ui` 0.169.0: unmeasured rows count at the caller's estimate (`virtualList/index.js:499-512`) and a width change empties `measuredRowHeights` (`:358-367`), and its anchor is a row plus an offset (`:340-352`), never a character.
7. **The list cannot be fixed from outside, so replace it, small.** The only hook is `itemToEstimatedRowHeightPx`, which can remember heights per width but cannot give an exact first-time height or a glyph anchor. MonoCode's answer is 176 lines (`useMeasuredHistory.ts`): turns beyond `max(800, viewport)` keep an exact measured height and drop their DOM. Recommendation: build that as the look wave's first package, before any new row kind, because every new row kind and the new type scale would otherwise need fresh estimates.
8. **Without a pixel baseline, three judges do the work, and the user's approval freezes a fourth.** Pure-logic tests ported from t3code's sibling tests (`threadShell.test.ts`, `subagentRuntime.test.ts`, `threadRelationships.test.ts`, `pendingUserInput.test.ts`, `Sidebar.logic.test.ts`); behaviour scripts over the scripted harness through `judges/fixtures/parity/CairnApp.ts`; rule checks at 390 px (no horizontal overflow, 44 px hit targets, tokens only). Each user-approved preview round then freezes its screenshots as a baseline that `judges/parity.ts`'s pixel compare guards from then on.
9. **The phone is on the critical path.** ADR 0026's gate and phase 2's "done when" are both run from the phone: a five-node workflow, a brief answered across a restart, an artifact and a portal loading. So every card, sheet and link in the inventory is judged at 390 px first, and the phone must be on `next` before the gate, which makes the fork-and-switch a phase 2 deliverable rather than a later cleanup.
10. **t3code's lineage panel has no phone design to copy.** The details card docks only when the lane has room and otherwise becomes a popup (`ThreadDetailsCard.tsx:56`, `threadDetailsCardLayout.ts` returns null when the lane is too narrow), and its Lineage section shows only at `density === "full"` (`ThreadDetailsPanel.tsx:185-193`). The redesign sketch draws the same content as a bottom sheet.
11. **Two ADRs are worth writing, both gated by the user's judgment or a judge**: the UI fork that amends ADR 0015, and the transcript owning its measured list. The sidebar decision stays out of both; section "Sidebar inputs" is the question list for the daily-driver day.
12. **Work packages**: 8 for the look wave (L0 to L7) and 10 for building surfaces (W1 to W10), in that order, each judged as above. Surfaces wait on the brain notes only for scripted-harness scenarios to play and for protocol fields; the look wave does not wait on them.

## Facts with evidence

### Pins and method

| Source | Pin | How read |
| --- | --- | --- |
| Cairn | `e73dd9c` (`phase2/notes-surfaces`) | Read at HEAD; `pnpm install --frozen-lockfile` for installed sources |
| t3code | `fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92` | `git show fe27e8e3:<path>`; counterpart facts inherited from `t3code-nightly.md` |
| `@foldkit/ui` | 0.169.0 (MIT), `node_modules/.pnpm/@foldkit+ui@0.169.0_*/node_modules/@foldkit/ui/dist/virtualList/index.js` (781 lines) | Installed source |
| MonoCode | `hardbeat920/monocode` `26465c62` (MIT) | Outside-lessons report; `useMeasuredHistory.ts` (176 lines, `Math.max(800, viewport.height)` at line 96) re-read in a blobless clone |
| Ultimate | `HazAT/ultimate` `8b263386` | Outside-lessons report; `extensions/questions/card.tsx:26` (`UNDO_MS = 3000`), `extensions/plan/web.tsx`, `web/src/app/compact.ts` confirmed present |
| HumanLayer | `humanlayer/humanlayer` `f16f286` (Apache-2.0) | Outside-lessons report only (not cloned) |
| Sketch | `~/Developer/agent-artifacts/cairn/v2/redesign-sketch/index.html` | Static, not a spec |
| Judge runs | `node judges/transcript-scroll.ts --seconds 4` on this worktree | Numbers in this note |

### What the web client is today

- `apps/web/src` is 31,106 lines of non-test TypeScript plus `styles.css`. One root `Model`, `Update`, `Message`, `View`, `Subscription`; pages are submodels (`page/thread`, `settings`, `composer`, `sidebar`, `timeline`, `diff`, `push`). Routes: Hero, Thread, Draft, Settings, NotFound (`Route.ts:19-25`). The frame is a sidebar (lazy) and a `main` holding `noticeBar` and `page` (`View.ts:311-338`).
- A thread page is a status line, the transcript, the hold banner (`shell/Parked.ts`, kinds Parked, Limited, WaitingForSlot) and the docked composer; the diff panel is a lazy chunk (`page/thread/View.ts:95-142`, `View.ts:194-252`). The composer card already has an "attached drawer" slot above it for queued inputs (`composer/Card.ts:103`, `queueView`), which is where t3code puts its pending-request banner.
- Sidebar status is one function, `resolveSidebarThreadStatus` (`packages/client-logic/src/Sidebar.ts:168-214`): approval or input first, then working, parked, failed, limited, ready. Its "Waiting" label cannot show today (`docs/golden/thread-states.md`, label map).
- Transcript row kinds are `history, working, thinking, work-live, work-toggle, turn-fold, context-compaction, error, assistant-meta, work, message, changed-files`, each with a hand-set estimated height (`timeline/Rows.ts:375-414`). A new row kind adds an estimate.
- The kept judges: `judges/behaviour.ts` (828 lines, 18 checks over a real in-process brain with the scripted harness: footer widths, triggers, paste, drop, drafts, hero-launch x20, settle-undo, snooze, search, menu items, mobile sheet, soft keyboard), `judges/parity-structure.ts` (landmark boxes and computed tokens against t3code's committed landmark files), `judges/parity.ts` (pixel compare), `judges/typing.ts` (20 cps for 60 s), `judges/transcript-scroll.ts` (812 lines), `judges/load.ts`, `judges/wire-budget.ts`. `CairnApp.ts` starts the client over the scripted harness and already plays an approval through `ScriptedTools` (`apps/server/src/brain/ScriptedHarness.ts:544-583`), so approval states need no model.
- The parity baseline is 35 MB under `judges/fixtures/parity/t3@fe27e8e3/` (hero, thread, sidebar, settings).

### Tokens today

- One file. `styles.css:22` imports Tailwind 4; `:24` declares the `dark` variant; `:112-176` holds geometry in `:root` (`--control-radius` 0.5rem, sidebar insets, `--chat-content-max-width` 46rem, `--workspace-gutter` 0.75rem and 1.25rem at `sm`, glass blur); `:214-220` the font stacks; `:228-235` the type steps below `text-xs` (`--text-2xs` 11 px to `--text-5xs` 7 px); `:240` the one easing (`--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`); `:332-337` radii derived from `--radius: 0.625rem` (`:980`); `:978-1436` the light colour properties (about 100) with seven `@variant dark` blocks and four `light-dark()` uses.
- Runtime overrides live in `ClientSettings.ts:262-273`: the `dark` class, root font size, `--font-size-prompt`, `--font-size-code`; `data-chat-width` switches the lane to 46rem, 72rem or 100% (`styles.css:2138-2144`).
- Not tokenised: spacing beyond Tailwind's scale (one named exception, `--spacing-composer-seam`, `:246`), durations (only `--mobile-composer-transition-duration` and inline values), z-order except `--z-sheet`, elevation beyond two composer shadows. Status colour comes from `TOP_STATUS_LOOKS` classes (`sidebar/Row.ts:90-136`: `text-info`, `text-warning-foreground`, `text-indigo-600 dark:text-indigo-300`, `text-error`, `text-success`), so "needs you" is amber for approvals and indigo for input, by class string.
- Brand elements are already removed (`styles.css` header; `judges/brand.test.ts`).

### The transcript list and its two findings

- `judges/transcript-scroll.ts` lists `range` and `reflow` in `KNOWN_FAILING` and fails if either starts passing. Run here: `follow`, `scroll-up`, `expand`, `pill`, `switch`, long tasks and errors pass; `range.up` travelled 7,571 px over 130 frames with `rangeMaxStepPx` 328, `rangeSpreadPx` 1,377, `rangeStepsOver1Px` 26, `scrollTopReversals` 17, `contentReversals` 27; the same rows going back down held (0 and 0), because they were measured by then. `reflow` held at 900 px (0.3 px) and 1,440 px, and failed at 390 px (25.3 px final, 156.3 px worst, the first visible row and offset still within 0.6 px).
- Mechanism, in the installed list: `rowHeightFor` falls back to `itemToEstimatedRowHeightPx` for any key without a measurement (`:499-512`); `measureContainer` sets `measuredRowHeights` to `{}` and bumps `layoutVersion` when the width changes (`:358-367`); the viewport anchor kept across that is `Row {key, index, viewportOffset}` (`:340-352`). Row-level, not character-level, and estimate-driven for anything not yet drawn.
- Exposure in the real app: ADR 0020's window starts a subscription at 10 turns and 75 entries and pages older entries in (`thread.history`, 4 pages for 1,945 entries). Scrolling into history is exactly the unmeasured case. The judge uses one 2,100-row list; the live case at window size was not run (see "Not verified").
- MonoCode, as read: `overflow-anchor: none`; no estimation of offscreen heights ("estimated offscreen heights change the scroll range during a gesture"); a per-turn `ResizeObserver` that corrects `scrollTop` only for turns wholly above the viewport; a reply-reflow bookmark that stores a visible glyph through `caretRangeFromPoint` and restores that character after a width change; prompt anchoring with the live turn at `min-height: <viewport>`; parked transcripts in a 50,000-node pool. Cairn's `range` and `reflow` checks are ports of MonoCode's tests (`judges/transcript-scroll.ts` header).

### Nightly counterparts, in short

Inherited from `t3code-nightly.md` and not repeated there in full: approvals, questions and the plan share one composer slot (`ChatComposer.tsx:6505-6562`); subagent rows (`V2LifecycleRow.tsx:60-68`, `:398`) and group (`MessagesTimeline.tsx:3218-3327`); Lineage section (`ThreadRelationshipsControl.tsx:210-697`); rollup (`threadShell.ts:48-80`, `Sidebar.logic.ts:914-917`, banner `ChatView.tsx:5298-5327`); workflow block and row (`WorkflowOpeningBlock.tsx:38-104`, `ThreadLineageWorkflowRow.tsx:111-256`, phases `subagentRuntime.ts:235-293`). All of those logic files have sibling tests in t3code (`subagentRuntime.test.ts`, `threadRelationships.test.ts`, `threadShell.test.ts`, `pendingUserInput.test.ts`, `proposedPlan.test.ts`, `Sidebar.logic.test.ts`).

## Inventory of phase 2 surfaces

Each entry: nightly counterpart, data it needs from the brain, states, phone at 390 px. States come from `docs/golden/thread-states.md` unless said. "Needs" lines name fields; the owning note (subagents, briefs, workflows, models, reach) designs them.

**S1 Goal thread.**

- Counterpart: new. t3code's `goal` is a provider banner (`ChatView.tsx:5391-5427`) and is skipped; Ultimate's goal cards (`extensions/goal/cards.tsx`) are the nearest shape, but there the agent marks criteria met.
- Needs: a goal marker and criteria on the thread (text, state `open | met | blocked`, the outside judge that decides), children count, spent against budget. A goal is a thread (ADR 0026), so the row, transcript and composer are unchanged.
- States: every thread state, plus per criterion open, met, blocked; goal ended.
- Phone: same thread page; a header chip ("2 of 5 met") opens a sheet of criteria; rows 44 px high.

**S2 Brief card and Go.**

- Counterpart: none for the gate. Borrow the plan card's reading view (`ProposedPlanCard.tsx:41-311`: collapsed preview, "Expand plan", copy and download menu `:179-187`) and the composer slot. The sketch lays the brief as a Do, Not, Done when, Arms, May, Budget table.
- Needs: the approval record with a typed brief payload (ADR 0026), `decidedBy` and `reason`, `askedAt`, `expiresAt`, the role or model the child will run on.
- States: `ApprovalStatus` pending, accepted (Go), declined, expired, cancelled; a brief pending across a restart (the ADR's gate); "asked again after an edit" is the briefs note's call.
- Phone: Go and Not yet at the thumb edge, 44 px; the card is at most about 60 percent of the visual viewport and scrolls inside, so the keyboard cannot cover Go (`composer/SoftwareKeyboard.ts` already tracks the keyboard); a push opens straight onto the card.

**S3 Approval and question card (one card).**

- Counterpart: `ComposerPendingApprovalPanel.tsx` (68 lines) and `...Actions.tsx:25-45`, `ComposerPendingUserInputPanel.tsx` (304 lines, one question at a time, digits, 200 ms advance, custom answer, dismiss), logic `pendingUserInput.ts`. Ultimate's card adds recommended pills, Shift+Enter accept-all and a 3,000 ms undo bar; for approvals an undo must delay the commit, never an effect already started (ADR 0013's sandwich).
- Needs: the pending records with kind, tool and the call's detail (command, path); a question schema (header, question, options with label, description, recommended, preview; multi; custom answer) and a user-question tool; an answer shape beyond `accept | decline` (`Policy.ts:42`, `RespondInput`); `1/N` over all pending of the thread; outcomes after the fact.
- States: pending, accepted, declined, expired, cancelled; answered elsewhere while open (the card must close without losing typed text); answered by the parent (ADR 0027); the backlog's "approval outcomes reach no UI" lands here as a one-line row.
- Phone: options at least 44 px, no key hints on coarse pointers, the composer collapses while the card is up, the custom-answer field survives the soft keyboard.

**S4 Subagent rows and nesting.**

- Counterpart: `V2LifecycleRow.tsx:60-68`, `SubagentTimelineLink` (`:398`; labels Queued, Running, Waiting, "Idle · resumable", Completed, Failed, Stopped `:214-226`), group (`MessagesTimeline.tsx:3218-3327`), the "Subagent of" divider (`:1342-1360`). Ultimate nests 24 px child lines under a row at `20 + depth * 12` px.
- Needs: lineage on the child's row (`parentThreadId`, `rootThreadId`); a record per child on the parent (child thread, title, role alias, model, status, progress line, result with outcome and divergence, times, the brief's approval id).
- States: nightly's seven plus Cairn's brief pending (before Go), asked its parent (ADR 0027), parked, waiting for a Claude slot. Group dims once nothing in it is active.
- Phone: one line per child (state glyph, title, state word, age); a group is one line ("3 subagents"); the divider doubles as the way back and stays on one line.

**S5 Lineage side panel.**

- Counterpart: `ThreadRelationshipsControl.tsx:210-697` (running first, "Previous agents" folded, 6 rows then 12 per "Show N more" `:80-81`, hover Stop `:463-473`), mounted in the details card (`ThreadDetailsPanel.tsx:190`). Forks, merge-back and transfers are skipped.
- Needs: children of the open thread with live status read from each child's shell row; Stop per child.
- States: running, previous, empty, more than 6; a child in Stopping.
- Phone: no t3code design (popup only). Proposal: a bottom sheet from the header; the sketch draws the same content that way. Desktop: right panel beside the transcript, never over it.

**S6 Child request rollup.**

- Counterpart: `threadShell.ts:48-80` (approval wins over input, to every ancestor), `Sidebar.logic.ts:914-917`, parent banner `ChatView.tsx:5298-5327`, subagent threads hidden from the sidebar (`Sidebar.logic.ts:520-553`).
- Needs: lineage on every shell row, so the client walks ancestors; the audience of a pending request, so a request the parent may settle (ADR 0027) does not reach the inbox until escalated.
- States: ancestor shows Approval or Input; child row hidden or nested (the pass decides); banner hidden while the parent has its own request; escalated card answered once from either thread.
- Phone: the sidebar is a sheet at 390 px (`mobile-sheet` check), so a closed sheet needs a signal outside it, such as the header's menu button; push is the main channel.

**S7 Steps panel.**

- Counterpart: `WorkflowOpeningBlock.tsx` (headline, tally "4 agents · 2 working · 1 done · 1 failed", phases with settled/total, folded script) and `ThreadLineageWorkflowRow.tsx` (phase labels running, failed, stopped, done, "not started"; "Stop entire workflow"). New: the sketch's per-subagent steps ("You said go", "Started, in a worktree", "Working on it", "Checked by an outside judge", "Said what it did", "Leave the merge to you") and Ultimate's "3/7 steps" pill (`extensions/plan/web.tsx`).
- Needs: for a subagent, the recorded states those steps read (Go's `answeredAt`, launch phase, run activity, judge verdict, result, integration state); for a workflow, the journal's nodes (label, phase, state, model, attempt, tokens, duration, result, cost). Steps are a closed set derived from records, never model text.
- States: step done, now, todo; node queued, running, completed, failed; phases only grow.
- Phone: a pill above the composer opens a bottom sheet; on desktop it is the right panel. Updating a step moves nothing in the transcript.

**S8 Workflow launch approval.**

- Counterpart: none; t3code's block appears after the start. The relation to the briefs of the workflow's nodes is open (ADR 0026).
- Needs: the script (folded), node and phase counts from its `export const meta`, model per role, a cost estimate, a budget cap, "run on 1 item" (kickoff decision 3).
- States: pending, accepted, declined, expired; run-on-one done and the rest awaiting a second answer (workflows note).
- Phone: a full-height sheet, numbers first, the script behind "Show script", Go at the thumb edge.

**S9 Usage and dollar meters.**

- Counterpart: plan windows exist (`composer/UsageMeter.ts`, ported from `ComposerUsageLimits.tsx`; `UsageSnapshot` in `Usage.ts` says unknown is never zero). t3code's `ContextWindowMeter.tsx` is off by default. Dollars and budgets have no counterpart; Ultimate's 32 px bar and MonoCode's ring (amber at 75 percent, red at 90, hidden when unknown) are the references.
- Needs: spent and cap per goal, workflow and subagent; a price per model, or an explicit "no price" for subscription models (models note).
- States: under, near, over (hard stop or soft ask; the sketch asks "soft, ask at 100%"), unknown.
- Phone: the composer footer folds by measured width into an overflow menu (`COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = 620`, `FooterLayout.ts`), so a meter is either a footer block with an icon-only form or lives in the steps sheet.

**S10 Artifact entries.**

- Counterpart: `HtmlRenderDialog.tsx` and `HtmlRenderFrame.tsx` render HTML inline in a dialog; publishing, listing and revoking are new. porch's receipt is a URL under `https://plans.<domain>/<project>/<file>`, same source same URL (research 08).
- Needs: a result with URL, title and republish handle; a per-thread and per-project list; revoke.
- States: published, republished, revoked or gone.
- Phone: a link row in the transcript; the target is that it loads on the phone. Whether the installed PWA stays in the app when following an external `gneiss.run` link is not verified.

**S11 Portal entries.**

- Counterpart: t3code's preview panel is a built-in browser (`apps/web/src/browser/previewRuntime.ts`); a Caddy name is new.
- Needs: name, URL, upstream (Beelink port, later a stone), lit or dark (porchlight's words), thread, opened time; open and close.
- States: lit, dark (porch serves its own "how to start me" page), closed.
- Phone: as artifacts.

**S12 Fold line with tallies.**

- Counterpart: phase 1 already ports "Worked for <duration>" (`TimelineFolds.ts`); MonoCode's `workSummaryLine` ("Edited 3 files · Ran 2 commands") and HumanLayer's "Explored 7 items · Read 5, Searched 2" give the tallies; Ultimate folds child traffic to "3 updates with reviewer #14".
- Needs: nothing new for tool tallies; subagent and workflow events as foldable items.
- States: live (open), settled, held open by a pending approval.
- Phone: one line, tallies truncate from the right.

## Design for Cairn

### Tokens and where they live

Proposal, for the pass to accept or change. Keep t3code's `styles.css` untouched for the classic frame and add `apps/web/src/next/tokens.css`, applied under `:root[data-ui="next"]`, that redefines the existing semantic names (`--background`, `--foreground`, `--card`, `--muted-foreground`, `--border`, `--primary`, `--destructive`, `--success`, `--warning`, `--info`, `--radius`) so the 538 utility uses keep working in forked views. Add the sets the pass has to choose values for, taking names and structure from the sources and leaving values open:

- **Ink and ladder** (MonoCode `src/styles/index.css`: one ink at fixed strengths, stroke 7 percent, inner stroke 4, a five-step selection ladder 8/10/12/15/20 dark and 5/6/7/10/14 light), or HumanLayer's named set (`--bg --fg --fg-2 --fg-3 --sidebar --surface --surface-2 --hover --active --line --line-2`). The sketch uses the latter on a warm stone ground.
- **State colours as a closed set**: working, needs you, done, failed, with a glyph or word beside each, never colour alone (MonoCode's diff comment insists on +/- glyphs). Today approval and input already differ only by amber and indigo classes.
- **Type**: HumanLayer 13 px base, MonoCode 14 px prose with 10 to 11 px counts in tabular figures, t3code's `text-2xs` to `text-5xs`. The pass picks a scale of four or five steps and `ClientSettings` keeps its three font-size overrides.
- **Radius** (HumanLayer 6, 10, 14; MonoCode 6 and 12), **motion** (MonoCode: feedback 120 ms, reorder 160 ms, one ease-out curve; Ultimate: one curve almost everywhere; both gate on `prefers-reduced-motion`), **layers** (one z-scale file, MonoCode `shared/lib/layers.ts`).
- **Contrast** as a test, not a promise: MonoCode's own warning is 10 to 11 px chrome at 35 to 45 percent opacity. A vitest reads the resolved token pairs in both themes and fails under 4.5:1 for text and 3:1 for chrome.

### Primitives to build once

`apps/web/src/ui/` has 17 modules (1,469 lines, t3code's `ui/*` as class tables over Foldkit): Badge, Button, ChatHeader, Combobox, Dialog, Kbd, Menu, Popover, ProjectMark, ScrollArea, Select, Skeleton, Switch, Toast, Tooltip, and two helpers. They are rebuilt on the new tokens in `next/ui/`. New primitives the twelve surfaces share:

1. **StatusMark and StateWord**: one glyph vocabulary (busy spinner, needs-you dot, check until seen, failed, dashed todo) and one label map fed by one function, replacing `TOP_STATUS_LOOKS` and the hold banner's separate words. Ultimate's `conversationState` and HumanLayer's thirteen fixed labels are the models.
2. **Card** with a header line, a body and a semantic left rule (Ultimate `web/src/app/card.tsx`); used by brief, question, launch approval, subagent row, artifact.
3. **Disclosure**: fold, phase and "Previous agents", with reserved space so opening one moves nothing above it.
4. **ActionRow**: at least 44 px on coarse pointers, key hint hidden there (`KeyHint`).
5. **Sheet**: bottom sheet under `sm`, docked panel from `lg`, and the popover case between.
6. **Meter**: value or unknown, thresholds, text alternative.
7. **Tally**, **RecordLines** (the brief's dt/dd table), **Stepper**.

### Fork, judge, switch, delete

1. **Fork (L0).** `apps/web/src/next/Frame.ts` and per-page views; `View.ts` chooses classic or next from a `ClientSettings` field `ui` (default classic), set by `?ui=next` (HumanLayer: `?minui=true`, `use-minimalist-layout.ts`) and a settings row. Shared and untouched: `Model`, `Update`, `Message`, `Subscription`, connection and outbox, `packages/client-logic`, composer logic (`Update`, `Editor`, `Command`, `Drafts`), attachments logic, timeline row derivation (`Rows.ts`, `Update.ts`), sidebar `Update.ts` and `Derived.ts`. Forked: the view modules and tokens. The `data-testid`, `data-menu-id` and `data-chat-*` hooks that `behaviour.ts` and `Landmarks.ts` read are the contract `next` keeps. `next` is a dynamic chunk (`SettingsPage.ts:31` is the pattern), so the entry budget in `Budget.test.ts` is untouched until the switch.
2. **Judge.** Classic stays under the existing parity judges, frozen. `next` is judged by `behaviour.ts`, `typing.ts` (the composer redraw must pass 20 cps again), `transcript-scroll.ts`, `load.ts`, the surface scripts below, and the user's rounds.
3. **Switch.** The user flips the default after judging `next`, phone first. Because the phase 2 gate runs on the phone, the switch happens before the gate.
4. **Delete.** Classic views go in the change that flips the default; `judges/parity.ts`, `parity-review.sh` and `capture.ts t3` retire; the 35 MB baseline can leave the tree (history keeps it). `behaviour.ts`, `parity-structure.ts` (repointed at frozen `next` landmarks) and the brand test stay. Maintenance cost while forked: classic takes bug fixes only; HumanLayer still maintains two interfaces and MonoCode paused features to keep two apps alive (outside-lessons, "What to avoid"), which is why this fork has a date, not a policy.

### Content never moves under you

Recommendation, in order:

1. **When**: do not fix before the daily-driver day (both failures sit behind scrolling into history and resizing, and the day shows whether they bite). Do fix as the look wave's first package (L1), before the first new row kind is drawn, because the look re-tokenises type and every estimate in `FIXED_HEIGHTS` and `messageHeight` would be wrong at once, and S3 to S7 each add row kinds. If the day shows visible jumps while paging history, bring L1 forward as a stopgap on its own branch.
2. **How**: a Cairn-owned list module in `apps/web/src/timeline/` replacing `@foldkit/ui`'s `virtualList` (MIT; header names the source, plus MonoCode's MIT notice for the ports). Rows are drawn once off-screen at the list's width to get an exact height, then kept frozen; rows beyond `max(800 px, viewport)` of the viewport drop their DOM and keep their height; the live turn is never detached. A width change reveals nothing and re-measures only what is near, and anchors on a glyph bookmarked with `caretRangeFromPoint` (the judge already has the helper). `FollowEnd` (`timeline/FollowEnd.ts`) stays as the follow mount. A pause counter during layout transitions (MonoCode `layoutTransition.ts`) keeps width-dependent work off while a panel slides.
3. **Why not patch**: feeding a per-width height cache through `itemToEstimatedRowHeightPx` fixes repeat visits only; the first scroll up through unseen history and the character anchor stay broken, and the list's `measuredRowHeights` reset on width change is internal.
4. **Judge**: remove `range` and `reflow` from `KNOWN_FAILING`; their `--broken` controls must still fail them; add `insert-above` (a card inserted above the viewport, as an escalated question is, moves nothing visible) and `arrive` (a late cost or status line in a settled row moves nothing below the reader). Prompt anchoring (live turn at viewport height) waits for the pass, as the backlog says; it is a design call the user should see first.
5. **Cost to watch**: node count. MonoCode budgets 50,000 nodes for parked transcripts; Cairn has no measurement of nodes per row. L1 reports it from the 2,100-row fixture.

### Protocol additions the surfaces ask for

Named, not designed; each belongs to the note in brackets.

- Shell row: `lineage {parentThreadId, rootThreadId}` [subagents]; goal marker and criteria summary [briefs]; audience of the pending request, parent or user [briefs, subagents]; spent and cap [models].
- Thread stream: a visible document for subagent records and one for the brief payloads or an extension of `cairn.approvals` [subagents, briefs]; the approval record's call detail and answer payload [briefs]. Each document joins `VISIBLE_DOCUMENTS` and so the 32 KiB cut and the wire budget.
- Workflow journal projection with nodes and phases [workflows].
- RPCs: `thread.respond` with an answer or comment; a child stop; list and revoke for artifacts and portals [briefs, subagents, reach].
- Client-only: `ui` setting, rollup, state function, tallies and steps in `packages/client-logic` (pure, with tests).

### ADR 0015 amendment shape

ADR 0015 stays accepted for the phase 1 surfaces. The amendment adds three sentences: parity is judged against t3code until the user flips `ui` to `next`; after that day t3code binds behaviour, not pixels (ported logic keeps t3code's sibling tests, `behaviour.ts` checks keep passing) and the committed baseline is a frozen reference; and a surface that has no counterpart is judged by its scripts and the user. The pin rule (read the commit of the installed nightly) is unchanged.

## Judges

Three kinds, plus one the user's approval creates. Every behaviour script gets a broken control, as `transcript-scroll.ts --broken` does, and runs at 390 px (WebKit-emulated as `soft-keyboard` does) and 1,440 px. Scripts live in a new `judges/surfaces.ts` over `CairnApp.ts` rather than growing `behaviour.ts`; they play scripted-harness scenarios supplied by the brain notes.

| Surface | Logic test (client-logic) | Behaviour script | Rules and user |
| --- | --- | --- | --- |
| S1 goal | criteria met only from a judge record | `goal-chip`: chip count equals records; criteria sheet at 390 | user round |
| S2 brief and Go | brief fields decode and render in order | `brief-go`: Go from 390 starts exactly one child; double tap, a second device and a restart in between still start one (ADR 0026 gate) | hit target 44 px; user round |
| S3 card | `pendingUserInput` port (draft answers, progress, custom) | `card-approval`: shows tool and detail, answers once, `already_settled` on repeat, survives `kill -9` as `approval_across_restart` does; `card-question`: digits, 200 ms advance, custom text through the soft keyboard | no overflow at 390; user round |
| S4 rows | `subagentRuntime` port (status, group dimming) | `rows-subagent`: spawn, run, finish; open child; divider returns; group of 3 | row one line at 390 |
| S5 lineage | `threadRelationships` port (paging 6 then 12, order) | `lineage-stop`: Stop ends one child, others run; previous folded | sheet at 390, panel at 1,440 |
| S6 rollup | `threadShell` and `Sidebar.logic` ports (approval over input, ancestors, banner hidden) | `rollup`: child request lights ancestors; parent-first request does not; escalated card answered from the child resolves in the parent once | none |
| S7 steps | step union order, node and phase states, phases only grow | `steps`: states for a scripted child; pill count; update moves nothing (frame-sampled like `transcript-scroll`) | sheet at 390 |
| S8 launch | cost shows unknown, never 0 | `launch-approval`: "run on 1 item" runs one node; decline runs none | user round |
| S9 meters | thresholds; unknown stays unknown | `meters`: over-budget behaviour is the chosen one | contrast test |
| S10, S11 reach | row shape | `reach`: artifact and portal URLs answer 200 (lit) or the dark page | phone check by the user in the wizard |
| S12 tallies | tally strings for tool mixes | `fold-tally`: live open, settled folds, approval holds open | none |

- **Structure rules without a baseline.** A kept `judges/look-rules.ts` reads `next` landmarks and asserts what a baseline would have implied: `scrollWidth <= clientWidth` at 390; every `[data-action]` at least 44 by 44 px under `pointer: coarse`; text at least 12 px except tabular counts; colours only from the token set (a vitest over class strings, which today finds 14 palette utilities and 9 literals); no landmark overlaps another; each state the catalogue lists renders. A planted violation must fail each rule.
- **The user's look, frozen.** `judges/look.ts` renders a catalogue of every surface state (loading, empty, error, one, many, long title; both themes; 390 and 1,440; Ultimate's `verify-ui` list) from the scripted harness, writes the screenshots to `~/Developer/agent-artifacts/cairn/v2/look/round-<n>/` (served at `plans.gneiss.run`), and a reviewer model from another family checks them against the checklist (`parity-review.sh` is the starting point). The user approves a round; approval commits the screenshots as `judges/fixtures/look/round-<n>/` and `parity.ts`'s pixel compare guards them from then on. Checks and the reviewer are not approval; one approval covers one round (Ultimate's `ui-preview-round`).

## Sidebar inputs: questions for the daily-driver day

The pass decides whether the inbox stays the whole sidebar or becomes the top entry of a project rail (sketch). These are cheap to answer from that day and decide it:

1. How many projects had a thread open you cared about? (The rail pays off at several; one or two favours the inbox.)
2. How often did you filter to one project against reading across all? (`SidebarThreadHeader`'s project filter exists.)
3. Of the day's threads, how many were really children of one larger piece of work? (Predicts what a goal list would hold.)
4. What did you act on first when you came back: Approval, Input, Failed, Done? (Phase 2 adds more reasons to look.)
5. How many threads were Active at once, and did you scroll past the first screen of them?
6. Did you use the Settled shelf, pins or snooze at all?
7. On the phone, how often did you open the sidebar sheet, and for what: switching threads or finding the one that needs you?
8. Would you want a goal's children visible in the list, nested, or only reachable from the goal?

## Proposed ADRs

**The UI forks behind the route seam and the fork replaces the classic views (amends ADR 0015).** The look wave builds `next` views beside the classic ones on one shared store and `packages/client-logic`, picked by a client setting and loaded as a dynamic chunk. Classic is frozen under the parity judges; `next` is judged by behaviour scripts, rule checks and the user's rounds; on the user's switch the classic views and the pixel-parity judges are deleted. Gate: `behaviour.ts` and the surface scripts green on `next` at 390 and 1,440 px, `typing.ts` zero dropped keys, and the user's explicit switch.

**The transcript owns its measured list.** The transcript stops using `@foldkit/ui`'s virtual list and keeps exact, frozen row heights with a glyph reader anchor, so content does not move under the reader. Trade-off: Cairn maintains a scroll primitive (176 lines in MonoCode, plus Cairn's follow and fold logic) in return for no estimated heights. Gate: `range` and `reflow` leave `KNOWN_FAILING` and their broken controls still fail them, `typing.ts` and the long-task limit hold, and node counts are reported.

## Open questions for the user

1. **Where are phase 2's screens built?** Options: (a) only in `next`, with the phone on `next` before the gate; (b) in classic first and redrawn later. Recommend (a): (b) builds every screen twice and the gate runs on the phone.
2. **When does the list fix land?** Options: first package of the look wave; or only if the day shows jumps. Recommend first package, since new row kinds and the new type scale invalidate every estimate; decide at the end of the day.
3. **Which themes get preview rounds?** Options: dark only at first (the sketch is dark), light derived later; or both from the start. Recommend tokens for both from day one (one layout, two themes), rounds in dark, light checked by the contrast test until you ask for it.
4. **Where does the brief card sit on the phone?** Options: in the composer slot while pending with a record row in the transcript afterwards; a transcript card only; a side sheet. Recommend the composer slot, which is t3code's pattern for every pending request and keeps one place to look.
5. **How far does workflow control go in phase 2?** Options: stop the whole workflow only (the nightly's rule); or stop and restart a node. Recommend whole-workflow stop, since a single node's stop may break replay (ADR 0012 open point).

## Risks

- **A forked view tree can rot.** Mitigation: a date (switch before the phase 2 gate), classic bug fixes only, and shared state so no feature is built twice.
- **No pixel baseline for new surfaces.** Mitigation: rule checks, scripts with broken controls, and rounds frozen on approval. Residual: taste has no automated judge, and the reviewer model is for the checklist only.
- **Late data moving content.** Cost estimates, child status and escalated cards arrive after layout. `insert-above` and `arrive` exist to catch it; cards reserve their space.
- **The approval record is too thin for t3code's own panel.** If briefs and questions ride it, its shape changes once, with a migration of stored `cairn.approvals` documents.
- **Bundle budget.** The entry is at 288 KiB gzip. `next` must be a chunk, and forked `ui/` primitives load with it; a second view tree in the entry would fail `Budget.test.ts`.
- **Typing regression from a redrawn composer.** The 20 cps gate passed on the current textarea; Foldkit's lazy cells are per tree position (`View.ts:64-73`) and the daily-use review found `rowLazy` the only lazy at one point. Re-run `typing.ts --throttle 4 --busy 10` on every composer package.
- **Wire growth.** Subagent results and briefs ride the thread stream; they are cut at 32 KiB and counted by `wire-budget.ts`, which must be re-run per new document.
- **PWA link-out.** Artifact and portal links leave the app on iOS in ways not yet tested.
- **Brand drift.** `brand.test.ts` must cover `next`, so t3code's wordmark, backdrop and storage prefixes do not return with a redrawn view.

## Work packages

Sized like phase 1's blocks. Look wave first; the surfaces follow. "Brain notes" means the subagents, briefs, workflows, models and reach notes.

**L0 Fork frame.** Owns `apps/web/src/next/Frame.ts`, `View.ts` (integrator seam), `ClientSettings.ts` field `ui`, the settings row. Inputs: none. Builds the selector, `?ui=next`, the dynamic chunk, an empty `next` frame that renders the routed pages. Judge: classic unchanged byte for byte (`capture.ts cairn` diff empty); `behaviour.ts --ui next` runs; `Budget.test.ts` unchanged; a hook-contract test lists the `data-testid` families `next` must keep.

**L1 Measured transcript list.** Owns `apps/web/src/timeline/` list module, `FollowEnd.ts`. Inputs: none. Builds the module and its harness flag. Judge: `transcript-scroll.ts` with `range` and `reflow` removed from `KNOWN_FAILING`, the two broken controls failing them, new `insert-above` and `arrive` checks with controls, long tasks within limit, `typing.ts` zero drops.

**L2 Tokens.** Owns `apps/web/src/next/tokens.css`, `judges/contrast.test.ts`. Inputs: the pass's choices (values), L0. Builds the sets above under `:root[data-ui="next"]` and a class-string lint. Judge: contrast test in both themes (a planted 40 percent token fails); palette-utility and literal count in `next` is zero.

**L3 Primitives and gallery.** Owns `apps/web/src/next/ui/`, `/__look` catalogue route (dev only). Inputs: L0, L2. Builds the primitives listed above with every state. Judge: Scene tests per primitive; `look-rules.ts` over the catalogue at 390 and 1,440 with planted violations failing.

**L4 State function and vocabulary.** Owns `packages/client-logic/src/ThreadState.ts` and tests; shared with the subagents note's "one thread-state function". Builds one function from shell row plus children to a state, a tone and a word, replacing `resolveSidebarThreadStatus`, `resolveSidebarTopStatus` and `holdOf` as the source. Judge: unit tests over every row of `docs/golden/thread-states.md` (the existing test that fails on a missing status stays green); `threadShell.test.ts` port.

**L5 Look tool and rounds.** Owns `judges/look.ts`, `judges/look-rules.ts`, `judges/fixtures/look/`. Inputs: L3. Builds catalogue render, publish to `plans.gneiss.run`, reviewer pass, freeze on approval. Judge: a sabotaged catalogue state fails the rules; a frozen round fails when a token changes.

**L6 Shell in the new look.** Owns `next/sidebar/`, chat header, hold banner. Inputs: L3, L4, the pass's sidebar decision. Judge: the `behaviour.ts` checks `settle-undo`, `snooze`, `search`, `menu-items`, `mobile-sheet`, `hero-launch` green on `next`; the user's round.

**L7 Phase 1 surfaces redrawn.** Owns `next/composer/`, `next/hero/`, `next/timeline/` rows, diff, settings, push. Inputs: L1, L3. Three sub-blocks (composer and hero; transcript rows and the fold line with tallies, S12; diff, settings, push). Judge: all of `behaviour.ts`, `typing.ts` (20 cps, 60 s, Chromium and WebKit, IME), `transcript-scroll.ts`, `load.ts`, `paste.ts`, the user's rounds.

**W1 Approval and question card.** Owns `next/card/`, `client-logic/PendingCard.ts`. Inputs: L3, brain notes (briefs: record detail, question tool, answer payload; subagents: parent-first). Judge: `card-approval`, `card-question`, the conformance scenarios the brain notes add, the `pendingUserInput` port tests.

**W2 Brief card and Go.** Inputs: W1, briefs note. Judge: `brief-go` including the ADR 0026 gate (pending across a restart answered once).

**W3 Subagent rows and the way back.** Inputs: L1, L4, subagents note (lineage, record). Judge: `rows-subagent`; `subagentRuntime` port tests.

**W4 Rollup and parent banner.** Inputs: L4, W1, subagents note. Judge: `rollup`; `threadShell` and `Sidebar.logic` port tests; the ADR 0027 gate scenario played through the page.

**W5 Work panel (lineage and steps for a child).** Inputs: W3, W4. Judge: `lineage-stop`, `steps`.

**W6 Workflow steps and launch approval.** Inputs: W1, W5, workflows note (journal, launch relation). Judge: `launch-approval`, `steps` for nodes and phases, the phase 2 five-node run from the phone.

**W7 Meters.** Inputs: L3, models note. Judge: `meters`; unknown never zero.

**W8 Goal thread.** Inputs: W2, W5, briefs note. Judge: `goal-chip`.

**W9 Artifact and portal entries.** Inputs: L3, reach note. Judge: `reach`; the user loads both on the phone (wizard step).

**W10 Cutover.** Inputs: L0 to L7, the user's switch. Builds the default flip, deletions and the ADR 0015 amendment. Judge: `pnpm check` green after deletion; `behaviour.ts` and surface scripts green on the new default; the user's sign-off.

Order: L0, L1, L2 and L4 in parallel; L3 then L5; L6 and L7 in parallel; W1 to W9 as their brain-note inputs land (scripted-harness scenarios first); W10 last, before the phase 2 gate.

## Not verified

- `range` and `reflow` were measured on the 2,100-row harness list, not on a live thread at the window's size; how much of the first, if any, appears in a 75-entry window plus paged history is unmeasured.
- MonoCode's `useMeasuredHistory.ts` and Ultimate's `UNDO_MS` were re-read in clones; the rest of the MonoCode, Ultimate and HumanLayer facts come from the outside-lessons page's reports, and HumanLayer, Fold and pi-subagents were not cloned.
- Counts of semantic properties (about 100) and utility uses (538, 14, 9) come from grep over the files, not a CSS or AST parse; the 12.7k-line redraw figure sums the named view modules.
- The effect of a second view tree on the entry budget and of an off-screen measuring pass on frame time were not measured.
- iOS behaviour of external links from the installed PWA was not tested.
- `judges/behaviour.ts` and the other judges were not run here, only `transcript-scroll.ts`; the claim that `CairnApp.ts` can seed pending approvals rests on reading `ScriptedHarness.ts:544-583`.
