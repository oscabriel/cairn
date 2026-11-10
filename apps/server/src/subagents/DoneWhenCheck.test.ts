// A brief's `done_when` command, run by Cairn when the child's run completes (V-9, ADR 0055), over
// a real pi-durable brain with the production subagents extension and a faux model:
//
// - a child whose command exits 0 settles with a met check, a child whose command exits 1 with a
//   not-met check carrying exit code 1, and the parent's note says so before its wake;
// - a child whose mode asks before a command (Auto-accept edits) has its check not run, saying
//   why, and the command never starts;
// - the brain dies while the command runs: the next boot over the same store neither runs the
//   command again nor loses the verdict. The check reads "not run", says the brain restarted, and the
//   parent gets one note and its wake.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ApprovalId, ProjectId } from "@cairn/protocol/Ids";
import type { ConversationId } from "@cairn/protocol/Ids";
import type { RuntimeMode } from "@cairn/protocol/Policy";
import { SUBAGENT_RESULT_ENTRY } from "@cairn/protocol/Subagents";
import type { SubagentSettlement } from "@cairn/protocol/Subagents";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { assert, describe, it } from "@effect/vitest";
import {
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Ref,
  Scope,
  Stream,
} from "effect";

import { Brain } from "../brain/Brain.ts";
import { BrainConfig } from "../brain/BrainConfig.ts";
import { brainExtensions } from "../brain/BrainTestKit.ts";
import { messageText } from "../brain/CommitFeed.ts";
import { conformanceTools } from "../brain/conformance/ConformanceTools.ts";
import { childWorkspacesAt } from "../brain/conformance/Targets.ts";
import { durable } from "../brain/Durable.ts";
import { FauxModels, FAUX_MODEL } from "../brain/FauxModels.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import type { HarnessEvent } from "../brain/HarnessSeam.ts";
import { PiDurableHarness } from "../brain/PiDurableHarness.ts";
import { piConversationId } from "../brain/PiIds.ts";
import { renderWake } from "../brain/SubagentText.ts";
import { eventuallySome as waitFor, testLimit } from "../EventuallyTestKit.ts";
import { isolateGitEnvironment } from "../git/GitTestKit.ts";
import { ModelHealth } from "../models/ModelHealth.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { testThreadId } from "../shell/ShellTestKit.ts";
import { BudgetBook } from "../usage/BudgetBook.ts";
import { Subagents } from "./Subagents.ts";

isolateGitEnvironment();

const PARENT = testThreadId(1);

const DESCRIPTION = "Fix the parser";

/** The production subagents extension over a faux model, its store under `dataDir`. */
const brainLayer = (dataDir: string) =>
  PiDurableHarness.layer.pipe(
    Layer.provide(
      brainExtensions({
        extra: [conformanceTools],
        subagents: Subagents.layer,
      })
    ),
    Layer.provideMerge(BudgetBook.layer),
    Layer.provideMerge(ModelHealth.layerTest),
    Layer.provideMerge(SettingsStore.layerTest),
    Layer.provideMerge(
      FauxModels.layer({
        tokensPerSecond: 4000,
        settings: { retry: { enabled: false } },
      })
    ),
    Layer.provideMerge(childWorkspacesAt(dataDir)),
    Layer.provide(BrainConfig.layerFrom(dataDir))
  );

type Services = Layer.Success<ReturnType<typeof brainLayer>>;

/** The parent's spawn of a shared child whose brief names `doneWhen`, then its wait for Go. */
const spawning = (doneWhen: ReadonlyArray<string>) => [
  fauxAssistantMessage(
    fauxToolCall(
      "subagent_spawn",
      {
        description: DESCRIPTION,
        brief: "Make the parser's tests pass.",
        done_when: [...doneWhen],
      },
      { id: "c1" }
    ),
    { stopReason: "toolUse" }
  ),
  fauxAssistantMessage("Waiting for Go."),
];

/** A folder that is a git repository with one commit, and that commit's sha. */
const repoAt = (dir: string): string => {
  const git = (...args: ReadonlyArray<string>) =>
    execFileSync("git", [...args], { cwd: dir, encoding: "utf-8" }).trim();

  git("init", "-q");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "first"
  );

  return git("rev-parse", "HEAD");
};

/** A brain's events, collected for the rest of the scope. */
const collect = Effect.gen(function* () {
  const seam = yield* HarnessSeam;
  const events = yield* Ref.make<ReadonlyArray<HarnessEvent>>([]);

  yield* seam.events.pipe(
    Stream.runForEach((event) => Ref.update(events, (all) => [...all, event])),
    Effect.forkScoped
  );

  return events;
});

/** The parent thread, in `cwd`, in `mode` (full access unless named). */
const ensureParent = (cwd: string, mode: RuntimeMode = "full-access") =>
  Effect.flatMap(HarnessSeam, (seam) =>
    seam.ensureThread({
      threadId: PARENT,
      projectId: ProjectId.make("done-when"),
      model: FAUX_MODEL,
      thinkingLevel: "off",
      cwd,
      instructions: Option.none(),
      runtimeMode: mode,
    })
  );

/** Asks the parent to delegate, and says Go to the brief it proposes. */
const delegateAndGo = (events: Ref.Ref<ReadonlyArray<HarnessEvent>>) =>
  Effect.gen(function* () {
    const seam = yield* HarnessSeam;

    yield* seam.submit(PARENT, {
      requestId: "r1",
      content: [{ type: "text", text: "delegate it" }],
      entry: Option.none(),
      whenBusy: "followUp",
    });

    const brief = yield* waitFor(
      Effect.map(Ref.get(events), (all) =>
        Option.firstSomeOf(
          all.map((event) =>
            Predicate.isTagged(event, "RuntimeRequestUpdated") &&
            event.threadId === PARENT &&
            event.kind === "brief" &&
            event.status === "pending"
              ? Option.some(event.id)
              : Option.none()
          )
        )
      )
    );

    yield* seam.respond(PARENT, ApprovalId.make(brief), {
      decision: "accept",
      reason: Option.none(),
      answers: Option.none(),
      launch: Option.none(),
    });
  });

/** One entry of the parent's transcript, as the test reads it. */
interface SeenEntry {
  readonly kind: string;
  readonly data: unknown;
  readonly text: string;
}

/** Every entry of `conversation`, in order. */
const entriesOf = (conversation: ConversationId) =>
  Effect.gen(function* () {
    const { harness } = yield* Effect.flatMap(Brain, (brain) => brain.session);

    return yield* durable("test.entries", async (context) => {
      const page = await harness.commit(
        async (tx) =>
          await tx.scanEntries(
            {
              conversationId: piConversationId(conversation),
              order: "ascending",
            },
            500
          ),
        context
      );

      return page.items.map((entry): SeenEntry => ({
        kind: entry.kind,
        data: entry.data,
        text: (entry.model ?? []).map(messageText).join("\n"),
      }));
    });
  }).pipe(Effect.orDie);

/** The parent's transcript, once it holds the child's result note and the wake after it. */
const noteAndWake = (conversation: ConversationId) =>
  waitFor(
    Effect.map(entriesOf(conversation), (entries) => {
      const notes = entries.flatMap((entry, index) =>
        entry.kind === SUBAGENT_RESULT_ENTRY ? [{ entry, index }] : []
      );

      const wake = entries.findIndex((entry) =>
        entry.text.includes(renderWake(DESCRIPTION))
      );

      const [first] = notes;

      return first === undefined || wake === -1
        ? Option.none()
        : Option.some({
            notes: notes.length,
            // SAFETY: a result note's data is the reporter's settlement (`noteEntry`).
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            settlement: first.entry.data as SubagentSettlement,
            text: first.entry.text,
            wakeAfterNote: wake > first.index,
          });
    })
  );

/** Over a fresh brain in a fresh repository: `body` with the parent's conversation. */
const withBrain = <A, E>(
  responses: ReadonlyArray<FauxResponseStep>,
  body: (
    parent: ConversationId,
    head: string,
    repo: string
  ) => Effect.Effect<A, E, Services>,
  mode: RuntimeMode = "full-access"
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-done-when-"))),
    (dir) =>
      Effect.scoped(
        Effect.gen(function* () {
          const repo = path.join(dir, "repo");

          execFileSync("mkdir", ["-p", repo]);

          const head = repoAt(repo);

          const context = yield* Layer.build(
            brainLayer(path.join(dir, "data"))
          );

          return yield* Effect.gen(function* () {
            const events = yield* collect;
            const { faux } = yield* FauxModels;

            faux.setResponses([...responses]);
            yield* Effect.flatMap(Brain, (brain) => brain.resume);

            const ensured = yield* ensureParent(repo, mode);

            yield* delegateAndGo(events);

            return yield* body(ensured.conversationId, head, repo);
          }).pipe(Effect.provideContext(context));
        })
      ).pipe(Effect.orDie),
    (dir) =>
      Effect.sync(() => {
        rmSync(dir, { recursive: true, force: true });
      })
  );

describe("a brief's done_when command, run when the child settles (V-9)", () => {
  it.live(
    "a command that exits 0 settles the child with a met check, and the parent's note says so before its wake",
    () =>
      withBrain(
        [
          ...spawning(["true"]),
          fauxAssistantMessage("The tests pass."),
          fauxAssistantMessage("Noted."),
        ],
        (parent, head) =>
          Effect.gen(function* () {
            const seen = yield* noteAndWake(parent);
            const { check } = seen.settlement;

            assert.strictEqual(seen.notes, 1);
            assert.isTrue(seen.wakeAfterNote);
            assert.strictEqual(check?.verdict, "met");
            assert.deepStrictEqual(check?.argv, ["true"]);
            assert.isTrue(
              check !== undefined &&
                check.verdict !== "notRun" &&
                check.exit === 0 &&
                check.sha === head
            );
            assert.include(
              seen.text,
              "Done when `true` exits 0: met, checked by an outside judge (exit 0)"
            );
          })
      ),
    testLimit(30_000)
  );

  it.live(
    "a command that exits 1 settles the child with a not-met check carrying exit 1, and the parent's note says so",
    () =>
      withBrain(
        [
          ...spawning(["false"]),
          fauxAssistantMessage("The tests pass."),
          fauxAssistantMessage("Noted."),
        ],
        (parent) =>
          Effect.gen(function* () {
            const seen = yield* noteAndWake(parent);
            const { check } = seen.settlement;

            assert.strictEqual(seen.notes, 1);
            assert.isTrue(seen.wakeAfterNote);
            assert.strictEqual(check?.verdict, "notMet");
            assert.isTrue(
              check !== undefined &&
                check.verdict !== "notRun" &&
                check.exit === 1
            );
            assert.include(
              seen.text,
              "Done when `false` exits 0: not met, checked by an outside judge (exit 1)"
            );
          })
      ),
    testLimit(30_000)
  );

  it.live(
    "a child whose mode asks before a command has its check not run, saying why, and the command never starts",
    () =>
      withBrain(
        [
          ...spawning(["sh", "-c", "echo started > ran.txt"]),
          fauxAssistantMessage("The tests pass."),
          fauxAssistantMessage("Noted."),
        ],
        (parent, _head, repo) =>
          Effect.gen(function* () {
            const seen = yield* noteAndWake(parent);
            const { check } = seen.settlement;

            assert.strictEqual(check?.verdict, "notRun");
            assert.include(
              seen.text,
              "not checked; the child runs in Auto-accept edits mode, where a command asks first"
            );
            assert.isFalse(existsSync(path.join(repo, "ran.txt")));
          }),
        "auto-accept-edits"
      ),
    testLimit(30_000)
  );

  it.live(
    "a brain that dies while the command runs never runs it again, and the parent still gets one note saying it was not run",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          mkdtempSync(path.join(tmpdir(), "cairn-done-when-crash-"))
        ),
        (dir) =>
          Effect.gen(function* () {
            const repo = path.join(dir, "repo");
            const dataDir = path.join(dir, "data");
            const ran = path.join(repo, "ran.txt");

            execFileSync("mkdir", ["-p", repo]);
            repoAt(repo);

            // The command marks each start, then runs until the brain dies under it.
            const command = [
              "sh",
              "-c",
              "echo started >> ran.txt; exec sleep 60",
            ];

            // The first boot: the child completes and its check starts the command; the brain then
            // closes with the command still running, as after `kill -9`, so the check commits
            // nothing.
            const scope = yield* Scope.make();

            const first = yield* Layer.buildWithScope(
              brainLayer(dataDir),
              scope
            );

            const parent = yield* Effect.gen(function* () {
              const events = yield* collect.pipe(Scope.provide(scope));
              const { faux } = yield* FauxModels;

              faux.setResponses([
                ...spawning(command),
                fauxAssistantMessage("The tests pass."),
              ]);
              yield* Effect.flatMap(Brain, (brain) => brain.resume);

              const ensured = yield* ensureParent(repo);

              yield* delegateAndGo(events);

              yield* waitFor(
                Effect.sync(() =>
                  existsSync(ran) ? Option.some(true) : Option.none()
                )
              );

              return ensured.conversationId;
            }).pipe(Effect.provideContext(first));

            yield* Scope.close(scope, Exit.void);

            // The next boot over the same store: the check resumes, finds the command started
            // before, and records that it did not run it again.
            yield* Effect.gen(function* () {
              const next = yield* Layer.build(brainLayer(dataDir));

              yield* Effect.gen(function* () {
                const { faux } = yield* FauxModels;

                faux.setResponses([fauxAssistantMessage("Noted.")]);
                yield* Effect.flatMap(Brain, (brain) => brain.resume);

                const seen = yield* noteAndWake(parent);
                const { check } = seen.settlement;

                assert.strictEqual(seen.notes, 1);
                assert.isTrue(seen.wakeAfterNote);
                assert.strictEqual(check?.verdict, "notRun");
                assert.isTrue(
                  check?.verdict === "notRun" &&
                    check.why.includes("brain restarted")
                );
                assert.include(seen.text, "not checked");

                // A while later, the command has still started only once.
                yield* Effect.sleep(Duration.millis(300));
                assert.deepStrictEqual(
                  readFileSync(ran, "utf-8").trim().split("\n"),
                  ["started"]
                );
              }).pipe(Effect.provideContext(next));
            }).pipe(Effect.scoped);
          }).pipe(Effect.orDie),
        (dir) =>
          Effect.sync(() => {
            rmSync(dir, { recursive: true, force: true });
          })
      ),
    testLimit(60_000)
  );
});
