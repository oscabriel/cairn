// Saved attachments and upload retries (T38): an attachment saved longer ago than the brain's sweep
// of unclaimed uploads is not restored, and an upload URL that expired, is unknown or was already
// used is worth a new one, while a refusal of the file itself is final.

import { AttachmentId } from "@cairn/protocol/Ids";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Option, Ref } from "effect";
import { KeyValueStore } from "effect/persistence";
import { TestClock } from "effect/testing";

import { CairnConnection } from "../connection/Connection.ts";
import { Message } from "./Message.ts";
import { initial } from "./Model.ts";
import type { Model } from "./Model.ts";
import {
  loadSaved,
  RESTORE_WINDOW_MS,
  SAVED_ATTACHMENTS_KEY,
  saveSaved,
} from "./Saved.ts";
import { clearSent, readyIds, restore, update } from "./Update.ts";
import { isRetryableAnswer } from "./UploadQueue.ts";

const ref = (id: string) => ({
  id: AttachmentId.make(id),
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 10,
  kind: "image" as const,
  sha256: "a".repeat(64),
});

describe("saved attachments", () => {
  it.effect("are not restored once the brain's sweep has passed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_760_000_000_000);
      yield* saveSaved({}, { "thread:t1": [ref("att_old")] });
      yield* TestClock.adjust(Duration.hours(2));
      yield* saveSaved(
        { "thread:t1": [ref("att_old")] },
        { "thread:t1": [ref("att_old"), ref("att_new")] }
      );

      expect(
        (yield* loadSaved)["thread:t1"]?.map(({ id }) => id)
      ).toStrictEqual(["att_old", "att_new"]);

      yield* TestClock.adjust(Duration.millis(RESTORE_WINDOW_MS - 1000));

      expect(
        (yield* loadSaved)["thread:t1"]?.map(({ id }) => id)
      ).toStrictEqual(["att_new"]);

      // A tab still holding the swept one does not write it back.
      const held = {
        "thread:t1": [ref("att_old"), ref("att_new")],
      };

      const stored = yield* saveSaved(held, held);

      expect(
        Option.map(stored, (saved) => saved["thread:t1"]?.map(({ id }) => id))
      ).toStrictEqual(Option.some(["att_new"]));
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

/** Runs every save the tray issued, as the runtime would, with no connection. */
const runSaves = (result: {
  readonly commands?: ReturnType<typeof restore>["commands"];
}) =>
  Effect.gen(function* () {
    const disconnected = yield* Ref.make(Option.none());

    return yield* Effect.forEach(
      result.commands ?? [],
      (command) => command.effect
    ).pipe(Effect.provideService(CairnConnection._tag, disconnected));
  });

describe("saved attachments in two tabs", () => {
  it.effect("keep each other's attachments", () =>
    Effect.gen(function* () {
      const tabB = { ...initial, loaded: true };
      const tabA = { ...initial, loaded: true };

      yield* runSaves(restore(tabA, "thread:a", [ref("att_a")]));
      yield* runSaves(restore(tabB, "thread:b", [ref("att_b")]));

      const stored = yield* loadSaved;

      expect({
        a: stored["thread:a"]?.map(({ id }) => id),
        b: stored["thread:b"]?.map(({ id }) => id),
      }).toStrictEqual({ a: ["att_a"], b: ["att_b"] });
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "show the attachments another tab saved, and drop the ones it removed",
    () =>
      Effect.gen(function* () {
        /** `tab` told another tab wrote, after its save (which reads storage) answered. */
        const hear = (tab: Model) =>
          Effect.gen(function* () {
            const told = update(tab, Message.ChangedStoredAttachments(), {
              draftKey: Option.none(),
            });

            const [answer] = yield* runSaves(told);

            return answer === undefined
              ? told.model
              : update(told.model, answer, { draftKey: Option.none() }).model;
          });

        const restored = restore({ ...initial, loaded: true }, "thread:a", [
          ref("att_a"),
        ]);

        const [answer] = yield* runSaves(restored);

        const tabA =
          answer === undefined
            ? restored.model
            : update(restored.model, answer, { draftKey: Option.none() }).model;

        const heard = yield* hear({ ...initial, loaded: true });

        yield* runSaves(clearSent(tabA, "thread:a"));

        const heardAgain = yield* hear(heard);

        expect({
          heard: readyIds(heard, "thread:a"),
          heardAgain: readyIds(heardAgain, "thread:a"),
        }).toStrictEqual({ heard: ["att_a"], heardAgain: [] });
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "keep an attachment another tab's write dropped because it read storage before it was saved",
    () =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;

        const restored = restore({ ...initial, loaded: true }, "thread:a", [
          ref("att_a"),
        ]);

        const [answer] = yield* runSaves(restored);

        const tabA =
          answer === undefined
            ? restored.model
            : update(restored.model, answer, { draftKey: Option.none() }).model;

        // Tab B read storage before tab A's write landed, so its own write leaves A's out.
        yield* store.remove(SAVED_ATTACHMENTS_KEY);
        yield* runSaves(
          restore({ ...initial, loaded: true }, "thread:b", [ref("att_b")])
        );

        const told = update(tabA, Message.ChangedStoredAttachments(), {
          draftKey: Option.none(),
        });

        const [heardAnswer] = yield* runSaves(told);

        const heard =
          heardAnswer === undefined
            ? told.model
            : update(told.model, heardAnswer, { draftKey: Option.none() })
                .model;

        const stored = yield* loadSaved;

        expect({
          tray: readyIds(heard, "thread:a"),
          a: stored["thread:a"]?.map(({ id }) => id),
          b: stored["thread:b"]?.map(({ id }) => id),
        }).toStrictEqual({ tray: ["att_a"], a: ["att_a"], b: ["att_b"] });
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

describe("an upload answer", () => {
  it("is worth a new URL when the old one expired, is unknown or was used", () => {
    expect(isRetryableAnswer(400, Option.some("expired"))).toBeTruthy();
    expect(isRetryableAnswer(404, Option.none())).toBeTruthy();
    expect(isRetryableAnswer(409, Option.none())).toBeTruthy();
  });

  it("is final when the file itself was refused", () => {
    expect(isRetryableAnswer(400, Option.some("size_mismatch"))).toBeFalsy();
    expect(isRetryableAnswer(413, Option.some("too_large"))).toBeFalsy();
    expect(isRetryableAnswer(415, Option.some("unsupported_type"))).toBeFalsy();
  });
});
