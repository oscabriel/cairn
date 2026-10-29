// The gate between a turn's stream and pi's sink that keeps a delivered reply's `done` back until
// the conversation says Claude Code has written the entry the reply's stamp names. pi commits the
// stamp when `done` arrives and then runs the reply's tools; Claude Code writes its transcript on a
// 100 ms timer, so without the gate a `kill -9` in that window left a committed stamp naming an entry
// no resume could find, and the next turn rebuilt the session cold
// (`spikes/10-bridge-transcript-lag/NOTES.md`).

import type { TurnSink, TurnWriter } from "./ClaudeStream.ts";

type TurnEvent = Parameters<TurnSink["push"]>[0];

/** Forwards a turn's events to `sink`, holding `done` and everything after it until `release`. */
export class DoneGate implements TurnWriter {
  readonly #sink: TurnWriter;
  #held: Array<TurnEvent> = [];
  #holding = false;
  #endHeld = false;

  constructor(sink: TurnWriter) {
    this.#sink = sink;
  }

  /** Whether a `done` is waiting for `release`. */
  get holding(): boolean {
    return this.#holding;
  }

  push(event: TurnEvent): void {
    if (event.type === "done") {
      this.#holding = true;
    }

    if (this.#holding) {
      this.#held.push(event);
    } else {
      this.#sink.push(event);
    }
  }

  end(): void {
    if (this.#holding) {
      this.#endHeld = true;
    } else {
      this.#sink.end();
    }
  }

  /** Forwards what was held, in order; from here on events pass straight through. */
  release(): void {
    const held = this.#held;
    const ended = this.#endHeld;

    this.#held = [];
    this.#holding = false;
    this.#endHeld = false;

    for (const event of held) {
      this.#sink.push(event);
    }

    if (ended) {
      this.#sink.end();
    }
  }
}
