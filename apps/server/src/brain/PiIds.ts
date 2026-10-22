// Ids between Cairn's protocol and pi-durable. Both sides brand the same positive integers that
// pi-durable mints: the protocol with Effect brands, pi-durable with its own erased nominal type.
// A protocol id reached the brain decoded (a positive integer), and pi-durable's brand carries no
// runtime check, so moving one across is a relabelling, done here and nowhere else.
//
// Every assertion below has the same justification:
// SAFETY: the argument is a protocol id, decoded as a positive integer; the result is the same
// number under pi-durable's brand, which has no runtime part.
// Verified by: Conformance.test.ts (scenarios submit, withdraw, page and retry by these ids)

import type {
  ConversationId,
  EntryId,
  SubmissionId,
  TaskId,
} from "@cairn/protocol/Ids";
import type {
  ConversationId as PiConversationId,
  EntryId as PiEntryId,
  SubmissionId as PiSubmissionId,
  TaskId as PiTaskId,
} from "@earendil-works/pi-durable";

/** A protocol conversation id as pi-durable types it. */
export const piConversationId = (id: ConversationId) =>
  // SAFETY: see the header.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  Number(id) as PiConversationId;

/** A protocol entry id as pi-durable types it. */
export const piEntryId = (id: EntryId) =>
  // SAFETY: see the header.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  Number(id) as PiEntryId;

/** A protocol submission id as pi-durable types it. */
export const piSubmissionId = (id: SubmissionId) =>
  // SAFETY: see the header.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  Number(id) as PiSubmissionId;

/** A protocol task id as pi-durable types it. */
export const piTaskId = (id: TaskId) =>
  // SAFETY: see the header.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  Number(id) as PiTaskId;
