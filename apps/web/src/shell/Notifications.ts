// Ported from github.com/pingdotgg/t3code, apps/web/src/threadNotifications.ts (`setNotificationBadge`)
// and the attention rule in apps/web/src/components/ThreadNotificationCoordinator.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the favicon badge (a red disc with the count, "9+"
// above nine) drawn on a canvas, swapped in for the page's icon and put back at zero, and what needs
// the user (a question, an approval, a failure, a usage limit, an unseen completion). Changed: the
// count is every thread that needs the user now, derived from the shell, not a queue of
// notifications raised while the page was hidden; no desktop bridge, notification modes or sounds
// (Web Push on the phone is a separate service).
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
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
} from "@cairn/client-logic/Sidebar";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Option } from "effect";

/** True when a thread needs the user: a question, an approval, a failure or an unseen result. */
export const needsAttention = (thread: ThreadShell): boolean => {
  const status = resolveSidebarThreadStatus(thread);

  return (
    status === "input" ||
    status === "approval" ||
    status === "failed" ||
    status === "limited" ||
    status === "parked" ||
    (status === "ready" && hasUnseenCompletion(thread))
  );
};

/** The favicon badge's count: threads that need the user, the open one excepted. */
export const badgeCount = (
  threads: ReadonlyArray<ThreadShell>,
  openThreadId: Option.Option<string>
): number =>
  threads.filter(
    (thread) =>
      Option.isNone(thread.archivedAt) &&
      !Option.contains(openThreadId, thread.id) &&
      needsAttention(thread)
  ).length;

const BADGE_ATTRIBUTE = "data-cairn-badge";

/** Draws the badge for `count`, or nothing at zero. */
const badgeImage = (count: number): Option.Option<string> => {
  if (count <= 0) {
    return Option.none();
  }

  const canvas = document.createElement("canvas");

  canvas.width = 64;
  canvas.height = 64;

  const context = canvas.getContext("2d");

  if (context === null) {
    return Option.none();
  }

  context.fillStyle = "#e5484d";
  context.beginPath();
  context.arc(32, 32, 28, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "white";
  context.font = `600 ${count > 9 ? 30 : 40}px "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(count > 9 ? "9+" : String(count), 32, 34);

  return Option.some(canvas.toDataURL("image/png"));
};

/**
 * Shows `count` on the favicon. The badge is one extra icon link, last in the head, so the browser
 * prefers it while it exists; at zero it is removed and the page's own icon shows again.
 */
export const applyFaviconBadge = (count: number): void => {
  const existing = Option.fromNullOr(
    document.head.querySelector<HTMLLinkElement>(`link[${BADGE_ATTRIBUTE}]`)
  );

  Option.match(badgeImage(count), {
    onNone: () => {
      Option.map(existing, (link) => {
        link.remove();
      });
    },
    onSome: (image) => {
      const badge = Option.getOrElse(existing, () =>
        document.createElement("link")
      );

      badge.setAttribute(BADGE_ATTRIBUTE, "");
      badge.rel = "icon";
      badge.type = "image/png";
      badge.href = image;
      document.head.append(badge);
    },
  });
};
