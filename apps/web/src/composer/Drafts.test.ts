// The saved drafts across builds: a draft this build cannot decode is kept as stored beside the ones
// it can, a save writes it back untouched, a value unreadable as a whole is never written over, and
// the page says when it holds drafts it cannot show.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";

import {
  DRAFTS_STORAGE_KEY,
  loadDrafts,
  readDrafts,
  saveDrafts,
  shownNotice,
} from "./Drafts.ts";
import { Message } from "./Message.ts";
import { Draft, emptyDraft, initial } from "./Model.ts";
import { UNREAD_DRAFTS_NOTICE, update } from "./Update.ts";

const one = { ...emptyDraft, text: "first thought" };

const two = { ...emptyDraft, text: "second thought" };

const three = { ...emptyDraft, text: "typed after the deploy" };

const draftJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(Draft))
);

/** The keys of the stored drafts object, whatever its drafts hold. */
const storedKeys = (text: string | undefined) =>
  Object.keys(
    Schema.decodeSync(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
    )(text ?? "{}")
  ).toSorted();

/** The composer's notice once the drafts load, with or without drafts this build cannot read. */
const noticeOnLoad = (unread: boolean) =>
  shownNotice(
    update(initial, Message.LoadedDrafts({ drafts: {}, unread })).model
  );

describe("the saved drafts", () => {
  it.effect(
    "keep a draft this build cannot read, and write it back on the next save",
    () =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;

        // `thread:b` as a build with one field fewer saved it.
        const older = draftJson(two).replace(/,?"envMode":"local"/u, "");

        yield* store.set(
          DRAFTS_STORAGE_KEY,
          `{"thread:a":${draftJson(one)},"thread:b":${older}}`
        );

        const read = yield* readDrafts;

        yield* saveDrafts(read.value, { ...read.value, "thread:c": three });

        const after = yield* store.get(DRAFTS_STORAGE_KEY);

        assert.notInclude(older, "envMode");
        assert.deepStrictEqual(read, {
          value: { "thread:a": one },
          unread: true,
        });
        assert.deepStrictEqual(storedKeys(after), [
          "thread:a",
          "thread:b",
          "thread:c",
        ]);
        assert.include(after, `"thread:b":${older}`);
        assert.deepStrictEqual(Object.keys(yield* loadDrafts).toSorted(), [
          "thread:a",
          "thread:c",
        ]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("never write over drafts unreadable as a whole", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;

      yield* store.set(DRAFTS_STORAGE_KEY, "[1, 2");

      const read = yield* readDrafts;
      const saved = yield* saveDrafts(read.value, { "thread:a": one });

      assert.deepStrictEqual(read, { value: {}, unread: true });
      assert.deepStrictEqual(saved, Option.some({ "thread:a": one }));
      assert.deepStrictEqual(yield* loadDrafts, { "thread:a": one });
      assert.strictEqual(yield* store.get(DRAFTS_STORAGE_KEY), "[1, 2");
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it("say so when storage holds drafts this build cannot show", () => {
    assert.deepStrictEqual(
      noticeOnLoad(true),
      Option.some(UNREAD_DRAFTS_NOTICE)
    );
    assert.deepStrictEqual(noticeOnLoad(false), Option.none());
  });
});
