// Keeps a section's text fixed for the length of one run. pi-durable renders every section before
// each model request and appends a `pi.system` entry (and misses the provider's prompt cache)
// whenever the text changes, so a section that re-read its files on every request could change in
// the middle of a turn. A pin holds the text a conversation got at the start of its run; the
// section computes again only when the run (or the conversation's cwd) changes, which is the next
// user turn. Pure: the caller supplies the run key.

/** How many conversations' pins are kept; the oldest goes first. */
const MAX_PINS = 1024;

/** One section's pinned text per conversation, keyed by run. */
export class RunPins<A> {
  private readonly pins = new Map<number, { key: string; value: A }>();

  /**
   * The value pinned for `conversationId` under `key`, or `compute()` pinned now when the key
   * changed or nothing is pinned.
   */
  get(conversationId: number, key: string, compute: () => A): A {
    const pinned = this.pins.get(conversationId);

    if (pinned?.key === key) {
      return pinned.value;
    }

    const value = compute();

    this.pins.delete(conversationId);
    this.pins.set(conversationId, { key, value });

    if (this.pins.size > MAX_PINS) {
      const [oldest] = this.pins.keys();

      if (oldest !== undefined) {
        this.pins.delete(oldest);
      }
    }

    return value;
  }

  /** Drops every pin, so each conversation computes again at its next request. */
  clear(): void {
    this.pins.clear();
  }
}
