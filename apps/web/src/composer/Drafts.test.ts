// The saved drafts across builds: a draft this build cannot decode is kept as stored beside the ones
// it can, a save writes it back untouched, a value unreadable as a whole is never written over, and
// the page says once when it holds drafts it cannot show.

import { ThreadId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Option, Predicate, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Url } from "foldkit";

import { Message as RootMessage } from "../Message.ts";
import type { Model as RootModel } from "../Model.ts";
import {
  init as rootInit,
  UNREAD_STORED_NOTICE,
  update as rootUpdate,
} from "../Update.ts";
import {
  DRAFTS_STORAGE_KEY,
  readDrafts,
  saveDrafts,
  shownNotice,
} from "./Drafts.ts";
import { Message } from "./Message.ts";
import { Draft, emptyDraft } from "./Model.ts";

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

const at = (path: string) =>
  Option.getOrThrow(Url.fromString(`https://code.gneiss.run${path}`));

/** The page loaded at `path`, then given `messages`. */
const loadAt = (path: string, messages: ReadonlyArray<RootMessage>) =>
  Array.reduce(
    messages,
    rootInit(
      {
        boot: Option.none(),
        outbox: [],
        outboxRead: Option.none(),
        outboxUnread: false,
      },
      at(path)
    ).model,
    (model, message) => rootUpdate(model, message).model
  );

/** The notice the page shows: the root's, or the composer's on its draft. */
const shown = (model: RootModel) =>
  Option.orElse(model.notice, () => shownNotice(model.composer));

const loadedDrafts = (tell: boolean) =>
  RootMessage.GotComposerMessage({
    message: Message.LoadedDrafts({ drafts: {}, tell, read: Option.none() }),
  });

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

        yield* saveDrafts(read.value, read.read, {
          ...read.value,
          "thread:c": three,
        });

        const after = yield* store.get(DRAFTS_STORAGE_KEY);
        const reread = yield* readDrafts;

        assert.notInclude(older, "envMode");
        assert.deepStrictEqual(
          { value: read.value, tell: read.tell },
          { value: { "thread:a": one }, tell: true }
        );
        assert.deepStrictEqual(storedKeys(after), [
          "thread:a",
          "thread:b",
          "thread:c",
        ]);
        assert.include(after, `"thread:b":${older}`);
        // The next load does not tell again about the draft the last one told about.
        assert.deepStrictEqual(
          { value: reread.value, tell: reread.tell },
          { value: { "thread:a": one, "thread:c": three }, tell: false }
        );
      }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it.effect("never write over drafts unreadable as a whole", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;

      yield* store.set(DRAFTS_STORAGE_KEY, "[1, 2");

      const read = yield* readDrafts;

      const saved = yield* saveDrafts(read.value, read.read, {
        "thread:a": one,
      });

      const reread = yield* readDrafts;

      assert.deepStrictEqual(
        { value: read.value, tell: read.tell },
        { value: {}, tell: true }
      );
      assert.deepStrictEqual(
        Option.map(saved, ({ value }) => value),
        Option.some({ "thread:a": one })
      );
      assert.deepStrictEqual(
        { value: reread.value, tell: reread.tell },
        { value: { "thread:a": one }, tell: false }
      );
      assert.strictEqual(yield* store.get(DRAFTS_STORAGE_KEY), "[1, 2");
    }).pipe(Effect.provide(KeyValueStore.layerMemory))
  );

  it("say so when storage holds drafts this build cannot show", () => {
    const thread = "/t/01890a5d-ac96-774b-bcce-b302099a8057";

    assert.deepStrictEqual(
      shown(loadAt(thread, [loadedDrafts(true)])),
      Option.some(UNREAD_STORED_NOTICE)
    );
    assert.deepStrictEqual(
      shown(loadAt(thread, [loadedDrafts(false)])),
      Option.none()
    );
  });

  it("keep saying so on a load of `/`, where the hero's new draft moves the URL", () => {
    const draftId = ThreadId.make("01890a5d-ac96-774b-bcce-b302099a8057");

    const loaded = loadAt("/", [
      loadedDrafts(true),
      RootMessage.GotComposerMessage({
        message: Message.MintedHomeDraft({ draftId }),
      }),
      RootMessage.ChangedUrl({ url: at(`/new/${draftId}`) }),
    ]);

    assert.isTrue(Predicate.isTagged(loaded.route, "Draft"));
    assert.deepStrictEqual(shown(loaded), Option.some(UNREAD_STORED_NOTICE));
  });
});
