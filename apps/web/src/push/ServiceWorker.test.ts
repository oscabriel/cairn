// Runs the service worker's push handler (`public/sw.js`) against a stub `self`, the way the
// browser calls it: what it shows for a request push, that a replacing push alerts again, and
// that the badge follows the push.

import { runInNewContext } from "node:vm";

import { assert, describe, it } from "@effect/vitest";

import worker from "../../public/sw.js?raw";

/** What the worker passes to `showNotification`. */
interface ShownOptions {
  readonly body: string;
  readonly tag: string | undefined;
  readonly renotify: boolean;
  readonly icon: string;
  readonly data: { readonly url: string };
}

interface Shown {
  readonly title: string;
  readonly options: ShownOptions;
}

/** A push's payload, as the notifier encodes it; fields left out test the worker's defaults. */
interface Payload {
  readonly title?: string;
  readonly body: string;
  readonly tag?: string;
  readonly url: string;
  readonly badge: number;
}

/** The parts of a `PushEvent` the worker reads. */
interface PushEventStub {
  readonly data: { readonly json: () => Payload; readonly text: () => string };
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

/** What every stubbed browser call waits on: nothing. */
const settled = Promise.resolve();

/** Loads the worker into a fresh context and answers its push handler and what it did. */
const load = () => {
  const handlers = new Map<string, (event: PushEventStub) => void>();
  const shown: Array<Shown> = [];
  const badges: Array<number> = [];

  const self = {
    location: { origin: "https://code.gneiss.run" },
    navigator: {
      setAppBadge: async (count: number) => {
        badges.push(count);
        await settled;
      },
      clearAppBadge: async () => {
        badges.push(0);
        await settled;
      },
    },
    registration: {
      showNotification: async (title: string, options: ShownOptions) => {
        shown.push({ title, options });
        await settled;
      },
    },
    clients: {
      claim: async () => {
        await settled;
      },
    },
    skipWaiting: async () => {
      await settled;
    },
    addEventListener: (
      type: string,
      handler: (event: PushEventStub) => void
    ) => {
      handlers.set(type, handler);
    },
  };

  runInNewContext(worker, { self, URL });

  const push = async (payload: Payload) => {
    const waits: Array<Promise<unknown>> = [];

    handlers.get("push")?.({
      data: { json: () => payload, text: () => JSON.stringify(payload) },
      waitUntil: (promise) => {
        waits.push(promise);
      },
    });

    await Promise.all(waits);
  };

  return { push, shown, badges };
};

describe("the service worker's push handler", () => {
  it("shows a request push under its thread's tag, alerting again when it replaces one", async () => {
    const sw = load();

    await sw.push({
      title: "Parser cleanup",
      body: "2 things need you. Go? Fix the parser",
      tag: "ask:thr_1",
      url: "/t/thr_1",
      badge: 3,
    });

    assert.deepStrictEqual(sw.shown, [
      {
        title: "Parser cleanup",
        options: {
          body: "2 things need you. Go? Fix the parser",
          tag: "ask:thr_1",
          renotify: true,
          icon: "/icons/icon-192.png",
          data: { url: "/t/thr_1" },
        },
      },
    ]);
    assert.deepStrictEqual(sw.badges, [3]);
  });

  it("shows a push with no tag without renotify, and an off-site url as the thread list", async () => {
    const sw = load();

    await sw.push({ body: "Hello", url: "https://evil.example/", badge: 0 });

    assert.deepStrictEqual(sw.shown, [
      {
        title: "Cairn",
        options: {
          body: "Hello",
          tag: undefined,
          renotify: false,
          icon: "/icons/icon-192.png",
          data: { url: "/" },
        },
      },
    ]);
    assert.deepStrictEqual(sw.badges, [0]);
  });
});
