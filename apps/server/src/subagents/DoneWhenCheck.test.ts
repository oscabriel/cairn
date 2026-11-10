// A brief's `done_when` command, run by Cairn when the child's run completes (V-9, ADR 0055), over
// a real pi-durable brain with the production subagents extension and a faux model:
//
// - a child whose command exits 0 settles with a met check, a child whose command exits 1 with a
//   not-met check carrying exit code 1, and the parent's note says so before its wake;
// - a child whose mode asks before a command (Auto-accept edits) has its check not run, saying
//   why, and the command never starts;
// - the brain dies while the command runs: the next boot over the same store neither runs the
//   command again nor loses the verdict. The check reads "not run", says the brain restarted, and the
//   parent gets one note and its wake;
// - `subagent_status` reads a child whose check runs as checking, naming the command, and its wait
//   returns once the note with the verdict landed, not when the run settled;
// - a later run's check stops the earlier one still running: the earlier note reads "not run",
//   superseded, the later one met, and the command never runs twice at once; a later run that is
//   stopped keeps its "not run" on `cairn.child` when the earlier check ends after it;
// - a stopped run, a failed run, a relayed question ended by `subagent_stop`, a check that is aborted
//   or faults, and a reporter that throws in its `check` phase each settle once, with a note (and a
//   wake, except the reporter that threw: O-3 keeps the result, never the wake); `subagent_stop`
//   stops a running check, which reads "not run", the child having been stopped;
// - an over-long argv still leaves a verdict, its note cut to fit.

import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ApprovalId, ProjectId, ThreadId } from "@cairn/protocol/Ids";
import type { ConversationId } from "@cairn/protocol/Ids";
import type { RuntimeMode } from "@cairn/protocol/Policy";
import { SUBAGENT_RESULT_ENTRY } from "@cairn/protocol/Subagents";
import type { SubagentSettlement } from "@cairn/protocol/Subagents";
import type { JsonValue } from "@earendil-works/chord/json";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import type {
  FauxResponseFactory,
  FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
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
import { ChildDoc, SubagentsDoc } from "../brain/SubagentDocs.ts";
import type { SubagentItemState } from "../brain/SubagentDocs.ts";
import { SubagentCrashes } from "../brain/SubagentFaults.ts";
import type {
  SubagentCrashHooks,
  SubagentCrashPoint,
} from "../brain/SubagentFaults.ts";
import { renderWake } from "../brain/SubagentText.ts";
import { eventuallySome as waitFor, testLimit } from "../EventuallyTestKit.ts";
import { isolateGitEnvironment } from "../git/GitTestKit.ts";
import { ModelHealth } from "../models/ModelHealth.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { testThreadId } from "../shell/ShellTestKit.ts";
import { BudgetBook } from "../usage/BudgetBook.ts";
import { conversationOf } from "./Delivery.ts";
import { CHECK_TASK, CheckWhy, checkOfOutcome } from "./DoneWhenCheck.ts";
import { Subagents } from "./Subagents.ts";

isolateGitEnvironment();

const PARENT = testThreadId(1);

const DESCRIPTION = "Fix the parser";

/** What a planted throw says, so a test can find it in what the parent read. */
const PLANTED = "planted: this phase broke";

/** Hooks that throw once at `point`, and nowhere else; none without a point. */
const throwOnceAt = (
  point: Option.Option<SubagentCrashPoint>
): SubagentCrashHooks => {
  let fired = false;

  return {
    at: (reached) => {
      if (!fired && Option.contains(point, reached)) {
        fired = true;

        throw new Error(PLANTED);
      }
    },
  };
};

/**
 * The production subagents extension over a faux model, its store under `dataDir`, with a throw
 * planted once at `planted`.
 */
const brainLayer = (
  dataDir: string,
  planted: Option.Option<SubagentCrashPoint> = Option.none()
) =>
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
    Layer.provide(BrainConfig.layerFrom(dataDir)),
    Layer.provide(Layer.succeed(SubagentCrashes, throwOnceAt(planted)))
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
  /** The ids of the tool calls an assistant entry makes. */
  readonly toolCalls: ReadonlyArray<string>;
  /** The tool call a tool result answers. */
  readonly toolResultOf: string | null;
}

/** `message`'s text: a tool result's own text parts, or what `messageText` reads of the rest. */
const textOf = (message: Message): string =>
  message.role === "toolResult"
    ? message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
    : messageText(message);

/** The tool calls `message` makes, and the call it answers. */
const toolsOf = (message: Message) => ({
  toolCalls:
    message.role === "assistant"
      ? message.content.flatMap((part) =>
          part.type === "toolCall" ? [part.id] : []
        )
      : [],
  toolResultOf: message.role === "toolResult" ? message.toolCallId : null,
});

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

      return page.items.map((entry): SeenEntry => {
        const messages = entry.model ?? [];

        return {
          kind: entry.kind,
          data: entry.data,
          text: messages.map(textOf).join("\n"),
          toolCalls: messages.flatMap((message) => toolsOf(message).toolCalls),
          toolResultOf:
            messages.map((message) => toolsOf(message).toolResultOf)[0] ?? null,
        };
      });
    });
  }).pipe(Effect.orDie);

/** The parent's registry item of its one child, once it holds one. */
const childOf = (parent: ConversationId) =>
  waitFor(
    Effect.gen(function* () {
      const { harness } = yield* Effect.flatMap(
        Brain,
        (brain) => brain.session
      );

      const registry = yield* durable(
        "test.registry",
        async (context) =>
          await harness.snapshot(
            SubagentsDoc,
            piConversationId(parent),
            context
          )
      );

      return Option.fromUndefinedOr(Object.values(registry?.items ?? {})[0]);
    }).pipe(Effect.orDie)
  );

/** The check `child`'s `cairn.child` holds for the work panel. */
const childCheckOf = (child: Pick<SubagentItemState, "conversationId">) =>
  Effect.gen(function* () {
    const { harness } = yield* Effect.flatMap(Brain, (brain) => brain.session);

    const link = yield* durable(
      "test.child",
      async (context) =>
        await harness.snapshot(
          ChildDoc,
          conversationOf(child.conversationId),
          context
        )
    );

    return Option.fromUndefinedOr(link?.check);
  }).pipe(Effect.orDie);

/** The parent's result notes, in order, once it holds `count`. */
const notesOf = (parent: ConversationId, count: number) =>
  waitFor(
    Effect.map(entriesOf(parent), (entries) => {
      const notes = entries.flatMap((entry) =>
        entry.kind === SUBAGENT_RESULT_ENTRY
          ? [
              {
                // SAFETY: a result note's data is the reporter's settlement (`noteEntry`).
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                settlement: entry.data as SubagentSettlement,
                text: entry.text,
              },
            ]
          : []
      );

      return notes.length >= count ? Option.some(notes) : Option.none();
    })
  );

/** How many wakes from the child the parent's transcript holds. */
const wakesIn = (parent: ConversationId) =>
  Effect.map(
    entriesOf(parent),
    (entries) =>
      entries.filter((entry) => entry.text.includes(renderWake(DESCRIPTION)))
        .length
  );

/** The text of the tool result answering `call` in the parent's transcript, once there is one. */
const toolResultIn = (parent: ConversationId, call: string) =>
  waitFor(
    Effect.map(entriesOf(parent), (entries) =>
      Option.fromUndefinedOr(
        entries.find((entry) => entry.toolResultOf === call)?.text
      )
    )
  );

/** The child's thread id, as the brief's answer in the parent's context names it. */
const childIdIn = (messages: ReadonlyArray<Message>): string => {
  for (const message of messages) {
    const found = /subagent thread (?<child>\S+) started/u.exec(
      messageText(message)
    );

    if (found?.groups?.child !== undefined) {
      return found.groups.child;
    }
  }

  return "";
};

/** The parent's call of `tool` on its child, with `args` beside the child's name. */
const callOnChild =
  (
    tool: string,
    id: string,
    args: { readonly [key: string]: JsonValue } = {}
  ): FauxResponseFactory =>
  (context) =>
    fauxAssistantMessage(
      fauxToolCall(
        tool,
        { subagent: childIdIn(context.messages), ...args },
        { id }
      ),
      { stopReason: "toolUse" }
    );

/** The parent's `subagent_status` call, with `args`. */
const statusCall = (id: string, args: { readonly [key: string]: JsonValue }) =>
  fauxAssistantMessage(fauxToolCall("subagent_status", args, { id }), {
    stopReason: "toolUse",
  });

/** A model answer that never comes: the run goes on until it is aborted. */
const untilAborted: FauxResponseFactory = async (_context, options) => {
  if (options?.signal !== undefined) {
    await once(options.signal, "abort");
  }

  return fauxAssistantMessage("", { stopReason: "aborted" });
};

/** Submits `text` to `threadId` as a user's input. */
const say = (threadId: ThreadId, requestId: string, text: string) =>
  Effect.flatMap(HarnessSeam, (seam) =>
    seam.submit(threadId, {
      requestId,
      content: [{ type: "text", text }],
      entry: Option.none(),
      whenBusy: "followUp",
    })
  );

/** Waits for `file` to exist. */
const fileExists = (file: string) =>
  waitFor(
    Effect.sync(() => (existsSync(file) ? Option.some(true) : Option.none()))
  );

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
    repo: string,
    events: Ref.Ref<ReadonlyArray<HarnessEvent>>
  ) => Effect.Effect<A, E, Services>,
  mode: RuntimeMode = "full-access",
  planted: Option.Option<SubagentCrashPoint> = Option.none()
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
            brainLayer(path.join(dir, "data"), planted)
          );

          return yield* Effect.gen(function* () {
            const events = yield* collect;
            const { faux } = yield* FauxModels;

            faux.setResponses([...responses]);
            yield* Effect.flatMap(Brain, (brain) => brain.resume);

            const ensured = yield* ensureParent(repo, mode);

            yield* delegateAndGo(events);

            return yield* body(ensured.conversationId, head, repo, events);
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

/** A brief command that starts, marks it, and runs until the test writes `release`. */
const UNTIL_RELEASED = [
  "sh",
  "-c",
  "touch started; while [ ! -f release ]; do sleep 0.05; done",
];

/** How long a test lets the brain run on before it checks nothing more happened. */
const SETTLE = Duration.millis(300);

/** The run starts of `threadId` among the brain's events so far. */
const runStarts = (
  events: Ref.Ref<ReadonlyArray<HarnessEvent>>,
  threadId: ThreadId
) =>
  Effect.map(
    Ref.get(events),
    (all) =>
      all.filter(
        (event) =>
          Predicate.isTagged(event, "RunStarted") && event.threadId === threadId
      ).length
  );

/** Waits until `threadId` has started `count` runs. */
const runsStarted = (
  events: Ref.Ref<ReadonlyArray<HarnessEvent>>,
  threadId: ThreadId,
  count: number
) =>
  waitFor(
    Effect.map(runStarts(events, threadId), (started) =>
      started >= count ? Option.some(started) : Option.none()
    )
  );

/** Stops `threadId`'s run as the user's Stop does, keeping its queue and its children. */
const stopThread = (threadId: ThreadId) =>
  Effect.flatMap(HarnessSeam, (seam) =>
    seam.stop(threadId, { clearQueue: false, subagents: "keep" })
  );

/** `check` is a check Cairn did not run, saying `why`. */
const assertNotRun = (
  check: { readonly verdict: string; readonly why?: string } | undefined,
  why: string
) => {
  assert.strictEqual(check?.verdict, "notRun");
  assert.strictEqual(check?.why, why);
};

/**
 * The child's one result: once the parent holds its note and the wake after it, and a while later
 * still exactly one of each.
 */
const settledOnceWithWake = (parent: ConversationId) =>
  Effect.gen(function* () {
    const seen = yield* noteAndWake(parent);

    yield* Effect.sleep(SETTLE);

    const notes = yield* notesOf(parent, 1);

    assert.strictEqual(notes.length, 1);
    assert.isTrue(seen.wakeAfterNote);
    assert.strictEqual(yield* wakesIn(parent), 1);

    return seen;
  });

describe("subagent_status while a child's check runs (ADR 0055)", () => {
  it.live(
    "reads the child as checking, naming the command, and its wait returns once the note with the verdict landed",
    () =>
      withBrain(
        [
          ...spawning(UNTIL_RELEASED),
          fauxAssistantMessage("The tests pass."),
          statusCall("s1", {}),
          statusCall("s2", { wait_seconds: 60 }),
          fauxAssistantMessage("It reported."),
          fauxAssistantMessage("Noted."),
        ],
        (parent, _head, repo) =>
          Effect.gen(function* () {
            // The child's run completed, and its check runs the command.
            yield* fileExists(path.join(repo, "started"));
            yield* say(PARENT, "r2", "How is it going?");

            const first = yield* toolResultIn(parent, "s1");

            assert.include(
              first,
              `"${DESCRIPTION}": checking: Cairn runs \`${UNTIL_RELEASED.join(" ")}\``
            );
            assert.notInclude(first, "settled");

            // The waiting call holds while the check runs.
            yield* waitFor(
              Effect.map(entriesOf(parent), (entries) =>
                entries.some((entry) => entry.toolCalls.includes("s2"))
                  ? Option.some(true)
                  : Option.none()
              )
            );
            yield* Effect.sleep(Duration.millis(500));
            assert.isFalse(
              (yield* entriesOf(parent)).some(
                (entry) => entry.toolResultOf === "s2"
              )
            );

            writeFileSync(path.join(repo, "release"), "");

            // It returns once the note with the verdict landed, well inside its bound.
            const second = yield* toolResultIn(parent, "s2");
            const [note] = yield* notesOf(parent, 1);

            assert.include(second, `"${DESCRIPTION}": settled`);
            assert.strictEqual(note?.settlement.check?.verdict, "met");
            assert.include(
              note?.text ?? "",
              ": met, checked by an outside judge"
            );
          })
      ),
    testLimit(30_000)
  );
});

describe("a child's checks, one at a time (ADR 0055)", () => {
  it.live(
    "a later run's check stops the earlier one still running, whose note reads superseded, and never runs the command beside it",
    () => {
      // The first run sleeps; each start notes whether the run before it is still alive.
      const command = [
        "sh",
        "-c",
        'if [ -f pid ] && kill -0 "$(cat pid)" 2>/dev/null; then echo overlap >> log; fi; echo $$ > pid; if [ ! -f log ]; then echo start >> log; exec sleep 30; fi; echo start >> log',
      ];

      return withBrain(
        [
          ...spawning(command),
          fauxAssistantMessage("First pass."),
          fauxAssistantMessage("Second pass."),
          fauxAssistantMessage("Noted."),
          fauxAssistantMessage("Noted."),
        ],
        (parent, _head, repo) =>
          Effect.gen(function* () {
            const log = path.join(repo, "log");

            const lines = () =>
              existsSync(log)
                ? readFileSync(log, "utf-8").trim().split("\n")
                : [];

            // The first run's check runs its command.
            yield* fileExists(log);

            const child = yield* childOf(parent);

            yield* say(ThreadId.make(child.threadId), "r-again", "Once more.");

            // The second run's check ran its command.
            yield* waitFor(
              Effect.sync(() =>
                lines().filter((line) => line === "start").length >= 2
                  ? Option.some(true)
                  : Option.none()
              )
            );

            assert.deepStrictEqual(lines(), ["start", "start"]);

            const notes = yield* notesOf(parent, 2);

            const bySeq = (seq: number) =>
              notes.find((note) => note.settlement.seq === seq);

            assertNotRun(bySeq(1)?.settlement.check, CheckWhy.superseded);
            assert.include(
              bySeq(1)?.text ?? "",
              "not checked; a later run of the child superseded it."
            );
            assert.strictEqual(bySeq(2)?.settlement.check?.verdict, "met");

            const shown = yield* childCheckOf(child);

            assert.strictEqual(Option.getOrNull(shown)?.verdict, "met");
          })
      );
    },
    testLimit(30_000)
  );

  it.live(
    "a later run that is stopped keeps its not-run check on cairn.child when the earlier check ends after it",
    () => {
      const command = [
        "sh",
        "-c",
        "if [ ! -f log ]; then echo start >> log; while [ ! -f release ]; do sleep 0.05; done; fi; echo end >> log",
      ];

      return withBrain(
        [
          ...spawning(command),
          fauxAssistantMessage("First pass."),
          untilAborted,
          fauxAssistantMessage("Noted."),
          fauxAssistantMessage("Noted."),
        ],
        (parent, _head, repo, events) =>
          Effect.gen(function* () {
            yield* fileExists(path.join(repo, "log"));

            const child = yield* childOf(parent);

            yield* say(ThreadId.make(child.threadId), "r-again", "Once more.");
            yield* runsStarted(events, ThreadId.make(child.threadId), 2);
            yield* stopThread(ThreadId.make(child.threadId));

            const stopped = yield* notesOf(parent, 1);

            assert.strictEqual(stopped[0]?.settlement.seq, 2);
            assertNotRun(
              Option.getOrNull(yield* childCheckOf(child)) ?? undefined,
              CheckWhy.outcome("stopped")
            );

            // The first run's check ends now, after the second run settled.
            writeFileSync(path.join(repo, "release"), "");

            const notes = yield* notesOf(parent, 2);

            assert.strictEqual(
              notes.find((note) => note.settlement.seq === 1)?.settlement.check
                ?.verdict,
              "met"
            );
            assertNotRun(
              Option.getOrNull(yield* childCheckOf(child)) ?? undefined,
              CheckWhy.outcome("stopped")
            );
          })
      );
    },
    testLimit(30_000)
  );

  it.live(
    "subagent_stop stops the child's running check, which reads not run, the child having been stopped",
    () =>
      withBrain(
        [
          ...spawning(UNTIL_RELEASED),
          fauxAssistantMessage("The tests pass."),
          callOnChild("subagent_stop", "st"),
          fauxAssistantMessage("Stopped it."),
          fauxAssistantMessage("Noted."),
        ],
        (parent, _head, repo) =>
          Effect.gen(function* () {
            yield* fileExists(path.join(repo, "started"));
            yield* say(PARENT, "r2", "Stop it.");

            const seen = yield* settledOnceWithWake(parent);

            assertNotRun(seen.settlement.check, CheckWhy.stopped);
            assert.include(seen.text, "not checked; the child was stopped.");
          })
      ),
    testLimit(30_000)
  );
});

describe("every way a checked child settles, once (ADR 0055)", () => {
  it.live(
    "a stopped run is not checked, and settles once with a note and a wake",
    () =>
      withBrain(
        [...spawning(["true"]), untilAborted, fauxAssistantMessage("Noted.")],
        (parent, _head, _repo, events) =>
          Effect.gen(function* () {
            const child = yield* childOf(parent);

            yield* runsStarted(events, ThreadId.make(child.threadId), 1);
            yield* stopThread(ThreadId.make(child.threadId));

            const seen = yield* settledOnceWithWake(parent);

            assert.strictEqual(seen.settlement.outcome, "stopped");
            assertNotRun(seen.settlement.check, CheckWhy.outcome("stopped"));
            assert.include(
              seen.text,
              "not checked; the child's run was stopped"
            );
          })
      ),
    testLimit(30_000)
  );

  it.live(
    "a failed run is not checked, and settles once with a note and a wake",
    () =>
      withBrain(
        [
          ...spawning(["true"]),
          fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "401 invalid_api_key",
          }),
          fauxAssistantMessage("Noted."),
        ],
        (parent) =>
          Effect.gen(function* () {
            const seen = yield* settledOnceWithWake(parent);

            assert.strictEqual(seen.settlement.outcome, "failed");
            assertNotRun(seen.settlement.check, CheckWhy.outcome("failed"));
            assert.include(seen.text, "not checked; the child's run failed");
          })
      ),
    testLimit(30_000)
  );

  it.live(
    "a relayed question that ends unanswered settles the run's answer once, checked, with a note and a wake",
    () =>
      withBrain(
        [
          ...spawning(["true"]),
          fauxAssistantMessage("Which folder should I count?\n1. src\n2. lib"),
          callOnChild("subagent_stop", "st"),
          fauxAssistantMessage("Stopped it."),
          fauxAssistantMessage("Noted."),
        ],
        (parent) =>
          Effect.gen(function* () {
            const seen = yield* settledOnceWithWake(parent);

            assert.include(seen.text, "Which folder should I count?");
            assert.strictEqual(seen.settlement.check?.verdict, "met");
          })
      ),
    testLimit(30_000)
  );

  it.live(
    "a check task that is aborted reads not run, and the result settles once with a note and a wake",
    () =>
      withBrain(
        [
          ...spawning(UNTIL_RELEASED),
          fauxAssistantMessage("The tests pass."),
          fauxAssistantMessage("Noted."),
        ],
        (parent, _head, repo) =>
          Effect.gen(function* () {
            yield* fileExists(path.join(repo, "started"));

            const { harness } = yield* Effect.flatMap(
              Brain,
              (brain) => brain.session
            );

            yield* durable("test.abort-check", async (context) => {
              const page = await harness.commit(
                async (tx) =>
                  await tx.scanTasks(
                    { kind: CHECK_TASK, status: "running" },
                    10
                  ),
                context
              );

              for (const task of page.items) {
                // oxlint-disable-next-line no-await-in-loop -- one running check
                await harness.abortTask(task.id, context);
              }
            }).pipe(Effect.orDie);

            const seen = yield* settledOnceWithWake(parent);

            assertNotRun(seen.settlement.check, CheckWhy.aborted);
          })
      ),
    testLimit(30_000)
  );

  it.live(
    "a check task that faults reads not run, saying why, and the result settles once with a note and a wake",
    () =>
      withBrain(
        [
          ...spawning(["true"]),
          fauxAssistantMessage("The tests pass."),
          fauxAssistantMessage("Noted."),
        ],
        (parent) =>
          Effect.gen(function* () {
            const seen = yield* settledOnceWithWake(parent);

            assertNotRun(seen.settlement.check, CheckWhy.threw(PLANTED));
          }),
        "full-access",
        Option.some("check-judged")
      ),
    testLimit(30_000)
  );

  it.live(
    "a reporter that throws in its check phase still notes the result once, its check not run, and wakes nobody (O-3)",
    () =>
      withBrain(
        [...spawning(["true"]), fauxAssistantMessage("The tests pass.")],
        (parent) =>
          Effect.gen(function* () {
            const [note] = yield* notesOf(parent, 1);

            yield* Effect.sleep(SETTLE);

            assert.strictEqual((yield* notesOf(parent, 1)).length, 1);
            assert.strictEqual(yield* wakesIn(parent), 0);
            assertNotRun(note?.settlement.check, CheckWhy.threw(PLANTED));

            const child = yield* childOf(parent);

            assert.strictEqual(child.delivered, 1);
            assertNotRun(
              Option.getOrNull(yield* childCheckOf(child)) ?? undefined,
              CheckWhy.threw(PLANTED)
            );
          }),
        "full-access",
        Option.some("reporter-checking")
      ),
    testLimit(30_000)
  );

  it.live(
    "an over-long argv still leaves a verdict, its note cut to fit a display text",
    () =>
      withBrain(
        [
          // Near the brief's own cap (its criterion's text is a display text too), so the note,
          // which adds why it could not run, is longer than one.
          ...spawning([`missing-${"x".repeat(4000)}`]),
          fauxAssistantMessage("The tests pass."),
          fauxAssistantMessage("Noted."),
        ],
        (parent) =>
          Effect.gen(function* () {
            const seen = yield* settledOnceWithWake(parent);
            const { check } = seen.settlement;

            assert.strictEqual(check?.verdict, "notMet");
            assert.isTrue(
              check?.verdict === "notMet" &&
                check.note !== null &&
                check.note.length <= 4096
            );
          })
      ),
    testLimit(30_000)
  );
});

describe("a settled check task, read for its settlement", () => {
  const command = { argv: ["true"], expectExit: 0, timeoutSec: 10 };

  it("reads an aborted check task as not run, stopped before it finished", () => {
    const check = checkOfOutcome({ status: "aborted" }, command, 1);

    assert.strictEqual(check.verdict, "notRun");
    assert.strictEqual(
      check.verdict === "notRun" ? check.why : null,
      CheckWhy.aborted
    );
  });

  it("reads a faulted check task as not run, with its error", () => {
    const check = checkOfOutcome(
      { status: "faulted", error: { message: "it broke" } },
      command,
      1
    );

    assert.strictEqual(check.verdict, "notRun");
    assert.strictEqual(
      check.verdict === "notRun" ? check.why : null,
      CheckWhy.threw("it broke")
    );
  });

  it("reads an orphaned check task as not run, with its reason", () => {
    const check = checkOfOutcome(
      { status: "orphaned", reason: "missing_task" },
      command,
      1
    );

    assert.strictEqual(check.verdict, "notRun");
    assert.strictEqual(
      check.verdict === "notRun" ? check.why : null,
      CheckWhy.threw("missing_task")
    );
  });

  it("cuts a why longer than a display text", () => {
    const check = checkOfOutcome(
      { status: "orphaned", reason: "y".repeat(5000) },
      command,
      1
    );

    assert.isTrue(check.verdict === "notRun" && check.why.length === 4096);
  });
});
