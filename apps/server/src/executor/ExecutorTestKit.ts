// Test helpers for the Executor tools: an approval ledger in memory (the `cairn.approvals` record of
// one tool call, without pi-durable) and the link over a fake Executor with a grant in memory.
import type { ApprovalStatus } from "@cairn/protocol/Policy";
import { Duration, Effect, Layer, Option } from "effect";

import type {
  ApprovalLedger,
  ApprovalRecord,
  ApprovalRequest,
} from "../brain/CairnDocs.ts";
import { ServerConfig } from "../Config.ts";
import { ExecutorGrant } from "./ExecutorGrant.ts";
import {
  CONNECT_TIMEOUT,
  ExecutorLink,
  ExecutorLinkOptions,
} from "./ExecutorLink.ts";
import type { FakeExecutorHandle } from "./FakeExecutor.ts";

/** The origin the test link's sign-in redirect is built from. */
export const TEST_ORIGIN = "http://127.0.0.1:9";

/** An approval ledger in memory, and a look at its one record. */
export interface MemoryLedger {
  readonly ledger: ApprovalLedger;
  readonly record: () => Option.Option<ApprovalRecord>;
}

/**
 * A ledger for one call. `prior` is the mark an earlier attempt left (a rerun); `answer` is what
 * the user answers when the record waits (it is not auto-accepted).
 */
export const memoryLedger = (options: {
  readonly prior: Option.Option<"started" | "done">;
  readonly answer: ApprovalStatus;
}): MemoryLedger => {
  let current = Option.none<ApprovalRecord>();

  const update = (apply: (record: ApprovalRecord) => ApprovalRecord) =>
    Effect.sync(() => {
      current = Option.map(current, apply);
    });

  const ask = (request: ApprovalRequest) =>
    Effect.sync(() => {
      if (Option.isNone(current)) {
        current = Option.some({
          id: "call-1",
          toolTaskId: 1,
          tool: request.tool,
          kind: request.kind,
          summary: request.summary,
          status: request.autoAccept ? "accepted" : "pending",
          askedAt: 0,
          expiresAt: request.ttlMillis,
          answeredAt: request.autoAccept ? 0 : null,
          run: Option.getOrNull(options.prior),
          executorRequestId: null,
        });
      }

      return Option.getOrThrow(current);
    });

  const begin = Effect.sync(() => {
    const before = Option.flatMap(current, (record) =>
      Option.fromNullOr(record.run)
    );

    current = Option.map(current, (record) => ({
      ...record,
      run: record.run ?? "started",
    }));

    return before;
  });

  return {
    ledger: {
      approvalId: "call-1",
      ask,
      awaitAnswer: update((record) => ({
        ...record,
        status: options.answer,
      })).pipe(Effect.as(options.answer)),
      begin,
      noteExecutorRequest: (requestId) =>
        update((record) => ({ ...record, executorRequestId: requestId })),
      finish: update((record) => ({ ...record, run: "done" })),
    },
    record: () => current,
  };
};

/** The full-access ledger of a first attempt. */
export const firstAttempt = () =>
  memoryLedger({ prior: Option.none(), answer: "accepted" });

/**
 * The link over `fake`, with a grant it issued (or `grant`) in memory and pings every
 * `pingInterval`.
 */
export const fakeLink = (
  fake: FakeExecutorHandle,
  options: {
    readonly grant?: Option.Option<
      ReturnType<FakeExecutorHandle["issueGrant"]>
    >;
    readonly pingInterval?: Duration.Duration;
    readonly connectTimeout?: Duration.Duration;
    /** Wraps the grant store, to make it fail. */
    readonly grantStore?: (
      memory: Layer.Layer<ExecutorGrant>
    ) => Layer.Layer<ExecutorGrant>;
  } = {}
) =>
  ExecutorLink.layerNoDeps.pipe(
    Layer.provide(
      (options.grantStore ?? ((memory) => memory))(
        ExecutorGrant.layerMemory(
          options.grant ?? Option.some(fake.issueGrant())
        )
      )
    ),
    Layer.provide(ServerConfig.layerWith({ origin: TEST_ORIGIN })),
    Layer.provide(
      Layer.succeed(ExecutorLinkOptions, {
        pingInterval: options.pingInterval ?? Duration.seconds(15),
        connectTimeout: options.connectTimeout ?? CONNECT_TIMEOUT,
      })
    )
  );
