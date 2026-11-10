---
status: proposed
gate: `pnpm check` green with `Briefs.test.ts`, `PendingCard.test.ts` ("says a brief with no command has no outside judge") and `GoalCriteria.test.ts` ("refuses a judge on the thread's own model unless the user named it", "fences each turn"); then the user approves a brief card that shows a `done_when` command, and one that shows no outside judge, in the next look round
---

# A brief names its command, and a model judge never grades its own model unless the user says so

The review of 2026-11-09 (findings V-9 and O-5) found two overclaims about outside judges. ADR 0026 and the glossary say a brief carries "how its result will be judged", but both brief constructors wrote the constant "The parent accepts the result" with a `user` judge, the card showed it as "judged by you", and nothing read it after a child settled. And a goal's `model` judge that names no model ran on the goal thread's own model (ADR 0043, decision 2), reading a transcript that model wrote, flattened to one string in which its own text could forge a user's line or a tool's output.

Decided by the user on 2026-11-09, as the reviewer recommended:

1. **A spawn names its command.** `subagent_spawn` takes an optional `done_when`, a command as an argv list that exits 0 once the work is done. It is frozen into the brief as a command criterion, shown on the brief card before Go ("Done when"), and given to the child in its first input with the ask to run it. Without one the brief keeps "The parent accepts the result.", and the card says what that is: "No outside judge; the parent accepts the result" (a workflow node's brief: the workflow script accepts it). The card never says "judged by you" for a brief.
2. **Cairn does not run the command yet.** Running it when the child settles, through the judge run machinery in the child's workspace and under the child's own permission mode, and showing the verdict as the work panel's "Checked by an outside judge" step, needs more than a contained change to `verdicts/`: a child has no goal document, the reporter needs a phase that waits on a judge before it writes the result's note, the settlement and `cairn.child` need a verdict field (a protocol schema change the clients read), and the web's work panel needs to read it. So this ADR records the field and the truthful texts only; the card says the command is not run yet. What the run still needs is listed below.
3. **A model judge on the thread's own model is refused unless the user picked it.** A judge that names no model would run on the goal thread's own model and is refused, at `goal_criteria`, at `goal.setCriteria` and at the judge run, with words the card and the verdict note show ("... is this thread's own model, so a judge on it would grade its own work"). The thread's model may not propose itself as a judge; the user may name it, in criteria the user sets or a bound criterion, since the user then chose it. This narrows ADR 0043's decision 2 for goal judges only; a subagent or a workflow node that names no model still runs on its parent's.
4. **The model judge reads fenced turns.** Each message of the judged transcript is a `<turn>` whose `from` (user, assistant or tool) Cairn sets; role labels and the fences' own tags are stripped from every turn's text, so an assistant message cannot forge a user's confirmation, a tool's output or the transcript's end; the system prompt tells the judge that a tool turn is evidence and an assistant turn is the judged model's own claim.

What running `done_when` still needs (for whoever takes it up):

- a task kind in the child's conversation (or a reporter phase between settling and `report`) that runs the command with `env.exec` in the child's cwd (its worktree, or the parent's checkout for a shared child), refusing to run it in a mode under which the child could not run a command, and recording exit, output tail and `HEAD` as `JudgeRun.runCommand` does;
- a `check` field on `SubagentSettlement` (and on `cairn.child`, for the work panel), with the protocol goldens regenerated;
- the reporter's note saying the verdict, and the parent's wake following it;
- `SubagentSteps.childStepsOf` gaining a `checked` step from that field, and the web's work panel passing it;
- the brief card's "Done when" words changing from "Cairn does not run it yet".

Consequences: the glossary's Brief, Workflow and Outside judge entries say what is true now. A goal criterion bound before this ADR with a model judge that names no model is refused by `goal_check`, in the refusal's words, until the user names a model for it.
