// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/models.ts
// (presentThreadShell's unseen completion) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: news
// is read from server fields alone, so every device agrees. Changed: times stay DateTime values.
// The rest of the presentation (`presentThreadShell`) had no reader once the classic views went
// (C-12); the one thread-state function (`ThreadState.ts`) answers those questions.
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

import type { ThreadShell } from "@cairn/protocol/Shell";
import { DateTime, Option } from "effect";

const isAfter = (left: DateTime.Utc, right: DateTime.Utc) =>
  DateTime.isGreaterThan(left, right);

/**
 * True when a run completed after the user's last visit. A thread never visited counts as unseen
 * once any run completed.
 */
export const hasUnseenCompletion = (thread: ThreadShell): boolean =>
  Option.match(thread.latestRunCompletedAt, {
    onNone: () => false,
    onSome: (completedAt) =>
      Option.match(thread.lastVisitedAt, {
        onNone: () => true,
        onSome: (visitedAt) => isAfter(completedAt, visitedAt),
      }),
  });
