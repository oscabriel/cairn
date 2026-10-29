// Permission modes that gate (ADR 0031). A thread's mode lives in its conversation's
// `cairn.permissions` document, written when the thread is created and changed only while it is
// idle, so a gated tool reads it at call time with a plain snapshot.
//
// The document itself is defined in CairnDocs.ts beside the other `cairn.*` documents.
//
// A pi-durable hook may only block or rewrite and cannot wait on a person, so the gate lives inside
// the tool. `gatedTool` wraps a tool that changes the world as a `replay: "safe"` tool that:
//
// 1. finds its effect mark (a task memo) and, if an earlier attempt left one, reports "may have
//    run" and never runs the effect again;
// 2. reads the mode and, when the mode asks for this kind of action and "Allow for this thread"
//    has not covered the tool, records an approval and waits for its answer (a kill during the wait
//    reruns the tool, which finds its record and waits again);
// 3. commits the effect mark;
// 4. runs the wrapped tool.
//
// The mark costs one memo commit (0.2 to 0.3 ms in the briefs note's probe 2), and full access
// writes no approval record for these tools. The memo is the task's own, so a rerun of the same tool
// task finds it and another call never does.

import { narrowerMode } from "@cairn/client-logic/EffectiveMode";
import { ConversationId } from "@cairn/protocol/Ids";
import { DEFAULT_RUNTIME_MODE } from "@cairn/protocol/Policy";
import type { RuntimeMode } from "@cairn/protocol/Policy";
import { MAX_SUBAGENT_DEPTH } from "@cairn/protocol/Subagents";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import type {
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { Effect, Option } from "effect";

import { ChildDoc, isLinked } from "../subagents/SubagentDocs.ts";
import { approvalLedger, Permissions, settlementText } from "./CairnDocs.ts";
import type { ApprovalLedgerError } from "./CairnDocs.ts";
import { piConversationId } from "./PiIds.ts";

/**
 * What a tool does, as the modes see it: `read` only reads; `edit` writes files; `command` runs a
 * process; `executor` calls an Executor app through Cairn's approval.
 */
export type GatedAction = "read" | "edit" | "command" | "executor";

/**
 * Whether `mode` asks before `action` (the briefs note's table, section 5). Full access asks for
 * nothing; auto-accept edits lets edits through and asks for commands and Executor calls;
 * Supervised asks for everything but reads. `auto` is not offered yet; a thread stored with it asks
 * as auto-accept edits does, the nearest mode that is enforced.
 */
export const modeAsks = (mode: RuntimeMode, action: GatedAction): boolean => {
  if (action === "read" || mode === "full-access") {
    return false;
  }

  return mode === "approval-required" || action !== "edit";
};

/** A thread's permissions as code reads them. */
export interface ThreadPermissions {
  readonly mode: RuntimeMode;
  readonly allow: ReadonlyArray<string>;
}

/** The permissions a conversation without the document has: the default mode, nothing allowed. */
export const DEFAULT_PERMISSIONS: ThreadPermissions = {
  mode: DEFAULT_RUNTIME_MODE,
  allow: [],
};

/** Whether a call of `tool` asks first: the mode asks for its action and the thread has not allowed it. */
export const callAsks = (
  permissions: ThreadPermissions,
  tool: string,
  action: GatedAction
): boolean =>
  modeAsks(permissions.mode, action) && !permissions.allow.includes(tool);

/** How many ancestors a subagent's mode is narrowed by: the depth cap, with room to spare. */
const ANCESTOR_HOPS = MAX_SUBAGENT_DEPTH + 2;

/**
 * The permissions a tool call runs under, read once at call time: the thread's own allow list, and
 * its mode narrowed by every ancestor's (ADR 0031), found by walking each subagent's `cairn.child`
 * up to the thread the user opened. A parent narrowed after the spawn so narrows its child's next
 * gated call. `from` reads another conversation's (an ancestor's) through the same `api`.
 */
export const readPermissions = async (
  api: Pick<ToolExecutionApi, "snapshot" | "conversationId">,
  context: ChordContext,
  from: ToolExecutionApi["conversationId"] = api.conversationId
): Promise<ThreadPermissions> => {
  const doc = await api.snapshot(Permissions, from, context);

  const own =
    doc === undefined
      ? DEFAULT_PERMISSIONS
      : { mode: doc.mode, allow: [...doc.allow] };

  let { mode } = own;
  let conversationId = from;

  for (let hop = 0; hop < ANCESTOR_HOPS; hop += 1) {
    // Each hop reads the parent the last one named.
    // oxlint-disable-next-line no-await-in-loop
    const link = await api.snapshot(ChildDoc, conversationId, context);

    if (!isLinked(link)) {
      break;
    }

    conversationId = piConversationId(
      ConversationId.make(link.parentConversationId)
    );

    // oxlint-disable-next-line no-await-in-loop
    const parent = await api.snapshot(Permissions, conversationId, context);

    mode = narrowerMode(mode, parent?.mode ?? DEFAULT_RUNTIME_MODE);
  }

  return { mode, allow: own.allow };
};

/**
 * The widest mode a subagent may be set to (ADR 0031): its parent's effective mode. None for a
 * thread the user opened, which any mode fits. `thread.configure` refuses a mode wider than it.
 */
export const parentCeiling = async (
  api: Pick<ToolExecutionApi, "snapshot" | "conversationId">,
  context: ChordContext
): Promise<Option.Option<RuntimeMode>> => {
  const link = await api.snapshot(ChildDoc, api.conversationId, context);

  if (!isLinked(link)) {
    return Option.none();
  }

  const parent = await readPermissions(
    api,
    context,
    piConversationId(ConversationId.make(link.parentConversationId))
  );

  return Option.some(parent.mode);
};

/** The memo a gated tool commits right before its effect. Prefixed: hooks share the task's memos. */
export const EFFECT_MARK = "cairn.effect";

/** What a rerun that found the effect mark tells the model. */
export const MAY_HAVE_RUN =
  "Interrupted after it started, so it may have run. Not retried. Check its result with a read before calling it again.";

/** How long a gated call's approval stays answerable. */
export const GATED_APPROVAL_TTL_MILLIS = 24 * 60 * 60 * 1000;

/** The longest summary a gated call's approval card shows. */
export const GATED_SUMMARY_MAX = 2000;

/** Cuts a summary to fit the card, saying how much was cut. */
export const cutSummary = (text: string): string =>
  text.length > GATED_SUMMARY_MAX
    ? `${text.slice(0, GATED_SUMMARY_MAX)}... (${text.length - GATED_SUMMARY_MAX} more characters)`
    : text;

const errorResult = (text: string): ToolExecutionResult => ({
  output: [{ type: "text", text }],
  isError: true,
});

/**
 * Records this call's approval and waits for it (a rerun finds the record and waits again). Answers
 * the refusal the model reads, or none when the call may run: a settlement other than `accepted`,
 * or a ledger failure, refuses. Never fails.
 */
const approve = (
  api: ToolExecutionApi,
  tool: string,
  summary: string
): Effect.Effect<Option.Option<string>> => {
  const ledger = approvalLedger(api);

  return Effect.gen(function* () {
    yield* ledger.ask({
      tool,
      kind: "tool-call",
      summary: cutSummary(summary),
      ttlMillis: GATED_APPROVAL_TTL_MILLIS,
      payload: Option.none(),
      acceptedBy: Option.none(),
    });

    const settlement = yield* ledger.awaitSettlement;

    return settlement.status === "accepted"
      ? Option.none<string>()
      : Option.some(
          `Not run: the approval for this call was ${settlementText(settlement)}.`
        );
  }).pipe(
    Effect.catchTag("ApprovalLedgerError", (failure: ApprovalLedgerError) =>
      Effect.succeedSome(`${failure.message} Nothing ran.`)
    )
  );
};

/** How a gated tool describes one call on its approval card. */
export type Summarize<A> = (args: A) => string;

/**
 * `tool` as a replay-safe tool gated by the thread's mode, with an effect mark before its effect
 * (module header). The wrapped tool's own `execute` runs at most once per tool task.
 */
export const gatedTool = <T extends ToolRegistration>(
  tool: T,
  action: GatedAction,
  summarize: Summarize<Parameters<T["execute"]>[0]>
): T => ({
  ...tool,
  replay: "safe",
  execute: async (args, api, context) => {
    const mark = await api.memo<string>(EFFECT_MARK, context);

    if (mark !== undefined) {
      return errorResult(MAY_HAVE_RUN);
    }

    const permissions = await readPermissions(api, context);

    if (callAsks(permissions, tool.name, action)) {
      const refusal = await Effect.runPromise(
        approve(api, tool.name, summarize(args)),
        { signal: context.abortSignal }
      );

      if (Option.isSome(refusal)) {
        return errorResult(refusal.value);
      }
    }

    await api.memo(EFFECT_MARK, "started", context);

    return await tool.execute(args, api, context);
  },
});
