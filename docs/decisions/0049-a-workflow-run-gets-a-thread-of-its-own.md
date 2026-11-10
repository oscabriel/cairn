---
status: proposed
gate: the user's word on the design first; then, on a judge brain over faux models, a message to the project thread is answered while a workflow it launched is still running, and `workflow-kill.sh` passes with the workflow in its own thread, including a kill between the launch's Go and the workflow thread's `codemode` call
---

# A workflow run gets a managed thread of its own

**This is a recommendation awaiting the user's word.** The coordinator rethink, begun when ADR 0042 was scrapped on 2026-11-02, is the user's open design. This ADR is what 0042 was meant to settle: it states the problem from the code and recommends one shape. Nothing here is decided, and no code follows it until the user says so.

## The problem

A fan-out holds the project's only conversation for its whole run.

- **A workflow is one tool call in the launching thread's run.** ADR 0012 as amended: "A workflow runs inside the run of the thread that launched it in phase 2; a coordinator thread of its own is a later spike." Every node tool checks that its caller is a nested call of the `codemode` task the gate marked (`apps/server/src/workflows/WorkflowTools.ts`, header), and `ops/cairn/pi-bump-guard.sh` counts a non-idle thread as one that "may hold" a workflow for that reason.
- **A message waits for that call to return.** pi-durable places queued steers and follow-ups only at a boundary: `postTools`, after the turn's tool calls have ended, or `final` (`applyBoundary` in the installed `@earendil-works/pi-durable`, `dist/harness/inbox.d.ts`). A `codemode` call that has not returned reaches no boundary, so whatever the user sends the launching thread sits in its queue until the workflow ends.
- **That thread is the project's one conversation.** ADR 0026's amendment of 2026-10-29: each folder project has one project thread, "the one the user talks to", and a new top-level thread comes only from a refresh, which first stops the old thread's run, and with it the workflow.
- **Phase 3 makes the run long.** M3's fan-out is ten stones with a check run per pick, each "several minutes" by the plan's own arithmetic (`docs/phase-3/plan.md`, decision 4), then an integrate loop with a resolver. One `codemode` call holds for an hour or more.
- **The machine waits too.** A deploy runs only when every thread is idle (the deploy rule in the handoffs), and the pi bump guard refuses a pin change while any thread is not idle. Both block for the same hour.

So during a fan-out the user can talk to the project only through a node's own thread, or by refreshing, which stops the fan-out. The kickoff's "hands work to agents, walks away, and comes back" holds; its "large swathes of work on one project across many sessions and workflows at once" does not: on one project it is one conversation, busy. In phase 2 a council took minutes and this did not bite. The phase 2 workflows note already called the launching run the phase 2 answer and a coordinator thread "the likelier end state" (`docs/phase-2/notes/workflows.md`, question 4, package W9).

## Recommendation

A workflow run gets a managed thread of its own, under the project thread.

1. **The launch card stays where it is.** The project thread's model proposes the workflow with `workflow_plan`, and the user answers the launch card there, as today (ADR 0032's envelope is unchanged).
2. **Go creates the workflow thread.** In the commit that accepts the launch, the brain creates a managed thread whose lineage parent is the project thread, owned like a subagent (ADR 0028), and the script's `codemode` call runs in that thread, not in the project thread's run. The project thread's tool call ends once the workflow thread exists, so its run can end and the user's next message gets a turn.
3. **The result comes home as a note.** The workflow's return value reaches the project thread as a note, with a wake by ADR 0028's rules, exactly as a subagent's settlement does.
4. **The managed list shows it.** The workflow thread is a row under the project thread with its Steps panel; it can be opened and stopped, and its nodes' approvals and questions roll up through it to the project thread's row.

### What the user decides with it

- **Who makes the `codemode` call in the workflow thread.** A model turn would spend tokens to issue a call whose script is already approved. The phase 2 note named a deterministic driver provider (no tokens, no cost) as untested; the other way is for the brain to start the `codemode` task in the workflow thread directly at Go. Either needs a spike with `kill -9` between Go and the call.
- **Depth.** Nodes become children of the workflow thread. ADR 0028 caps depth at 2 (`MAX_SUBAGENT_DEPTH`); the workflow thread should not count toward it, or a node's own subagent has nowhere to go.
- **The deploy and pi bump guards.** They still wait for a running workflow; this ADR does not change that, only who else is free while it runs.

## Alternatives

- **Keep the workflow in the launching run** (today). Proven under `kill -9` and simplest; it blocks the project's conversation for the whole fan-out.
- **Let a project have more than one top-level thread.** It frees the user without touching workflows, and reverses ADR 0026's amendment, which the user chose on 2026-10-29.
- **A coordinator that always delegates** (the direction of scrapped ADR 0042: the project thread hands every piece of work to managed threads). Larger; it changes what the project thread is, and the workflow thread above is one step toward it rather than against it.

## Consequences, if accepted

- Amends ADR 0012 ("a workflow runs inside the run of the thread that launched it") and leaves ADR 0026's one project thread intact.
- `docs/phase-3/plan.md` ruling 7: the question is not separable from M3, and wave 4 waits for the answer. M1 and M2 do not depend on it.
- A new crash window, between the launch's Go and the `codemode` call in the workflow thread, joins `judges/workflow-kill.sh`.
- The glossary gains a term for the workflow's thread once the user settles its name.
