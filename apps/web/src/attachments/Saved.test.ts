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
import { AttachmentStatus, initial } from "./Model.ts";
import type { Model } from "./Model.ts";
import {
  loadSaved,
  RESTORE_WINDOW_MS,
  SAVED_ATTACHMENTS_KEY,
  saveSaved,
} from "./Saved.ts";
import type { SavedAttachments } from "./Saved.ts";
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

/** The saved attachments as a tab reads them. */
const storedSaved = Effect.map(loadSaved, ({ value }) => value);

/** A save of `saved` over `base` by a tab that read storage just now; what storage holds after. */
const save = (base: SavedAttachments, saved: SavedAttachments) =>
  Effect.flatMap(loadSaved, ({ read }) =>
    Effect.map(
      saveSaved(base, read, saved),
      Option.map(({ value }) => value)
    )
  );

describe("saved attachments", () => {
  it.effect(
    "keep one this build cannot read, write it back, and let this build remove it by its id",
    () =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;

        yield* save({}, { "thread:t1": [ref("att_a"), ref("att_b")] });

        // `att_b` as a build with another kind of attachment saved it.
        const text = (yield* store.get(SAVED_ATTACHMENTS_KEY)) ?? "";

        const newer = text.replace(
          /(?<head>"id":"att_b"[^}]*"kind":)"image"/u,
          '$<head>"video"'
        );

        yield* store.set(SAVED_ATTACHMENTS_KEY, newer);

        const read = yield* storedSaved;

        yield* save(read, { ...read, "thread:t2": [ref("att_c")] });

        const kept = yield* store.get(SAVED_ATTACHMENTS_KEY);

        // A removal by id takes it out, though this build cannot decode it.
        yield* save(
          { ...read, "thread:t1": [ref("att_a"), ref("att_b")] },
          read
        );

        const removed = yield* store.get(SAVED_ATTACHMENTS_KEY);

        expect({
          changed: newer !== text,
          read: read["thread:t1"]?.map(({ id }) => id),
          kept: kept?.includes('"kind":"video"'),
          keptC: kept?.includes("att_c"),
          removed: removed?.includes("att_b"),
        }).toStrictEqual({
          changed: true,
          read: ["att_a"],
          kept: true,
          keptC: true,
          removed: false,
        });
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("are not restored once the brain's sweep has passed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_760_000_000_000);
      yield* save({}, { "thread:t1": [ref("att_old")] });
      yield* TestClock.adjust(Duration.hours(2));
      yield* save(
        { "thread:t1": [ref("att_old")] },
        { "thread:t1": [ref("att_old"), ref("att_new")] }
      );

      expect(
        (yield* storedSaved)["thread:t1"]?.map(({ id }) => id)
      ).toStrictEqual(["att_old", "att_new"]);

      yield* TestClock.adjust(Duration.millis(RESTORE_WINDOW_MS - 1000));

      expect(
        (yield* storedSaved)["thread:t1"]?.map(({ id }) => id)
      ).toStrictEqual(["att_new"]);

      // A tab still holding the swept one does not write it back.
      const held = {
        "thread:t1": [ref("att_old"), ref("att_new")],
      };

      const stored = yield* save(held, held);

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

/** The store as it is now, but refusing every write, as a full localStorage does. */
const refusingStore = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;

  return KeyValueStore.make({
    ...store,
    set: (key) =>
      Effect.fail(
        new KeyValueStore.KeyValueStoreError({
          message: "quota exceeded",
          method: "set",
          key,
        })
      ),
  });
});

/** `tab` once `answers` arrived, in order, with `context`'s draft open. */
const answeredIn = (
  tab: Model,
  answers: ReadonlyArray<Message>,
  context: { readonly draftKey: Option.Option<string> }
) => {
  let model = tab;

  for (const answer of answers) {
    ({ model } = update(model, answer, context));
  }

  return model;
};

/** The local id of the ready item holding attachment `id`. */
const localIdOf = (tab: Model, id: string) =>
  tab.items.find(
    ({ status }) =>
      AttachmentStatus.guards.Ready(status) && status.ref.id === id
  )?.localId ?? "";

describe("saved attachments in two tabs", () => {
  it.effect("keep each other's attachments", () =>
    Effect.gen(function* () {
      const tabB = { ...initial, loaded: true };
      const tabA = { ...initial, loaded: true };

      yield* runSaves(restore(tabA, "thread:a", [ref("att_a")]));
      yield* runSaves(restore(tabB, "thread:b", [ref("att_b")]));

      const stored = yield* storedSaved;

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

        const stored = yield* storedSaved;

        expect({
          tray: readyIds(heard, "thread:a"),
          a: stored["thread:a"]?.map(({ id }) => id),
          b: stored["thread:b"]?.map(({ id }) => id),
        }).toStrictEqual({ tray: ["att_a"], a: ["att_a"], b: ["att_b"] });
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );
});

describe("saved attachments in one tab", () => {
  it.effect(
    "stay gone once a send clears the tray before the last attachment's save answers",
    () =>
      Effect.gen(function* () {
        const inA = { draftKey: Option.some("thread:a") };

        /** `tab` once `answers` arrived, in order. */
        const answered = (tab: Model, answers: ReadonlyArray<Message>) => {
          let model = tab;

          for (const answer of answers) {
            ({ model } = update(model, answer, inA));
          }

          return model;
        };

        // One attachment ready and saved: the tab and storage agree.
        const first = restore({ ...initial, loaded: true }, "thread:a", [
          ref("att_a"),
        ]);

        const saved = answered(first.model, yield* runSaves(first));

        // A second one is ready, and its save is on its way when the send clears the tray (the
        // upload that releases a waiting send does both in one update).
        const second = restore(saved, "thread:a", [ref("att_b")]);
        const sent = clearSent(second.model, "thread:a");

        const secondAnswers = yield* runSaves(second);
        const sentAnswers = yield* runSaves(sent);

        const tab = answered(sent.model, [...secondAnswers, ...sentAnswers]);
        const stored = yield* storedSaved;

        expect({
          tray: readyIds(tab, "thread:a"),
          stored: stored["thread:a"]?.map(({ id }) => id) ?? [],
        }).toStrictEqual({ tray: [], stored: [] });
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  /** The tray without its one attachment: sent, or removed with its x. */
  const leaves = {
    sent: (tab: Model) => clearSent(tab, "thread:a"),
    removed: (tab: Model) =>
      update(
        tab,
        Message.ClickedRemove({ localId: tab.items[0]?.localId ?? "" }),
        { draftKey: Option.some("thread:a") }
      ),
  };

  it.effect.each(["sent", "removed"] as const)(
    "stay gone once storage refused the save that took one out (%s)",
    (how) =>
      Effect.gen(function* () {
        const inA = { draftKey: Option.some("thread:a") };
        const store = yield* KeyValueStore.KeyValueStore;

        /** Storage that refuses every write, as a full localStorage does. */
        const full = KeyValueStore.make({
          ...store,
          set: (key) =>
            Effect.fail(
              new KeyValueStore.KeyValueStoreError({
                message: "quota exceeded",
                method: "set",
                key,
              })
            ),
        });

        /** `tab` once `answers` arrived, in order. */
        const answered = (tab: Model, answers: ReadonlyArray<Message>) => {
          let model = tab;

          for (const answer of answers) {
            ({ model } = update(model, answer, inA));
          }

          return model;
        };

        // One attachment ready and saved: the tab and storage agree.
        const first = restore({ ...initial, loaded: true }, "thread:a", [
          ref("att_a"),
        ]);

        const saved = answered(first.model, yield* runSaves(first));

        // The save that takes it out is refused.
        const left = leaves[how](saved);

        const refused = answered(
          left.model,
          yield* runSaves(left).pipe(
            Effect.provideService(KeyValueStore.KeyValueStore, full)
          )
        );

        // Any later save, here one asked because another tab wrote, writes the removal again.
        const told = update(refused, Message.ChangedStoredAttachments(), inA);
        const tab = answered(told.model, yield* runSaves(told));
        const stored = yield* storedSaved;

        expect({
          tray: readyIds(tab, "thread:a"),
          stored: stored["thread:a"]?.map(({ id }) => id) ?? [],
        }).toStrictEqual({ tray: [], stored: [] });
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect.each(["sent", "removed"] as const)(
    "stay gone when a later save, asked before the refusal answered, is written (%s)",
    (how) =>
      Effect.gen(function* () {
        const inA = { draftKey: Option.some("thread:a") };
        const store = yield* KeyValueStore.KeyValueStore;

        /** Storage that refuses every write, as a full localStorage does. */
        const full = KeyValueStore.make({
          ...store,
          set: (key) =>
            Effect.fail(
              new KeyValueStore.KeyValueStoreError({
                message: "quota exceeded",
                method: "set",
                key,
              })
            ),
        });

        /** `tab` once `answers` arrived, in order. */
        const answered = (tab: Model, answers: ReadonlyArray<Message>) => {
          let model = tab;

          for (const answer of answers) {
            ({ model } = update(model, answer, inA));
          }

          return model;
        };

        // One attachment ready and saved: the tab and storage agree.
        const first = restore({ ...initial, loaded: true }, "thread:a", [
          ref("att_a"),
        ]);

        const saved = answered(first.model, yield* runSaves(first));

        // S1 takes it out and is refused; S2, asked before S1 answers, adds another and is written,
        // so storage holds both.
        const left = leaves[how](saved);
        const added = restore(left.model, "thread:a", [ref("att_b")]);

        const refusedAnswers = yield* runSaves(left).pipe(
          Effect.provideService(KeyValueStore.KeyValueStore, full)
        );

        const addedAnswers = yield* runSaves(added);

        const tab = answered(added.model, [...refusedAnswers, ...addedAnswers]);

        // Any later save writes the removal again.
        const told = update(tab, Message.ChangedStoredAttachments(), inA);
        const later = answered(told.model, yield* runSaves(told));
        const stored = yield* storedSaved;

        expect({
          tray: readyIds(tab, "thread:a"),
          later: readyIds(later, "thread:a"),
          stored: stored["thread:a"]?.map(({ id }) => id) ?? [],
        }).toStrictEqual({
          tray: ["att_b"],
          later: ["att_b"],
          stored: ["att_b"],
        });
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect.each(["after", "before"] as const)(
    "come back when a turn whose refused send took them out is put back, %s the refusal answered",
    (when) =>
      Effect.gen(function* () {
        const inA = { draftKey: Option.some("thread:a") };
        const store = yield* KeyValueStore.KeyValueStore;

        /** Storage that refuses every write, as a full localStorage does. */
        const full = KeyValueStore.make({
          ...store,
          set: (key) =>
            Effect.fail(
              new KeyValueStore.KeyValueStoreError({
                message: "quota exceeded",
                method: "set",
                key,
              })
            ),
        });

        /** `tab` once `answers` arrived, in order. */
        const answered = (tab: Model, answers: ReadonlyArray<Message>) => {
          let model = tab;

          for (const answer of answers) {
            ({ model } = update(model, answer, inA));
          }

          return model;
        };

        // One attachment ready and saved: the tab and storage agree.
        const first = restore({ ...initial, loaded: true }, "thread:a", [
          ref("att_a"),
        ]);

        const saved = answered(first.model, yield* runSaves(first));

        // The send clears the tray and its save is refused; the turn does not reach the brain, so
        // the composer puts its attachment back into the same draft. That save changes nothing.
        const sent = clearSent(saved, "thread:a");

        const sentAnswers = yield* runSaves(sent).pipe(
          Effect.provideService(KeyValueStore.KeyValueStore, full)
        );

        const before =
          when === "before" ? sent.model : answered(sent.model, sentAnswers);

        const back = restore(before, "thread:a", [ref("att_a")]);

        const backAnswers = yield* runSaves(back).pipe(
          Effect.provideService(KeyValueStore.KeyValueStore, full)
        );

        const tab = answered(
          back.model,
          when === "before" ? [...sentAnswers, ...backAnswers] : backAnswers
        );

        // A later save keeps it too.
        const told = update(tab, Message.ChangedStoredAttachments(), inA);
        const later = answered(told.model, yield* runSaves(told));
        const stored = yield* storedSaved;

        expect({
          tray: readyIds(tab, "thread:a"),
          later: readyIds(later, "thread:a"),
          stored: stored["thread:a"]?.map(({ id }) => id) ?? [],
        }).toStrictEqual({
          tray: ["att_a"],
          later: ["att_a"],
          stored: ["att_a"],
        });
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "stay gone once removed, when a refused add had a later save on its way that storage took",
    () =>
      Effect.gen(function* () {
        const inA = { draftKey: Option.some("thread:a") };
        const full = yield* refusingStore;

        // One attachment ready and saved: the tab and storage agree.
        const first = restore({ ...initial, loaded: true }, "thread:a", [
          ref("att_a"),
        ]);

        const saved = answeredIn(first.model, yield* runSaves(first), inA);

        // S1 adds `att_b`; before it answers, S2 takes `att_a` out. S1 is refused, S2 is taken
        // and writes `att_b` back, so storage holds `att_b` alone.
        const added = restore(saved, "thread:a", [ref("att_b")]);

        const removedA = update(
          added.model,
          Message.ClickedRemove({ localId: localIdOf(added.model, "att_a") }),
          inA
        );

        const addedAnswers = yield* runSaves(added).pipe(
          Effect.provideService(KeyValueStore.KeyValueStore, full)
        );

        const removedAnswers = yield* runSaves(removedA);

        const tab = answeredIn(
          removedA.model,
          [...addedAnswers, ...removedAnswers],
          inA
        );

        // Removing `att_b` takes it out of storage too, and its answer does not bring it back.
        const removedB = update(
          tab,
          Message.ClickedRemove({ localId: localIdOf(tab, "att_b") }),
          inA
        );

        const later = answeredIn(
          removedB.model,
          yield* runSaves(removedB),
          inA
        );

        const stored = yield* storedSaved;

        expect({
          tray: readyIds(tab, "thread:a"),
          later: readyIds(later, "thread:a"),
          stored: stored["thread:a"]?.map(({ id }) => id) ?? [],
        }).toStrictEqual({ tray: ["att_b"], later: [], stored: [] });
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect(
    "stay gone once a turn whose send and put-back saves were both refused is sent again",
    () =>
      Effect.gen(function* () {
        const inA = { draftKey: Option.some("thread:a") };
        const full = yield* refusingStore;

        // One attachment ready and saved: the tab and storage agree.
        const first = restore({ ...initial, loaded: true }, "thread:a", [
          ref("att_a"),
        ]);

        const saved = answeredIn(first.model, yield* runSaves(first), inA);

        // The send's save S1 is refused; the turn is put back before S1 answers, and its save S2
        // is refused too.
        const sent = clearSent(saved, "thread:a");
        const back = restore(sent.model, "thread:a", [ref("att_a")]);

        const sentAnswers = yield* runSaves(sent).pipe(
          Effect.provideService(KeyValueStore.KeyValueStore, full)
        );

        const backAnswers = yield* runSaves(back).pipe(
          Effect.provideService(KeyValueStore.KeyValueStore, full)
        );

        const tab = answeredIn(
          back.model,
          [...sentAnswers, ...backAnswers],
          inA
        );

        // Storage takes writes again, and the brain takes the turn sent again: its save takes the
        // attachment out, so a reload does not restore it.
        const sentAgain = clearSent(tab, "thread:a");

        const later = answeredIn(
          sentAgain.model,
          yield* runSaves(sentAgain),
          inA
        );

        const stored = yield* storedSaved;

        expect({
          tray: readyIds(tab, "thread:a"),
          later: readyIds(later, "thread:a"),
          stored: stored["thread:a"]?.map(({ id }) => id) ?? [],
        }).toStrictEqual({ tray: ["att_a"], later: [], stored: [] });
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
