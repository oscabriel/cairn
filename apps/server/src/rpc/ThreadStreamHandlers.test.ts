// The thread stream's RPC handlers and the entry image route over the scripted harness: a fresh
// snapshot first, history paging, full entries, image bytes by reference, and the protocol error
// each seam failure becomes.

import {
  ConversationId,
  EntryId,
  ProjectId,
  RequestId,
  TaskId,
  ThreadId,
} from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Option, Predicate, Stream } from "effect";
import { HttpRouter } from "effect/http";

import { EntryImageRoute } from "../brain/EntryImageRoute.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { FAUX_MODEL } from "../brain/ModelSource.ts";
import { ScriptedHarness } from "../brain/ScriptedHarness.ts";
import {
  ThreadStreamHandlers,
  threadStreamHandlers,
} from "./ThreadStreamHandlers.ts";

const isNotFound = Predicate.isTagged("NotFound");

const THREAD = ThreadId.make("0190f0c0-0000-7000-8000-0000000000a1");

const UNKNOWN = ThreadId.make("0190f0c0-0000-7000-8000-0000000000a2");

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** One thread with a turn that carried an image, answered. */
const seeded = Effect.gen(function* () {
  const seam = yield* HarnessSeam;

  yield* seam.ensureThread({
    threadId: THREAD,
    projectId: ProjectId.make("rpc"),
    model: FAUX_MODEL,
    thinkingLevel: "off",
    cwd: "/tmp",
    instructions: Option.none(),
  });

  const ended = yield* seam.events.pipe(
    Stream.filter(Predicate.isTagged("RunTerminal")),
    Stream.runHead,
    Effect.forkChild
  );

  yield* Effect.sleep("10 millis");
  yield* seam.submit(THREAD, {
    requestId: RequestId.make("r1"),
    content: [
      { type: "text", text: "look" },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ],
    entry: Option.none(),
    whenBusy: "followUp",
  });
  yield* Fiber.join(ended);
});

describe("thread stream handlers", () => {
  it.live("serve a snapshot, history and full entries, and map failures", () =>
    Effect.gen(function* () {
      yield* seeded;

      const handlers = yield* threadStreamHandlers;

      const [first] = yield* handlers
        .subscribe({ threadId: THREAD, conversationId: Option.none() })
        .pipe(Stream.take(1), Stream.runCollect);

      assert.strictEqual(first?._tag, "Snapshot");

      const entries = first?._tag === "Snapshot" ? first.view.entries : [];
      const user = entries.find((entry) => entry.kind === "pi.user");
      const last = entries.at(-1);

      assert.isDefined(user);
      assert.notInclude(JSON.stringify(entries), PNG_BASE64.slice(0, 20));

      const page = yield* handlers.history({
        threadId: THREAD,
        conversationId: Option.none(),
        before: last?.id ?? EntryId.make(1),
        limit: 10,
      });

      assert.deepStrictEqual(
        page.entries.map((entry) => entry.id),
        entries.slice(0, -1).map((entry) => entry.id)
      );
      assert.isFalse(page.hasMore);

      const full = yield* handlers.entry({
        threadId: THREAD,
        entryId: user?.id ?? EntryId.make(1),
      });

      assert.isFalse(full.truncated);
      assert.strictEqual(full.entry.kind, "pi.user");

      const unknown = yield* handlers
        .subscribe({ threadId: UNKNOWN, conversationId: Option.none() })
        .pipe(Stream.runCollect, Effect.flip);

      assert.strictEqual(unknown._tag, "NotFound");
      assert.strictEqual(isNotFound(unknown) ? unknown.resource : "", "thread");

      const subagent = yield* handlers
        .history({
          threadId: THREAD,
          conversationId: Option.some(ConversationId.make(99)),
          before: EntryId.make(5),
          limit: 5,
        })
        .pipe(Effect.flip);

      assert.strictEqual(subagent._tag, "NotFound");

      const missingEntry = yield* handlers
        .entry({ threadId: THREAD, entryId: EntryId.make(9999) })
        .pipe(Effect.flip);

      assert.strictEqual(
        isNotFound(missingEntry) ? missingEntry.resource : "",
        "entry"
      );

      const missingTask = yield* handlers
        .retryTask({ threadId: THREAD, taskId: TaskId.make(77) })
        .pipe(Effect.flip);

      assert.strictEqual(
        isNotFound(missingTask) ? missingTask.resource : "",
        "task"
      );

      // The handler group builds over the seam.
      const built = yield* Layer.build(ThreadStreamHandlers.layer).pipe(
        Effect.exit
      );

      assert.isTrue(Exit.isSuccess(built));
    }).pipe(Effect.scoped, Effect.provide(ScriptedHarness.layer))
  );

  it.live("the entry image route returns the bytes an entry holds", () =>
    Effect.gen(function* () {
      yield* seeded;

      const seam = yield* HarnessSeam;

      const [first] = yield* seam
        .watch(THREAD)
        .pipe(Stream.take(1), Stream.runCollect);

      const user =
        first?._tag === "Snapshot"
          ? first.view.entries.find((entry) => entry.kind === "pi.user")
          : undefined;

      const { handler, dispose } = HttpRouter.toWebHandler(
        EntryImageRoute.pipe(Layer.provide(Layer.succeed(HarnessSeam, seam))),
        { disableLogger: true }
      );

      const get = (address: string) =>
        Effect.promise(async () => {
          const response = await handler(
            new Request(`http://cairn.test${address}`)
          );

          const body = await response.arrayBuffer();

          return {
            status: response.status,
            type: response.headers.get("content-type"),
            cache: response.headers.get("cache-control"),
            bytes: body.byteLength,
          };
        });

      const image = yield* get(
        `/api/threads/${THREAD}/entries/${user?.id ?? 0}/images/0`
      );

      assert.deepStrictEqual(image, {
        status: 200,
        type: "image/png",
        cache: "private, max-age=31536000, immutable",
        bytes: Buffer.from(PNG_BASE64, "base64").byteLength,
      });

      const missing = yield* get(
        `/api/threads/${THREAD}/entries/${user?.id ?? 0}/images/3`
      );

      assert.strictEqual(missing.status, 404);

      const malformed = yield* get(
        `/api/threads/${THREAD}/entries/abc/images/0`
      );

      assert.strictEqual(malformed.status, 400);

      yield* Effect.promise(async () => {
        await dispose();
      });
    }).pipe(Effect.provide(ScriptedHarness.layer))
  );
});
