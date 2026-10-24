// The brain's memory, logged where a peak can be found again (T43). systemd keeps only the unit's
// `MemoryPeak`, a number with no time, so a peak could not be matched to the thread event behind it.
// Every `MEMORY_SAMPLE_INTERVAL` the brain reads its own usage and its cgroup's `memory.current`
// (the brain plus its claude children and tool commands, which is what `MemoryPeak` measures), and
// logs `brain memory peak` each time the cgroup's figure passes the last logged one by
// `MEMORY_PEAK_STEP`. The journal's lines around that one name the cause.
import { Duration, Effect, FileSystem, Layer, Option, Schedule } from "effect";

/** How often memory is read. */
export const MEMORY_SAMPLE_INTERVAL = Duration.seconds(30);

/** How far past the last logged peak a sample must go to be logged as a new one. */
export const MEMORY_PEAK_STEP = 64 * 1024 * 1024;

/** One reading, in bytes. */
export interface MemorySample {
  readonly rss: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
  /** The cgroup's `memory.current`; none outside a systemd unit. */
  readonly cgroup: Option.Option<number>;
}

/** The figure peaks are measured on: the cgroup's when there is one, else the process's. */
const measured = (sample: MemorySample): number =>
  Option.getOrElse(sample.cgroup, () => sample.rss);

/**
 * The peak to log for `sample`, given the last logged one: the first sample always, then only one
 * that passes the last logged peak by `MEMORY_PEAK_STEP`.
 */
export const nextPeak = (
  lastLogged: Option.Option<number>,
  sample: MemorySample
): Option.Option<number> => {
  const value = measured(sample);

  return Option.match(lastLogged, {
    onNone: () => Option.some(value),
    onSome: (last) =>
      value >= last + MEMORY_PEAK_STEP ? Option.some(value) : Option.none(),
  });
};

const megabytes = (bytes: number): number => Math.round(bytes / (1024 * 1024));

/** The cgroup v2 directory this process runs in, from `/proc/self/cgroup` (`0::/path`). */
const cgroupCurrent = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const membership = yield* fs.readFileString("/proc/self/cgroup");

  const path = Option.fromNullishOr(
    membership
      .split("\n")
      .find((line) => line.startsWith("0::"))
      ?.slice(3)
  );

  if (Option.isNone(path)) {
    return Option.none<number>();
  }

  const current = yield* fs.readFileString(
    `/sys/fs/cgroup${path.value}/memory.current`
  );

  const bytes = Number(current.trim());

  return Number.isFinite(bytes) ? Option.some(bytes) : Option.none<number>();
}).pipe(Effect.orElseSucceed(() => Option.none<number>()));

const sample = Effect.gen(function* () {
  const usage = yield* Effect.sync(() => process.memoryUsage());
  const cgroup = yield* cgroupCurrent;

  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    cgroup,
  } satisfies MemorySample;
});

/** Samples memory in the background for as long as the brain runs. Needs `FileSystem`. */
export const MemoryWatch = Layer.effectDiscard(
  Effect.gen(function* () {
    let lastLogged = Option.none<number>();

    const check = Effect.gen(function* () {
      const reading = yield* sample;
      const peak = nextPeak(lastLogged, reading);

      if (Option.isNone(peak)) {
        return;
      }

      lastLogged = peak;

      yield* Effect.logInfo("brain memory peak").pipe(
        Effect.annotateLogs({
          event: "brain_memory_peak",
          cgroupMb: Option.getOrNull(Option.map(reading.cgroup, megabytes)),
          rssMb: megabytes(reading.rss),
          heapUsedMb: megabytes(reading.heapUsed),
          externalMb: megabytes(reading.external),
          arrayBuffersMb: megabytes(reading.arrayBuffers),
        })
      );
    });

    yield* check.pipe(
      Effect.repeat(Schedule.spaced(MEMORY_SAMPLE_INTERVAL)),
      Effect.forkScoped
    );
  })
);
