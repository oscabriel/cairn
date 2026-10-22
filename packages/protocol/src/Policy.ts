// Ported from github.com/pingdotgg/t3code, packages/contracts/src/providerPolicy.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the four runtime modes and their default,
// the approval decisions. Changed: request kinds are Cairn's (Executor calls and tool calls through
// pi-durable), and the Codex sandbox and approval-policy literals are gone.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { Schema } from "effect";

/**
 * A thread's permission mode: which tool calls need an approval. Full access asks for none and is
 * the only mode Cairn offers until approval cards land.
 */
export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);

export type RuntimeMode = typeof RuntimeMode.Type;

/** The permission mode a new thread starts in. */
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

/** An answer to one approval. */
export const ApprovalDecision = Schema.Literals(["accept", "decline"]);

export type ApprovalDecision = typeof ApprovalDecision.Type;

/** What a pending runtime request asks the user for. */
export const RuntimeRequestKind = Schema.Literals([
  "executor-call",
  "tool-call",
  "user-input",
  "sign-in",
]);

export type RuntimeRequestKind = typeof RuntimeRequestKind.Type;

/** Where one approval record stands. Only `pending` holds a tool call. */
export const ApprovalStatus = Schema.Literals([
  "pending",
  "accepted",
  "declined",
  "expired",
  "cancelled",
]);

export type ApprovalStatus = typeof ApprovalStatus.Type;
