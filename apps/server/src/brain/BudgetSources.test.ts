// Budget sources over a real pi-durable Harness (memory storage): a subagent's scope is its brief's
// budget (read through `cairn.child` and its parent's `cairn.approvals`) in `stop` mode; a declared
// budget keeps its mode; a budget with no enforced limit is no scope; each accepted raise replaces
// the budget and counts an epoch; a raise is asked and a notice written once per id, the notice
// landing in the transcript without starting a run.

import {
  ConversationId as StoredConversationId,
  ThreadId,
} from "@cairn/protocol/Ids";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import type { Budget } from "@cairn/protocol/Spend";
import { NOTICE_ENTRY_KIND } from "@cairn/protocol/Thread";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { UNDECIDED } from "../approvals/ApprovalLedger.ts";
import { Brain } from "./Brain.ts";
import type { BrainSession } from "./Brain.ts";
import {
  budgetJson,
  BudgetSources,
  raiseIdOf,
  RAISE_REPLACED,
  RAISE_TOOL,
} from "./BudgetSources.ts";
import { Approvals, ThreadMeta, ThreadReceipt } from "./CairnDocs.ts";
import type { ApprovalPayloadState, ApprovalRecord } from "./CairnDocs.ts";
import { EventsDoc, eventKind } from "./Events.ts";
import { piConversationId } from "./PiIds.ts";
import { ChildDoc } from "./SubagentDocs.ts";

const context = BACKGROUND_CONTEXT;

const PARENT = ThreadId.make("0190f0c0-0000-7000-8000-0000000000b1");

const CHILD = ThreadId.make("0190f0c0-0000-7000-8000-0000000000b2");

const BRIEF_ID = "call-7";

const BRIEF_BUDGET: Budget = {
  ...DEFAULT_BUDGET,
  maxListMicros: Micros.make(500_000),
};

/** A record as the ledger would store it, past the fields each test sets. */
const record = (
  id: string,
  fields: Pick<ApprovalRecord, "tool" | "kind" | "status" | "payload">
): ApprovalRecord => ({
  id,
  toolTaskId: 0,
  summary: id,
  askedAt: 1,
  expiresAt: 2,
  answeredAt: null,
  run: null,
  executorRequestId: null,
  ...UNDECIDED,
  ...fields,
});

/** A brief payload that decodes as the protocol's `Brief`, with `budget`. */
const briefPayload = (budget: Budget): ApprovalPayloadState => ({
  type: "brief",
  title: "Count the files in the repo",
  task: "Count them.",
  why: "To know.",
  avoid: [],
  doneWhen: [{ text: "A number", judge: { kind: "user" } }],
  workspace: "shared",
  base: null,
  writes: [],
  model: null,
  thinking: null,
  mode: "approval-required",
  mayCommit: false,
  budget: budgetJson(budget),
  resultSchema: null,
  wake: "answer",
  decisions: [],
});

/** A Harness over fresh memory storage, and the storage, for one test. */
const openHarness = Effect.gen(function* () {
  const storage = new MemoryStorage();

  const harness = yield* Effect.acquireRelease(
    Effect.promise(
      async () =>
        await Harness.open(
          storage,
          { models: createModels(), registry: createRegistry() },
          context
        )
    ),
    (open) =>
      Effect.promise(async () => {
        await open.close(context);
      })
  );

  return { harness, storage };
});

/** A thread's conversation with its receipt and metadata. */
const createThread = async (harness: Harness, threadId: ThreadId) => {
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" } },
    context
  );

  await harness.commit(async (tx) => {
    const receipt = await tx.doc(ThreadReceipt, threadId, {
      conversationId: 0,
    });

    receipt.conversationId = conversation.id;

    const meta = await tx.doc(ThreadMeta, conversation.id);

    meta.threadId = threadId;
    meta.projectId = "budget-test";
  }, context);

  return conversation.id;
};

/** A parent thread whose brief record names `budget`, and a child linked to it. */
const family = (harness: Harness, budget: Budget) =>
  Effect.promise(async () => {
    const parent = await createThread(harness, PARENT);
    const child = await createThread(harness, CHILD);

    await harness.commit(async (tx) => {
      const { items } = await tx.doc(Approvals, parent);

      items[BRIEF_ID] = record(BRIEF_ID, {
        tool: "subagent_spawn",
        kind: "brief",
        status: "accepted",
        payload: briefPayload(budget),
      });

      const link = await tx.doc(ChildDoc, child);

      link.key = BRIEF_ID;
      link.parentThreadId = PARENT;
      link.parentConversationId = parent;
      link.rootThreadId = PARENT;
      link.briefApprovalId = BRIEF_ID;
    }, context);

    return { parent, child };
  });

/** The kinds of the events in the log, oldest first. */
const eventsOf = (harness: Harness) =>
  Effect.promise(async () => {
    const state = await harness.snapshot(EventsDoc, context);

    if (state === undefined || state.logConversationId === null) {
      return [];
    }

    const log = piConversationId(
      StoredConversationId.make(state.logConversationId)
    );

    return await harness.commit(async (tx) => {
      const page = await tx.scanEntries(
        { conversationId: log, order: "ascending" },
        500
      );

      return page.items.map((entry) => entry.kind);
    }, context);
  });

const sourcesOver = (harness: Harness, storage: MemoryStorage) =>
  BudgetSources.layer.pipe(
    Layer.provide(
      Layer.mock(Brain)({
        session: Effect.succeed<BrainSession>({
          harness,
          storage,
          generation: 1,
        }),
        now: () => 100,
      })
    )
  );

/** Accepts a raise to `to` on `conversation`, as the user's answer would. */
const acceptRaise = (
  harness: Harness,
  conversation: ConversationId,
  epoch: number,
  to: Budget
) =>
  Effect.promise(async () => {
    await harness.commit(async (tx) => {
      const { items } = await tx.doc(Approvals, conversation);

      items[raiseIdOf(epoch)] = {
        ...record(raiseIdOf(epoch), {
          tool: RAISE_TOOL,
          kind: "tool-call",
          status: "accepted",
          payload: {
            type: "budget-raise",
            scope: CHILD,
            from: budgetJson(BRIEF_BUDGET),
            to: budgetJson(to),
          },
        }),
        askedAt: 10 + epoch,
      };
    }, context);
  });

describe("budget sources over a Harness", () => {
  it.live(
    "a subagent's scope is its brief's budget in stop mode, raised by each accepted raise",
    () =>
      Effect.gen(function* () {
        const { harness, storage } = yield* openHarness;
        const { child } = yield* family(harness, BRIEF_BUDGET);

        yield* Effect.gen(function* () {
          const sources = yield* BudgetSources;

          assert.deepStrictEqual(
            yield* sources.scopeOf(CHILD),
            Option.some({
              threadId: CHILD,
              budget: BRIEF_BUDGET,
              mode: "stop" as const,
              epoch: 0,
            })
          );
          assert.isTrue(Option.isNone(yield* sources.scopeOf(PARENT)));

          const raised: Budget = {
            ...BRIEF_BUDGET,
            maxListMicros: Micros.make(1_000_000),
          };

          yield* acceptRaise(harness, child, 0, raised);

          // A workflow's raise in the same records raises that run only, never the thread (5B).
          yield* Effect.promise(async () => {
            await harness.commit(async (tx) => {
              const { items } = await tx.doc(Approvals, child);

              items["budget-raise-wf-7-0"] = {
                ...record("budget-raise-wf-7-0", {
                  tool: RAISE_TOOL,
                  kind: "tool-call",
                  status: "accepted",
                  payload: {
                    type: "budget-raise",
                    scope: "wf-7",
                    from: budgetJson(BRIEF_BUDGET),
                    to: budgetJson({ ...BRIEF_BUDGET, maxTokens: 10 ** 9 }),
                  },
                }),
                askedAt: 20,
              };
            }, context);
          });

          const scopes = yield* sources.scopes;

          assert.deepStrictEqual(scopes, [
            { threadId: CHILD, budget: raised, mode: "stop", epoch: 1 },
          ]);

          yield* sources.declare(
            PARENT,
            { ...DEFAULT_BUDGET, maxTokens: 9000 },
            "drain"
          );

          const declared = yield* sources.scopeOf(PARENT);

          assert.deepStrictEqual(
            Option.map(declared, (scope) => scope.mode),
            Option.some("drain")
          );
          assert.deepStrictEqual(
            Option.map(declared, (scope) => scope.budget.maxTokens),
            Option.some(9000)
          );
        }).pipe(Effect.provide(sourcesOver(harness, storage)));
      }).pipe(Effect.scoped)
  );

  it.live(
    "a subagent's scope is the budget the user set on its brief card with Go, not the one it asked",
    () =>
      Effect.gen(function* () {
        const { harness, storage } = yield* openHarness;
        const { parent } = yield* family(harness, BRIEF_BUDGET);

        const edited: Budget = { ...DEFAULT_BUDGET, maxTokens: 40_000 };

        yield* Effect.promise(async () => {
          await harness.commit(async (tx) => {
            const { items } = await tx.doc(Approvals, parent);
            const brief = items[BRIEF_ID];

            if (brief !== undefined) {
              brief.answer = {
                decision: "accept",
                answers: null,
                note: null,
                launch: { budget: budgetJson(edited) },
              };
            }
          }, context);
        });

        yield* Effect.gen(function* () {
          const sources = yield* BudgetSources;

          assert.deepStrictEqual(
            yield* sources.scopeOf(CHILD),
            Option.some({
              threadId: CHILD,
              budget: edited,
              mode: "stop" as const,
              epoch: 0,
            })
          );
        }).pipe(Effect.provide(sourcesOver(harness, storage)));
      }).pipe(Effect.scoped)
  );

  it.live(
    "a declared budget replaces the raises accepted before it, declines one pending, and starts an epoch",
    () =>
      Effect.gen(function* () {
        const { harness, storage } = yield* openHarness;
        const { child } = yield* family(harness, BRIEF_BUDGET);

        const raised: Budget = {
          ...BRIEF_BUDGET,
          maxListMicros: Micros.make(1_000_000),
        };

        yield* acceptRaise(harness, child, 0, raised);

        // The next epoch's raise, still pending when the user sets a new budget.
        yield* Effect.promise(async () => {
          await harness.commit(async (tx) => {
            const { items } = await tx.doc(Approvals, child);

            items[raiseIdOf(1)] = {
              ...record(raiseIdOf(1), {
                tool: RAISE_TOOL,
                kind: "tool-call",
                status: "pending",
                payload: {
                  type: "budget-raise",
                  scope: CHILD,
                  from: budgetJson(raised),
                  to: budgetJson({
                    ...raised,
                    maxListMicros: Micros.make(2_000_000),
                  }),
                },
              }),
              askedAt: 30,
              expiresAt: 10 ** 12,
            };
          }, context);
        });

        const declared: Budget = { ...DEFAULT_BUDGET, maxTokens: 5000 };

        yield* Effect.gen(function* () {
          const sources = yield* BudgetSources;

          yield* sources.declare(CHILD, declared, "stop");

          assert.deepStrictEqual(
            yield* sources.scopeOf(CHILD),
            Option.some({
              threadId: CHILD,
              budget: declared,
              mode: "stop" as const,
              epoch: 2,
            })
          );
        }).pipe(Effect.provide(sourcesOver(harness, storage)));

        const state = yield* Effect.promise(
          async () => await harness.snapshot(Approvals, child, context)
        );

        const stale = state?.items[raiseIdOf(1)];

        assert.strictEqual(stale?.status, "declined");
        assert.deepStrictEqual(stale?.decidedBy, { kind: "user" });
        assert.strictEqual(stale?.reason, RAISE_REPLACED);

        // The user's decline is an answer, so its commit carries the answer's event (ADR 0033).
        assert.deepStrictEqual(
          (yield* eventsOf(harness)).filter(
            (kind) => kind === eventKind("approval.answered")
          ).length,
          1
        );

        // A raise asked after the declare, accepted, raises the declared budget.
        const later: Budget = { ...declared, maxTokens: 10_000 };

        yield* acceptRaise(harness, child, 2, later);

        yield* Effect.gen(function* () {
          const sources = yield* BudgetSources;

          assert.deepStrictEqual(
            Option.map(yield* sources.scopeOf(CHILD), (scope) => [
              scope.budget,
              scope.epoch,
            ]),
            Option.some([later, 3])
          );
        }).pipe(Effect.provide(sourcesOver(harness, storage)));
      }).pipe(Effect.scoped)
  );

  it.live(
    "a declare with no limit on a subagent leaves it no budget of its own, its brief's included",
    () =>
      Effect.gen(function* () {
        const { harness, storage } = yield* openHarness;

        yield* family(harness, BRIEF_BUDGET);

        yield* Effect.gen(function* () {
          const sources = yield* BudgetSources;

          assert.isTrue(Option.isSome(yield* sources.scopeOf(CHILD)));

          yield* sources.declare(CHILD, DEFAULT_BUDGET, "stop");

          assert.deepStrictEqual(yield* sources.scopeOf(CHILD), Option.none());
        }).pipe(Effect.provide(sourcesOver(harness, storage)));
      }).pipe(Effect.scoped)
  );

  it.live("a brief whose budget enforces nothing is no scope", () =>
    Effect.gen(function* () {
      const { harness, storage } = yield* openHarness;

      yield* family(harness, DEFAULT_BUDGET);

      yield* Effect.gen(function* () {
        const sources = yield* BudgetSources;

        assert.isTrue(Option.isNone(yield* sources.scopeOf(CHILD)));
        assert.deepStrictEqual(yield* sources.scopes, []);
      }).pipe(Effect.provide(sourcesOver(harness, storage)));
    }).pipe(Effect.scoped)
  );

  it.live(
    "asks a raise once per epoch and writes a notice once, into the transcript",
    () =>
      Effect.gen(function* () {
        const { harness, storage } = yield* openHarness;
        const { child } = yield* family(harness, BRIEF_BUDGET);

        yield* Effect.gen(function* () {
          const sources = yield* BudgetSources;
          const limit = Option.getOrThrow(yield* sources.scopeOf(CHILD));
          const to = { ...BRIEF_BUDGET, maxListMicros: Micros.make(1_000_000) };

          const facts = {
            title: Option.some("Fan out the review"),
            spent: { tokens: 120_000, listMicros: 510_000 },
          };

          assert.isTrue(yield* sources.askRaise(limit, to, "Raise?", facts));
          assert.isFalse(yield* sources.askRaise(limit, to, "Raise?", facts));

          const data = { reason: "budget_stopped" as const, text: "Stopped." };

          assert.isTrue(yield* sources.notice(CHILD, "budget-stopped-0", data));
          assert.isFalse(
            yield* sources.notice(CHILD, "budget-stopped-0", data)
          );
        }).pipe(Effect.provide(sourcesOver(harness, storage)));

        const state = yield* Effect.promise(
          async () => await harness.snapshot(Approvals, child, context)
        );

        const raise = state?.items[raiseIdOf(0)];

        assert.strictEqual(raise?.status, "pending");
        assert.strictEqual(raise?.tool, RAISE_TOOL);
        assert.strictEqual(raise?.toolTaskId, 0);
        // The card names the scope by its title and reads what it spent (ADR 0047).
        assert.deepInclude(raise?.payload ?? {}, {
          scope: CHILD,
          title: "Fan out the review",
          spent: { tokens: 120_000, listMicros: 510_000 },
        });

        const entries = yield* Effect.promise(async () => {
          const conversation = await harness.conversation(child, context);

          if (conversation === undefined) {
            return [];
          }

          const page = await conversation.entries({}, 50, undefined, context);

          return page.items;
        });

        assert.strictEqual(
          entries.filter((entry) => entry.kind === NOTICE_ENTRY_KIND).length,
          1
        );
      }).pipe(Effect.scoped)
  );
});
