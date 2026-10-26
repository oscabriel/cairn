// The thread stream coalesces for a slow client (T49): commits made while the subscriber reads
// nothing reach it as a few frames, not one per revision, and applying them lands on the same view
// a fresh snapshot shows.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyThreadStreamItem } from "@cairn/client-logic/ThreadView";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Result, Stream } from "effect";

import { ExecutorLink } from "../executor/ExecutorLink.ts";
import { BrainConfig } from "./BrainConfig.ts";
import { ExtensionSet } from "./ExtensionSet.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "./ModelSource.ts";
import { PiDurableHarness } from "./PiDurableHarness.ts";

const harness = PiDurableHarness.layer.pipe(
  Layer.provideMerge(
    ExtensionSet.layer.pipe(Layer.provide(ExecutorLink.layerDisabled))
  ),
  Layer.provideMerge(
    ModelSource.layerFaux({ tokensPerSecond: 4000, settings: {} })
  ),
  Layer.provide(
    BrainConfig.layerFrom(mkdtempSync(path.join(tmpdir(), "cairn-watch-")))
  )
);

const THREAD = ThreadId.make("0190f0c0-0000-7000-8000-0000000000c1");

const WRITES = 100;

/** The id of the newest entry a client holds. */
const newest = (current: Option.Option<ThreadViewState>) =>
  Option.match(current, {
    onNone: () => -2,
    onSome: (found) => found.view.entries.at(-1)?.id ?? -2,
  });

describe("the thread stream for a slow client", () => {
  it.live(
    "sends a few coalesced frames for commits it did not read, landing on the same view",
    () =>
      Effect.gen(function* () {
        const seam = yield* HarnessSeam;

        yield* seam.ensureThread({
          threadId: THREAD,
          projectId: ProjectId.make("watch"),
          model: FAUX_MODEL,
          thinkingLevel: "off",
          cwd: tmpdir(),
          instructions: Option.none(),
        });

        const pull = yield* Stream.toPull(seam.watch(THREAD));
        const [snapshot] = yield* pull;
        let state: Option.Option<ThreadViewState> = Option.none();

        state = Option.some(
          Result.getOrThrow(applyThreadStreamItem(state, snapshot))
        );

        // The client reads nothing while these commit.
        for (let n = 0; n < WRITES; n += 1) {
          yield* seam.write(THREAD, {
            requestId: `note-${n}`,
            kind: "cairn.notice",
            data: { reason: "test", text: `note ${n}` },
          });
          // Spaced like a streaming run's commits, so the stream sees each one.
          yield* Effect.sleep("5 millis");
        }

        yield* Effect.sleep("200 millis");

        const [fresh] = yield* seam
          .watch(THREAD)
          .pipe(Stream.take(1), Stream.runCollect);

        // The newest entry: a fresh snapshot is windowed, so lengths differ.
        const wanted =
          fresh?._tag === "Snapshot"
            ? (fresh.view.entries.at(-1)?.id ?? -1)
            : -1;

        let frames = 0;

        while (newest(state) !== wanted && frames < WRITES) {
          for (const item of yield* pull) {
            frames += 1;
            state = Option.some(
              Result.getOrThrow(applyThreadStreamItem(state, item))
            );
          }
        }

        assert.strictEqual(newest(state), wanted);
        // One frame per commit before (100); a few fixed one-frame buffers remain.
        assert.isAtMost(frames, 10, `${frames} frames for ${WRITES} commits`);
      }).pipe(Effect.scoped, Effect.provide(harness))
  );
});
