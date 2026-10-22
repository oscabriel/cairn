/* oxlint-disable typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/strict-boolean-expressions, anti-slop/no-runtime-typeof, unicorn/require-post-message-target-origin -- a plain service worker script: the project has no WebWorker lib types for `self` or push events, so the payload is checked with typeof, and a Client's postMessage takes no target origin */
// Ported from cairn-v1, apps/web/public/sw.js at 1a5cd4a (itself extended from spike 5's worker,
// which iOS accepted from the installed PWA). Changed: the badge count is the push's `badge` field
// (threads with a result not yet seen) instead of v1's pending approvals, and the icon lives under
// `/icons/`.
//
// Cairn's service worker handles push and notificationclick only. It has no fetch handler, so every
// load goes to the network and a deploy can never leave a stale shell behind (ADR 0021). Every push
// is shown (iOS drops a subscription that receives pushes it does not show), collapsed by its tag.

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** Only a same-origin path may come back from a push: anything else opens the thread list. */
const pathOf = (value) => {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return "/";
  }

  try {
    const url = new URL(value, self.location.origin);

    return url.origin === self.location.origin
      ? url.pathname + url.search + url.hash
      : "/";
  } catch {
    return "/";
  }
};

const readPush = (event) => {
  try {
    const data = event.data ? event.data.json() : {};

    return typeof data === "object" && data !== null ? data : {};
  } catch {
    return { body: event.data ? event.data.text() : "" };
  }
};

/** The app icon's badge. A badge failure must never stop the notification. */
const showBadge = async (count) => {
  if (typeof count !== "number" || !("setAppBadge" in self.navigator)) {
    return;
  }

  try {
    await (count > 0
      ? self.navigator.setAppBadge(count)
      : self.navigator.clearAppBadge());
  } catch {
    // The badge is best effort.
  }
};

self.addEventListener("push", (event) => {
  const data = readPush(event);

  const title =
    typeof data.title === "string" && data.title !== "" ? data.title : "Cairn";

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body: typeof data.body === "string" ? data.body : "",
        tag: typeof data.tag === "string" ? data.tag : undefined,
        icon: "/icons/icon-192.png",
        data: { url: pathOf(data.url) },
      }),
      showBadge(data.badge),
    ])
  );
});

// A tap focuses an open window and asks the page to route there, so its socket and outbox survive.
// With no window open, it opens one at the path.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const path = pathOf(event.notification.data && event.notification.data.url);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      const open = windows.find(
        (client) => new URL(client.url).origin === self.location.origin
      );

      if (open) {
        await open.focus();
        open.postMessage({ type: "open", url: path });
      } else {
        await self.clients.openWindow(path);
      }
    })()
  );
});
