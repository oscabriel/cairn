// A run whose end pi-durable committed while the shell row never heard of it (a kill between the
// run's end and the projector's flush): the next boot's reconcile dates the row's end by the run's
// own end, as the projector would have, so the boot after it never reads the turn's end checkpoint
// as missed and adds an empty repair turn (after-review D1). A turn whose end checkpoint never
// landed is still read as missed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";
import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Stream,
} from "effect";

import { eventually, testLimit } from "../EventuallyTestKit.ts";
import { missedRunEnd } from "../git/CheckpointCapture.ts";
import type { CheckpointCommit } from "../git/Checkpoints.ts";
import { EventSink } from "../shell/EventSink.ts";
import { ProjectorSignals } from "../shell/ProjectorSignals.ts";
import { ReconciledEnds } from "../shell/ReconciledEnds.ts";
import { ShellProjector } from "../shell/ShellProjector.ts";
import {
  createProject,
  createThread,
  ShellTestLayer,
  testThreadId,
} from "../shell/ShellTestKit.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { Arms } from "./Arms.ts";
import { Brain } from "./Brain.ts";
import { BrainConfig } from "./BrainConfig.ts";
import { BrainStore } from "./BrainStore.ts";
import { brainExtensions } from "./BrainTestKit.ts";
import { CommitFeed } from "./CommitFeed.ts";
import { FauxModels, FAUX_MODEL } from "./FauxModels.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import type { HarnessEvent } from "./HarnessSeam.ts";
import { PiDurableHarness } from "./PiDurableHarness.ts";

const THREAD = testThreadId(1);

const isRunTerminal = (
  event: HarnessEvent
): event is Extract<HarnessEvent, { readonly _tag: "RunTerminal" }> =>
  Predicate.isTagged(event, "RunTerminal");

/** The production seam and brain over a temporary store, and the shell store beside them. */
const brainLayer = (dataDir: string) =>
  PiDurableHarness.layerNoDeps.pipe(
    Layer.provide(CommitFeed.layerNoDeps),
    Layer.provideMerge(
      Brain.layerNoDeps.pipe(
        Layer.provide(BrainStore.layer),
        Layer.provide(Arms.layer)
      )
    ),
    Layer.provide(brainExtensions()),
    Layer.provideMerge(
      FauxModels.layer({
        tokensPerSecond: 2000,
        settings: { retry: { enabled: false } },
      })
    ),
    Layer.provide(BrainConfig.layerFrom(dataDir)),
    Layer.provideMerge(ShellTestLayer),
    Layer.provideMerge(ProjectorSignals.layer)
  );

/** An end checkpoint captured at `seconds`, epoch seconds. */
const endCheckpoint = (
  turn: number,
  seconds: number,
  runId: string
): CheckpointCommit => ({
  ref: `refs/cairn/checkpoints/x/turn/${String(turn)}`,
  turn,
  commit: `c${String(turn)}`,
  headOid: Option.none(),
  runId: Option.some(runId),
  point: Option.some("end"),
  capturedAtSeconds: seconds,
});

describe("a run end the shell never committed", () => {
  it.live(
    "the boot reconcile dates it by the run's own end, so its end checkpoint is not read as missed",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          mkdtempSync(path.join(tmpdir(), "cairn-unseen-end-test-"))
        ),
        (dataDir) =>
          Effect.gen(function* () {
            const context = yield* Layer.build(brainLayer(dataDir));
            const seam = Context.get(context, HarnessSeam);
            const brain = Context.get(context, Brain);
            const sink = Context.get(context, EventSink);
            const rows = Context.get(context, ThreadRows);
            const reconciled = Context.get(context, ReconciledEnds);
            const { faux } = Context.get(context, FauxModels);

            const { projectId, command } = createProject(1);

            yield* sink.commitCommand(command);
            yield* sink.commitCommand(createThread(projectId, 1));

            const events = yield* Ref.make<ReadonlyArray<HarnessEvent>>([]);

            yield* seam.events.pipe(
              Stream.runForEach((event) =>
                Ref.update(events, (all) => [...all, event])
              ),
              Effect.forkScoped
            );

            faux.setResponses([
              async () => await Promise.resolve(fauxAssistantMessage("done")),
            ]);

            yield* brain.resume;
            yield* seam.ensureThread({
              threadId: THREAD,
              projectId,
              model: FAUX_MODEL,
              thinkingLevel: "off",
              cwd: dataDir,
              instructions: Option.none(),
              runtimeMode: "full-access",
            });
            yield* seam.submit(THREAD, {
              requestId: "unseen-end-1",
              content: [{ type: "text", text: "hello" }],
              entry: Option.none(),
              whenBusy: "followUp",
            });

            const ended = yield* eventually(
              Effect.map(Ref.get(events), (all) =>
                Option.fromUndefinedOr(all.find(isRunTerminal))
              ),
              Option.isSome
            );

            assert.isTrue(Option.isSome(ended), "the run never ended");

            if (Option.isNone(ended)) {
              return;
            }

            const { runId, at } = ended.value;

            // No projector ran: the row holds the run as started, as one whose end flush a kill
            // cut off does, and the turn's end checkpoint landed when the run ended.
            const row = yield* rows.get(THREAD);

            assert.isTrue(Option.isSome(row));

            if (Option.isSome(row)) {
              yield* rows.write({
                ...row.value,
                shell: {
                  ...row.value.shell,
                  activity: "running",
                  activeRunId: Option.some(runId),
                  latestRunStartedAt: Option.some(at),
                },
              });
            }

            const endedMillis = DateTime.toEpochMillis(at);
            const endedSeconds = Math.floor(endedMillis / 1000);

            // The next boot comes later than the run's end, in a later second.
            const sinceSecond = (yield* Clock.currentTimeMillis) % 1000;

            yield* Effect.sleep(Duration.millis(2050 - sinceSecond));

            // The next boot's projector, which never saw the run's events, reconciles the row.
            const projector = yield* Layer.build(ShellProjector.layer).pipe(
              Effect.provide(context),
              Effect.map((built) => Context.get(built, ShellProjector))
            );

            yield* projector.reconcile;

            const after = yield* rows.get(THREAD);

            const completedAt = Option.flatMap(
              after,
              (found) => found.shell.latestRunCompletedAt
            );

            assert.deepStrictEqual(
              Option.map(after, (found) => found.shell.activity),
              Option.some("idle")
            );
            assert.deepStrictEqual(
              Option.map(completedAt, DateTime.toEpochMillis),
              Option.some(endedMillis),
              "the reconcile dated the run's end by its own clock, not the run's"
            );

            if (Option.isNone(completedAt)) {
              return;
            }

            const completedMillis = DateTime.toEpochMillis(completedAt.value);

            assert.isFalse(
              yield* reconciled.has(THREAD, completedAt.value),
              "a run end pi-durable dated was recorded as dated by the reconcile"
            );

            // The boot after: the turn's end checkpoint covers the run, so no repair turn.
            assert.isFalse(
              missedRunEnd(
                [endCheckpoint(1, endedSeconds, String(runId))],
                completedMillis
              ),
              "the turn whose end checkpoint landed would get an empty repair turn"
            );

            // A turn whose end checkpoint never landed (the newest is the turn before, captured
            // seconds earlier) is still repaired.
            assert.isTrue(
              missedRunEnd(
                [endCheckpoint(1, endedSeconds - 2, "0")],
                completedMillis
              ),
              "a turn whose end checkpoint never landed is no longer repaired"
            );
          }).pipe(Effect.scoped),
        (dataDir) =>
          Effect.sync(() => {
            rmSync(dataDir, { recursive: true, force: true });
          })
      ),
    testLimit(30_000)
  );
});
