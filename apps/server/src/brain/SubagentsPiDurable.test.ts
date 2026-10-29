// The subagents extension's host-side pieces over a real pi-durable brain (the conformance suite's,
// `piDurableLayer`) and a migrated in-memory shell store: a parent spawns, the user says Go, and
// the child answers. Then:
//
// - the `SubagentRows` fiber makes the child's shell row as its creating commit lands, with its
//   lineage, the parent's project, the brief's title and the dispatched model;
// - without the fiber, `repairSubagentRows` makes the same row at boot, and a second run makes no
//   other;
// - a user's input to the child whose reporter submits first (the brain dying between the steer's
//   commit and the seam's own submit) still reaches the child whole: its image and its entry, and
//   the client's resend lands on the same submission;
// - a child's question escalated when the parent's run ends, then left unanswered until it
//   expires (a short TTL here, a day in production), ends in the parent too: its mirror expires
//   and the registry stops counting the question open.
//
// Kept under `brain/`, where pi-durable may be imported in a test (S42).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConversationId, ThreadId } from "@cairn/protocol/Ids";
import {
  ApprovalId,
  ConversationId as ConversationIdOf,
} from "@cairn/protocol/Ids";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { AgentDoc } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Stream,
} from "effect";
import type { Scope } from "effect";

import { EventSink } from "../shell/EventSink.ts";
import {
  createProject,
  createThread,
  ShellTestLayer,
  testThreadId,
} from "../shell/ShellTestKit.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { ChildDoc, SubagentsDoc } from "../subagents/SubagentDocs.ts";
import { repairSubagentRows, SubagentRows } from "../subagents/SubagentRows.ts";
import { steerReporter } from "../subagents/Subagents.ts";
import { DEFAULT_TOOL_OPTIONS } from "../subagents/SubagentTools.ts";
import type { SubagentToolOptions } from "../subagents/SubagentTools.ts";
import { Brain } from "./Brain.ts";
import { Approvals } from "./CairnDocs.ts";
import { piDurableLayer } from "./conformance/Targets.ts";
import { durable } from "./Durable.ts";
import { FauxModels } from "./FauxModels.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import type { HarnessEvent } from "./HarnessSeam.ts";
import { FAUX_MODEL } from "./ModelSource.ts";
import { piConversationId } from "./PiIds.ts";
import { NO_SUBAGENT_FAULTS } from "./SubagentFaults.ts";
import { SubagentToolText } from "./SubagentText.ts";

/** A 1x1 PNG. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const PARENT = testThreadId(1);

/** A child's question's lifetime here: long enough to escalate first, short enough to wait out. */
const QUESTION_TTL_MILLIS = 2000;

/** The entry a user's attachment input is placed as. */
const STEER_ENTRY = { kind: "cairn.test-attachment", data: { by: "user" } };

/** Polls `find` until it finds something, for up to ten seconds. */
const waitFor = <A, E, R>(find: Effect.Effect<Option.Option<A>, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = yield* find;

      if (Option.isSome(found)) {
        return found.value;
      }

      yield* Effect.sleep(Duration.millis(50));
    }

    return yield* Effect.die("waited ten seconds for nothing");
  });

/** The first event `pick` accepts, waited for. */
const eventWhere = <A>(
  events: Ref.Ref<ReadonlyArray<HarnessEvent>>,
  pick: (event: HarnessEvent) => Option.Option<A>
) =>
  waitFor(
    Effect.map(Ref.get(events), (all) => Option.firstSomeOf(all.map(pick)))
  );

/** What a started child is known by. */
interface StartedChild {
  readonly threadId: ThreadId;
  readonly conversationId: ConversationId;
}

/** The parent's spawn and its answer while the brief waits for Go. */
const SPAWN_RESPONSES = [
  fauxAssistantMessage(
    fauxToolCall(
      "subagent_spawn",
      {
        description: "Count the files",
        brief: "Count the files in src.",
      },
      { id: "call_1" }
    ),
    { stopReason: "toolUse" }
  ),
  fauxAssistantMessage("Waiting for Go."),
];

/** The model's answers in order: the spawn, then the child's first answer and what follows. */
const ANSWER_RESPONSES = [
  ...SPAWN_RESPONSES,
  fauxAssistantMessage("src has 4 files."),
  fauxAssistantMessage("Noted."),
  fauxAssistantMessage("The image shows one pixel."),
];

/** A spawn whose brief asks for a worktree (a writing role's), then the child's answer. */
const WORKTREE_RESPONSES = [
  fauxAssistantMessage(
    fauxToolCall(
      "subagent_spawn",
      {
        description: "Fix the readme",
        brief: "Fix the typo in README.md.",
        isolation: "worktree",
      },
      { id: "call_1" }
    ),
    { stopReason: "toolUse" }
  ),
  fauxAssistantMessage("Waiting for Go."),
  fauxAssistantMessage("Fixed."),
  fauxAssistantMessage("Noted."),
];

/** Runs git in `cwd` with a test identity, returning its trimmed output. */
const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Cairn Test",
      "-c",
      "user.email=test@cairn.invalid",
      ...args,
    ],
    { cwd, encoding: "utf-8" }
  ).trim();

/** How a test's brain is set up. */
interface ChildSetup {
  /** Adds the `SubagentRows` fiber. */
  readonly withRows: boolean;
  /** The faux model's answers, in the order the threads ask. */
  readonly responses: ReadonlyArray<ReturnType<typeof fauxAssistantMessage>>;
  readonly tuning: SubagentToolOptions;
  /** The parent's cwd; the test's own when none. */
  readonly parentCwd?: string;
}

/**
 * Over a fresh brain and shell: the parent's row, a spawn the user approves, and the child's
 * first input settled.
 */
const withStarted = <A, E>(
  setup: ChildSetup,
  body: (
    child: StartedChild
  ) => Effect.Effect<
    A,
    E,
    Scope.Scope | Brain | HarnessSeam | ThreadRows | EventSink
  >
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-subagents-"))),
    (dataDir) =>
      Effect.scoped(
        Effect.gen(function* () {
          const brainLayer = piDurableLayer(
            dataDir,
            NO_SUBAGENT_FAULTS,
            setup.tuning
          );

          const base = Layer.merge(brainLayer, ShellTestLayer);

          const layer = setup.withRows
            ? Layer.merge(base, SubagentRows.pipe(Layer.provide(base)))
            : base;

          const context = yield* Layer.build(layer);
          const seam = Context.get(context, HarnessSeam);
          const brain = Context.get(context, Brain);
          const sink = Context.get(context, EventSink);
          const { faux } = Context.get(context, FauxModels);
          const events = yield* Ref.make<ReadonlyArray<HarnessEvent>>([]);

          yield* seam.events.pipe(
            Stream.runForEach((event) =>
              Ref.update(events, (all) => [...all, event])
            ),
            Effect.forkScoped
          );

          const project = createProject(1);

          yield* sink.commitCommand(project.command);
          yield* sink.commitCommand(createThread(project.projectId, 1));

          faux.setResponses([...setup.responses]);

          yield* brain.resume;
          yield* seam.ensureThread({
            threadId: PARENT,
            projectId: project.projectId,
            model: FAUX_MODEL,
            thinkingLevel: "off",
            cwd: setup.parentCwd ?? process.cwd(),
            instructions: Option.none(),
            runtimeMode: "full-access",
          });
          yield* seam.submit(PARENT, {
            requestId: "r1",
            content: [{ type: "text", text: "delegate it" }],
            entry: Option.none(),
            whenBusy: "followUp",
          });

          const brief = yield* eventWhere(events, (event) =>
            Predicate.isTagged(event, "RuntimeRequestUpdated") &&
            event.kind === "brief" &&
            event.status === "pending"
              ? Option.some(event.id)
              : Option.none()
          );

          yield* seam.respond(PARENT, ApprovalId.make(brief), {
            decision: "accept",
            reason: Option.none(),
            answers: Option.none(),
          });

          const child = yield* eventWhere(events, (event) =>
            Predicate.isTagged(event, "ThreadEnsured") &&
            Option.isSome(event.parent)
              ? Option.some({
                  threadId: event.threadId,
                  conversationId: event.conversationId,
                })
              : Option.none()
          );

          yield* eventWhere(events, (event) =>
            Predicate.isTagged(event, "SubagentUpdated") &&
            event.child === child.threadId &&
            event.status === "settled"
              ? Option.some(true)
              : Option.none()
          );

          return yield* body(child).pipe(Effect.provideContext(context));
        })
      ).pipe(Effect.orDie),
    (dataDir) =>
      Effect.sync(() => {
        rmSync(dataDir, { recursive: true, force: true });
      })
  );

/** `withStarted` over the plain spawn and answer, with the production tools. */
const withChild = <A, E>(
  withRows: boolean,
  body: (
    child: StartedChild
  ) => Effect.Effect<
    A,
    E,
    Scope.Scope | Brain | HarnessSeam | ThreadRows | EventSink
  >
) =>
  withStarted(
    {
      withRows,
      responses: ANSWER_RESPONSES,
      tuning: DEFAULT_TOOL_OPTIONS,
    },
    body
  );

/** The child's row, once it exists. */
const rowOf = (threadId: ThreadId) =>
  Effect.flatMap(ThreadRows, (rows) => rows.get(threadId));

/** Asserts the child's row is the one its parent and dispatch describe. */
const assertChildRow = (child: StartedChild) =>
  Effect.gen(function* () {
    const { shell } = yield* waitFor(rowOf(child.threadId));

    assert.deepStrictEqual(
      shell.lineage,
      Option.some({
        parentThreadId: PARENT,
        relationshipToParent: "subagent" as const,
        rootThreadId: PARENT,
      })
    );
    assert.strictEqual(shell.title, "Count the files");
    assert.strictEqual(shell.provider, FAUX_MODEL.provider);
    assert.strictEqual(shell.modelId, FAUX_MODEL.modelId);
  });

/** The child's entries, oldest first. */
const entriesOf = (conversationId: ConversationId) =>
  Effect.gen(function* () {
    const { harness } = yield* Effect.orDie(
      Effect.flatMap(Brain, (brain) => brain.session)
    );

    return yield* durable(
      "test.entries",
      async (context) =>
        await harness.commit(
          async (tx) =>
            await tx.scanEntries(
              {
                conversationId: piConversationId(conversationId),
                order: "ascending",
              },
              100
            ),
          context
        )
    ).pipe(Effect.map((page): ReadonlyArray<EntryRecord> => page.items));
  });

describe("subagents over a pi-durable brain", () => {
  it.live(
    "the SubagentRows fiber makes the child's row as it is created",
    () => withChild(true, assertChildRow),
    30_000
  );

  it.live(
    "the boot repair makes a missing child row, once",
    () =>
      withChild(false, (child) =>
        Effect.gen(function* () {
          assert.isTrue(Option.isNone(yield* rowOf(child.threadId)));

          yield* repairSubagentRows;
          yield* assertChildRow(child);
          yield* repairSubagentRows;

          const rows = yield* ThreadRows;

          assert.lengthOf(
            (yield* rows.listLive).filter(
              (row) => row.shell.id === child.threadId
            ),
            1
          );
        })
      ),
    30_000
  );

  it.live(
    "a steer whose reporter submits first reaches the child with its image and entry",
    () =>
      withChild(false, (child) =>
        Effect.gen(function* () {
          const brain = yield* Brain;
          const { harness } = yield* Effect.orDie(brain.session);

          const content = [
            { type: "text" as const, text: "What does this show?" },
            { type: "image" as const, data: PNG_BASE64, mimeType: "image/png" },
          ];

          // The steer's commit, and no seam submit after it: the brain died in between.
          yield* steerReporter(
            harness,
            piConversationId(child.conversationId),
            {
              type: "input",
              requestId: "u1",
              content,
              whenBusy: "followUp",
              entry: STEER_ENTRY,
            }
          );

          const placed = yield* waitFor(
            Effect.map(entriesOf(child.conversationId), (entries) =>
              Option.fromUndefinedOr(
                entries.find((entry) => entry.kind === STEER_ENTRY.kind)
              )
            )
          );

          assert.deepStrictEqual(placed.data, STEER_ENTRY.data);

          const [message] = placed.model ?? [];

          assert.isTrue(
            message?.role === "user" &&
              Array.isArray(message.content) &&
              message.content.some((part) => part.type === "image")
          );

          // The client's outbox resends after the restart: the same submission, nothing new.
          const seam = yield* HarnessSeam;

          yield* seam.submit(child.threadId, {
            requestId: "u1",
            content,
            entry: Option.some(STEER_ENTRY),
            whenBusy: "followUp",
          });

          const entries = yield* entriesOf(child.conversationId);

          assert.lengthOf(
            entries.filter((entry) => entry.kind === STEER_ENTRY.kind),
            1
          );
        })
      ),
    30_000
  );

  it.live(
    "a child's escalated question that expires settles its mirror and its registry question",
    () =>
      withStarted(
        {
          withRows: false,
          responses: [
            ...SPAWN_RESPONSES,
            fauxAssistantMessage(
              fauxToolCall(
                "ask_parent",
                { question: "Which folder?" },
                { id: "cq" }
              ),
              { stopReason: "toolUse" }
            ),
            // The parent's run that is shown the question ends without answering: escalated.
            fauxAssistantMessage("I cannot say."),
            fauxAssistantMessage("I counted src: 4 files."),
            fauxAssistantMessage("Noted."),
          ],
          tuning: {
            ...DEFAULT_TOOL_OPTIONS,
            questionTtlMillis: QUESTION_TTL_MILLIS,
          },
        },
        (child) =>
          Effect.gen(function* () {
            const brain = yield* Brain;
            const { harness } = yield* Effect.orDie(brain.session);

            const read = durable("test.read", async (context) => {
              const link = await harness.snapshot(
                ChildDoc,
                piConversationId(child.conversationId),
                context
              );

              const parent = piConversationId(
                ConversationIdOf.make(link?.parentConversationId ?? 0)
              );

              return {
                approvals: await harness.snapshot(Approvals, parent, context),
                registry: await harness.snapshot(SubagentsDoc, parent, context),
              };
            });

            const { approvals, registry } = yield* read;
            const records = Object.values(approvals?.items ?? {});

            const mirrors = records.filter(
              (record) => record.mirrorOf !== null
            );

            assert.deepStrictEqual(
              mirrors.map((mirror) => [mirror.status, mirror.decidedBy]),
              [["expired", { kind: "expiry" }]]
            );
            assert.lengthOf(
              records.filter((record) => record.status === "pending"),
              0
            );
            assert.deepStrictEqual(
              Object.values(registry?.items ?? {}).flatMap((item) =>
                Object.values(item.questions).map((question) => [
                  question.state,
                  question.escalatedAt === null,
                ])
              ),
              [["cancelled", false]]
            );

            // The child read why it got no answer, and went on.
            const results = (yield* entriesOf(child.conversationId)).filter(
              (entry) => entry.kind === "pi.tool-result"
            );

            assert.deepStrictEqual(
              results.flatMap((entry) =>
                (entry.model ?? []).flatMap((message) =>
                  message.role === "toolResult"
                    ? message.content.flatMap((part) =>
                        part.type === "text" ? [part.text] : []
                      )
                    : []
                )
              ),
              [SubagentToolText.questionEnded("expired")]
            );
          })
      ),
    30_000
  );

  it.live(
    "a writing role's child runs in its own worktree, on its own branch",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const dir = realpathSync(
            mkdtempSync(path.join(tmpdir(), "cairn-repo-"))
          );

          const repo = path.join(dir, "repo");

          mkdirSync(repo);
          git(repo, ["init", "--quiet", "-b", "main"]);
          git(repo, ["commit", "--quiet", "--allow-empty", "-m", "init"]);

          return { dir, repo };
        }),
        ({ repo }) =>
          withStarted(
            {
              withRows: true,
              responses: WORKTREE_RESPONSES,
              tuning: DEFAULT_TOOL_OPTIONS,
              parentCwd: repo,
            },
            (child) =>
              Effect.gen(function* () {
                const brain = yield* Brain;
                const { harness } = yield* Effect.orDie(brain.session);

                const { cwd, worktree } = yield* durable(
                  "test.read",
                  async (context) => {
                    const conversation = piConversationId(child.conversationId);

                    const agent = await harness.snapshot(
                      AgentDoc,
                      conversation,
                      context
                    );

                    const link = await harness.snapshot(
                      ChildDoc,
                      conversation,
                      context
                    );

                    const registry = await harness.snapshot(
                      SubagentsDoc,
                      piConversationId(
                        ConversationIdOf.make(link?.parentConversationId ?? 0)
                      ),
                      context
                    );

                    return {
                      cwd: agent?.cwd ?? "",
                      worktree: registry?.items[link?.key ?? ""]?.worktree,
                    };
                  }
                );

                // Its own checkout: not the parent's, on a branch of its own, and the one its
                // registry record names.
                assert.notStrictEqual(cwd, "");
                assert.notStrictEqual(cwd, repo);
                assert.strictEqual(worktree?.path, cwd);

                const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);

                assert.strictEqual(worktree?.branch, branch);
                assert.notStrictEqual(branch, "main");
                assert.strictEqual(
                  git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
                  "main"
                );
                assert.include(
                  git(repo, ["worktree", "list", "--porcelain"]),
                  `worktree ${cwd}`
                );

                // Its row names its worktree and branch, not its parent's.
                const { shell } = yield* waitFor(rowOf(child.threadId));

                assert.deepStrictEqual(shell.worktreePath, Option.some(cwd));
                assert.deepStrictEqual(shell.branch, Option.some(branch));
              })
          ),
        ({ dir }) =>
          Effect.sync(() => {
            rmSync(dir, { recursive: true, force: true });
          })
      ),
    30_000
  );
});
