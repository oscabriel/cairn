// Signals from outside pi-durable that change a thread's sidebar row: a thread waiting for a Claude
// generation slot, and when a Claude plan window that refused a run resets. The shell projector
// merges them into its activity patches; the bridge's usage layer provides them. The default has
// none, so the projector works before the bridge is wired.

import type { ThreadId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Context, Layer, Option, Stream } from "effect";

/** A change to the externally signalled fields of one thread's row; none leaves a field alone. */
export interface ProjectorSignal {
  readonly threadId: ThreadId;
  readonly patch: {
    readonly waitingFor: Option.Option<ThreadShell["waitingFor"]>;
    readonly usageLimitResetAt: Option.Option<ThreadShell["usageLimitResetAt"]>;
  };
}

/** The stream of projector signals. */
export class ProjectorSignals extends Context.Service<
  ProjectorSignals,
  {
    /** Every signal from now on, in the order they happen. */
    readonly signals: Stream.Stream<ProjectorSignal>;
  }
>()("cairn/server/shell/ProjectorSignals") {
  /** No signals: no thread ever waits for a slot or a plan window. */
  static readonly layer = Layer.succeed(
    ProjectorSignals,
    ProjectorSignals.of({ signals: Stream.empty })
  );

  /** A fixed list of signals, for tests. */
  static readonly layerTest = (signals: ReadonlyArray<ProjectorSignal>) =>
    Layer.succeed(
      ProjectorSignals,
      ProjectorSignals.of({ signals: Stream.fromIterable(signals) })
    );

  /** A signal that changes only `waitingFor`. */
  static readonly waiting = (
    threadId: ThreadId,
    waitingFor: ThreadShell["waitingFor"]
  ): ProjectorSignal => ({
    threadId,
    patch: {
      waitingFor: Option.some(waitingFor),
      usageLimitResetAt: Option.none(),
    },
  });
}
