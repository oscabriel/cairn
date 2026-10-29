// Decision records for the approval push tests and `judges/push.ts --fake`: a pending record of each
// kind the card answers, as `cairn.approvals` holds them, with the fields a test cares about named.

import { ApprovalId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { ApprovalRecord, Question } from "@cairn/protocol/Policy";
import { Option, Result } from "effect";

import { briefOf } from "../subagents/Briefs.ts";

/** A pending tool-call record routed to the user, asked at `askedAt`; `fields` override the rest. */
export const pendingRecord = (
  id: string,
  askedAt: number,
  fields: Partial<ApprovalRecord> = {}
): ApprovalRecord => ({
  id: ApprovalId.make(id),
  toolTaskId: 1,
  tool: "bash",
  kind: "tool-call",
  summary: "bash: pnpm test",
  status: "pending",
  askedAt,
  expiresAt: askedAt + 7 * 24 * 3_600_000,
  answeredAt: null,
  run: null,
  executorRequestId: null,
  payload: null,
  answer: null,
  decidedBy: null,
  reason: null,
  route: "user",
  escalatedAt: null,
  supersedes: null,
  started: null,
  briefHash: null,
  mirrorOf: null,
  ...fields,
});

/** A pending brief titled `title`, as `subagent_spawn` proposes one. */
export const pendingBrief = (
  id: string,
  askedAt: number,
  title: string
): ApprovalRecord =>
  pendingRecord(id, askedAt, {
    tool: "subagent_spawn",
    kind: "brief",
    summary: title,
    payload: Result.getOrThrow(
      briefOf(
        {
          description: title,
          brief: `Do this: ${title}.`,
          why: Option.none(),
          isolation: Option.none(),
          resultSchema: Option.none(),
          wake: Option.none(),
          role: Option.none(),
        },
        "full-access"
      )
    ),
  });

/** One single-select question with two options. */
export const question = (header: string, text: string): Question => ({
  header,
  question: text,
  options: [
    { label: "Yes", description: null, recommended: true },
    { label: "No", description: null, recommended: false },
  ],
  multiSelect: false,
  allowCustomAnswer: true,
});

/** A pending `ask_user` question record, routed to `route`. */
export const pendingQuestion = (
  id: string,
  askedAt: number,
  asked: Question,
  fields: Partial<ApprovalRecord> = {}
): ApprovalRecord =>
  pendingRecord(id, askedAt, {
    tool: "ask_user",
    kind: "user-input",
    summary: asked.question,
    payload: { type: "questions", questions: [asked] },
    ...fields,
  });

/** A child's escalated question: its own record and its mirror in the parent. */
export interface EscalatedQuestion {
  readonly child: ApprovalRecord;
  readonly mirror: ApprovalRecord;
}

/**
 * A child's question escalated to the user at `at`: the child's own record (route turned to the
 * user, `escalatedAt` set) and its mirror in the parent, as both harnesses write them.
 */
export const escalatedQuestion = (
  id: string,
  askedAt: number,
  at: number,
  asked: Question,
  child: ThreadId
): EscalatedQuestion => {
  const own = pendingQuestion(id, askedAt, asked, { escalatedAt: at });

  return {
    child: own,
    mirror: {
      ...own,
      id: ApprovalId.make(`esc-${id}`),
      toolTaskId: 0,
      askedAt: at,
      escalatedAt: null,
      mirrorOf: { threadId: child, approvalId: own.id },
    },
  };
};
