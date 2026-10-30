// One step of the project thread's life in its own process, for `ProjectThreadKill.test.ts`: it
// opens `<data>/cairn.sqlite`, runs the step over the scripted harness, and kills itself with
// SIGKILL at the crash point it names, as `kill -9` would.
//
//   node project-thread-kill.ts <data> <root> seed
//   node project-thread-kill.ts <data> <root> <before_create|mid_commit|after_commit|none>
//   node project-thread-kill.ts <data> <root> control
//
// `seed` registers the project at `<root>` and launches its first project thread. The others send
// the refresh (`REFRESH`, which replaces it), dying after the launch row and before the shell
// commit (`before_create`), inside the shell commit after the new thread's row is written and
// before the old one is archived (`mid_commit`), or in the next commit, after the refresh landed
// (`after_commit`). `control` is the broken refresh the one commit exists to prevent: it archives
// the old project thread in a commit of its own, then dies before the new one is made. Prints
// `{"event":"done"}` when the step returns.

import path from "node:path";

import { CommandId } from "@cairn/protocol/Ids";
import { ThreadArchive } from "@cairn/protocol/ShellCommands";
import { Effect, Layer, Match, Option } from "effect";

import { EventSink } from "../../shell/EventSink.ts";
import { ThreadRows } from "../../shell/ThreadRows.ts";
import type { ThreadRow } from "../../shell/ThreadRows.ts";
import { LaunchStore } from "../LaunchStore.ts";
import { ThreadLaunch } from "../ThreadLaunch.ts";
import {
  fileShell,
  HeldModel,
  ModelGate,
  threadsTestLayer,
} from "../ThreadsTestKit.ts";
import { TitleModel } from "../TitleModel.ts";
import {
  FIRST,
  FIRST_LAUNCH,
  projectCommand,
  REFRESH,
  SECOND,
} from "./ProjectThreadLaunches.ts";

const [dataArg = ".", rootArg = ".", mode = "none"] = process.argv.slice(2);

const data = path.resolve(dataArg);

const root = path.resolve(rootArg);

const killSelf = Effect.sync(() => {
  process.kill(process.pid, "SIGKILL");
}).pipe(Effect.andThen(Effect.never));

/** Whether this mode dies instead of writing `row`. */
const diesAt = (row: ThreadRow) =>
  (mode === "mid_commit" &&
    row.shell.id === FIRST &&
    Option.isSome(row.shell.archivedAt)) ||
  (mode === "after_commit" &&
    row.shell.id === SECOND &&
    row.shell.activity === "preparing");

/** The thread rows, dying instead of writing the row `diesAt` picks. */
const rows = Layer.effect(
  ThreadRows,
  Effect.gen(function* () {
    const real = yield* ThreadRows;

    return ThreadRows.of({
      ...real,
      write: (row) => (diesAt(row) ? killSelf : real.write(row)),
    });
  })
).pipe(Layer.provide(ThreadRows.layerNoDeps));

/** The launch store, dying once the refresh's launch row is written in `before_create`. */
const launches = Layer.effect(
  LaunchStore,
  Effect.gen(function* () {
    const real = yield* LaunchStore;

    return LaunchStore.of({
      ...real,
      insert: (input, from) =>
        real
          .insert(input, from)
          .pipe(
            Effect.andThen(
              mode === "before_create" && input.threadId === SECOND
                ? killSelf
                : Effect.succeed(true)
            )
          ),
    });
  })
).pipe(Layer.provide(LaunchStore.layerNoDeps));

const layer = threadsTestLayer({
  dataDir: data,
  titleModel: TitleModel.layerNone,
  model: HeldModel,
  shell: fileShell(path.join(data, "cairn.sqlite"), rows),
  launchStore: launches,
});

const launchAndSettle = Effect.fnUntraced(function* (
  input: typeof FIRST_LAUNCH
) {
  const launcher = yield* ThreadLaunch;

  yield* launcher.launch(input, "owner@test");
  yield* launcher.settled(input.threadId);
});

const seed = Effect.gen(function* () {
  yield* (yield* EventSink).commitCommand(projectCommand(root));
  yield* launchAndSettle(FIRST_LAUNCH);
});

// The broken refresh: the old project thread archived in a commit of its own, then death.
const control = Effect.gen(function* () {
  yield* (yield* EventSink).commitCommand(
    ThreadArchive.make({
      commandId: CommandId.make("019a2b3c-4d5e-7f60-b000-000000000001"),
      threadId: FIRST,
    })
  );

  return yield* killSelf;
});

const step = Effect.andThen(
  ModelGate.use((gate) => gate.open),
  Match.value(mode).pipe(
    Match.when("seed", () => seed),
    Match.when("control", () => control),
    Match.orElse(() => launchAndSettle(REFRESH))
  )
);

await Effect.runPromise(
  step.pipe(
    Effect.andThen(
      Effect.sync(() => {
        console.log(JSON.stringify({ event: "done" }));
      })
    ),
    Effect.orDie,
    Effect.scoped,
    Effect.provide(layer)
  )
);
