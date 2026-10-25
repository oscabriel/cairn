// Saved attachments and upload retries (T38): an attachment saved longer ago than the brain's sweep
// of unclaimed uploads is not restored, and an upload URL that expired, is unknown or was already
// used is worth a new one, while a refusal of the file itself is final.
import { AttachmentId } from "@cairn/protocol/Ids";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Option } from "effect";
import { KeyValueStore } from "effect/persistence";
import { TestClock } from "effect/testing";

import { loadSaved, RESTORE_WINDOW_MS, saveSaved } from "./Saved.ts";
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
      yield* saveSaved({ "thread:t1": [ref("att_old")] });
      yield* TestClock.adjust(Duration.hours(2));
      yield* saveSaved({ "thread:t1": [ref("att_old"), ref("att_new")] });

      expect(
        (yield* loadSaved)["thread:t1"]?.map(({ id }) => id)
      ).toStrictEqual(["att_old", "att_new"]);

      yield* TestClock.adjust(Duration.millis(RESTORE_WINDOW_MS - 1000));

      expect(
        (yield* loadSaved)["thread:t1"]?.map(({ id }) => id)
      ).toStrictEqual(["att_new"]);
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
