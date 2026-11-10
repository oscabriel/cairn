// Whether a child has work ahead (`workAhead`), read over a real pi-durable store: another input's
// reporter that will still hand the child a nudge counts, also one crashes cut off many times in a
// row, since crashes never end a reporter (ADR 0046).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  DEFAULT_RESTART_LIMIT,
  Harness,
} from "@earendil-works/pi-durable";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import type { SubagentItemState } from "../brain/SubagentDocs.ts";
import { REPORTER_TASK, workAhead } from "./SubagentTasks.ts";

const context = BACKGROUND_CONTEXT;

const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-work-ahead-"))),
  (dir) =>
    Effect.sync(() => {
      rmSync(dir, { recursive: true, force: true });
    })
);

const open = async (store: string) =>
  await Harness.open(
    await openNodeSqliteStorage(store),
    { models: createModels(), registry: createRegistry() },
    context
  );

/** A registry item whose inputs are `inputs`, each request id to its reporter task. */
const itemWith = (inputs: {
  [requestId: string]: number;
}): SubagentItemState => ({
  threadId: "child-thread",
  conversationId: 0,
  anchorTaskId: 0,
  briefApprovalId: "brief",
  description: "Count the files",
  dispatch: {
    spec: null,
    resolved: {
      spec: "faux/scripted",
      model: { provider: "faux", modelId: "scripted" },
      thinkingLevel: null,
      priced: false,
    },
    previewed: null,
    dispatchedAt: 0,
  },
  isolation: "shared",
  worktree: null,
  status: "working",
  wake: "answer",
  settlements: [],
  runs: [],
  delivered: 0,
  questions: {},
  inputs,
});

/**
 * Whether a child has work ahead of its settled input `mine` when its other input's reporter waits
 * to hand it a nudge, cut off `restarts` times in a row.
 */
const aheadWithNudge = (restarts: number) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const store = path.join(dir, "brain.sqlite");

    const { child, reporter } = yield* Effect.promise(async () => {
      const harness = await open(store);

      const conversation = await harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context
      );

      // Both inputs were admitted: what is left is the reporter's nudge.
      await harness.commit(async (tx) => {
        for (const requestId of ["mine", "other"]) {
          // oxlint-disable-next-line no-await-in-loop -- two writes in one commit
          await tx.createSubmission({
            type: "input",
            status: "unanswered",
            conversationId: conversation.id,
            requestId,
            reason: "answered elsewhere",
          });
        }
      }, context);

      await harness.close(context);

      // The other input's reporter, live in its nudge phase after `restarts` crashes.
      const storage = await openNodeSqliteStorage(store);
      const id = await storage.mintId<TaskId<JsonValue>>();

      await commitWrites(
        storage,
        [
          {
            type: "task",
            value: {
              id,
              conversationId: conversation.id,
              kind: REPORTER_TASK,
              version: 1,
              input: null,
              background: true,
              abortRequested: false,
              restarts,
              state: { status: "pending", checkpoint: { phase: "nudge" } },
            },
          },
        ],
        context
      );

      return { child: conversation.id, reporter: Number(id) };
    });

    return yield* Effect.acquireUseRelease(
      Effect.promise(async () => await open(store)),
      (harness) =>
        Effect.promise(
          async () =>
            await harness.commit(
              async (tx) =>
                await workAhead(
                  tx,
                  child satisfies ConversationId,
                  itemWith({ mine: 1, other: reporter }),
                  "mine"
                ),
              context
            )
        ),
      (harness) =>
        Effect.promise(async () => {
          await harness.close(context);
        })
    );
  }).pipe(Effect.scoped);

describe("a child's work ahead", () => {
  it.live("a reporter that will still nudge the child is work ahead", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* aheadWithNudge(0));
    })
  );

  it.live(
    "a reporter crashes cut off past pi-durable's default limit is still work ahead",
    () =>
      Effect.gen(function* () {
        assert.isTrue(yield* aheadWithNudge(DEFAULT_RESTART_LIMIT + 1));
      })
  );
});
