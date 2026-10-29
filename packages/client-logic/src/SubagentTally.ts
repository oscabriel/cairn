// A parent row's tally of its children (ADR 0028, subagents note section 9), derived from the
// parent's `cairn.subagents` registry: `working` and `asking` count a child by its registry status
// (`waiting` is asking: a question to the parent or the user, or an approval), and a settled child
// counts as `failed` when its latest settlement failed, else `settled` (a stopped child is settled).
// A settled child whose latest settlement is not yet delivered (its note and wake still to come)
// counts as `working`: its parent is not settled, by hand or by the sweep, until the result lands
// (subagents note section 4, the `settled` row).
// Shared by the brain (the commit feed, the scripted harness and the shell projector's boot
// reconcile, which all read the registry) and anything that reads a registry document.

import type {
  SettlementOutcome,
  SubagentStatus,
  SubagentTally,
} from "@cairn/protocol/Subagents";
import {
  NO_SUBAGENTS,
  SettlementOutcome as SettlementOutcomeSchema,
  SubagentStatus as SubagentStatusSchema,
} from "@cairn/protocol/Subagents";
import { Option, Schema } from "effect";

/**
 * What the tally reads of one child: its status, how its latest settlement ended, and whether a
 * settlement is still to be delivered (`delivered` below the settlements' count).
 */
export interface TallyChild {
  readonly status: SubagentStatus;
  readonly latest: Option.Option<SettlementOutcome>;
  readonly undelivered: boolean;
}

/** The tally of `children`. */
export const tallyOf = (children: Iterable<TallyChild>): SubagentTally => {
  let working = 0;
  let asking = 0;
  let settled = 0;
  let failed = 0;

  for (const child of children) {
    if (child.status === "working" || child.undelivered) {
      working += 1;
    } else if (child.status === "waiting") {
      asking += 1;
    } else if (Option.contains(child.latest, "failed")) {
      failed += 1;
    } else {
      settled += 1;
    }
  }

  return { working, asking, settled, failed };
};

/** True while a child works or asks: its parent stays unsettled and shows it at work. */
export const hasLiveChildren = (tally: SubagentTally): boolean =>
  tally.working + tally.asking > 0;

/** What the tally reads of one stored registry item; other fields are left alone. */
const TallyItem = Schema.Struct({
  status: SubagentStatusSchema,
  settlements: Schema.Array(
    Schema.Struct({ outcome: SettlementOutcomeSchema })
  ),
  delivered: Schema.Int,
});

const decodeItem = Schema.decodeUnknownOption(TallyItem);

const decodeRegistry = Schema.decodeUnknownOption(
  Schema.Struct({ items: Schema.Record(Schema.String, Schema.Json) })
);

/**
 * The tally of a `cairn.subagents` document as stored (plain JSON): the items it can read, and
 * no children for anything else (a thread with no registry yet).
 */
export const tallyOfRegistry = (
  registry: Schema.Json | undefined
): SubagentTally =>
  Option.match(decodeRegistry(registry), {
    onNone: () => NO_SUBAGENTS,
    onSome: ({ items }) =>
      tallyOf(
        Object.values(items).flatMap((item) =>
          Option.toArray(
            Option.map(decodeItem(item), (found) => ({
              status: found.status,
              latest: Option.map(
                Option.fromUndefinedOr(found.settlements.at(-1)),
                (last) => last.outcome
              ),
              undelivered: found.delivered < found.settlements.length,
            }))
          )
        )
      ),
  });
