// The thread aliases of one conformance scenario. A scenario names its threads by alias, never by
// id: `parent` is the thread it ensures, and each subagent becomes `child1`, `child2`, ... in the
// order the harness first reports it (a `ThreadEnsured` naming a parent, or a `SubagentUpdated`
// naming a new child). Model lines, inputs and view expectations take an alias, and expected
// events, expected views and a model line's tool arguments may write `$<alias>` wherever a thread
// id belongs, also inside a longer string.

import type { ThreadId } from "@cairn/protocol/Ids";
import { Option, Predicate } from "effect";
import type { Schema } from "effect";

import type { HarnessEvent } from "../HarnessSeam.ts";

type Json = Schema.Json;

/** Whether a JSON value is an object. */
export const isJsonRecord = (value: Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

/** `$parent`, `$child1`, ... anywhere in a string. */
const ALIAS_TOKEN = /\$(?<alias>parent|child\d+)/gu;

const isJsonList = (value: Json): value is Schema.JsonArray =>
  Array.isArray(value);

/** The alias of the thread a scenario ensures. */
export const PARENT_ALIAS = "parent";

/** The aliases one scenario has learned so far. */
export interface ThreadAliases {
  /** The alias of a thread the scenario has met; none for one it has not. */
  aliasOf(threadId: ThreadId): Option.Option<string>;
  /** The thread an alias names; none until the harness reported it. */
  idOf(alias: string): Option.Option<ThreadId>;
  /** Every thread met so far, the parent first. */
  readonly threads: () => ReadonlyArray<ThreadId>;
  /** Learns a child from an event; returns it when it is new. */
  learn(event: HarnessEvent): Option.Option<ThreadId>;
}

/** Aliases for a scenario whose own thread is `parent`. */
export const threadAliasesOf = (parent: ThreadId): ThreadAliases => {
  const byAlias = new Map<string, ThreadId>([[PARENT_ALIAS, parent]]);
  const byThread = new Map<ThreadId, string>([[parent, PARENT_ALIAS]]);

  const add = (child: ThreadId): Option.Option<ThreadId> => {
    if (byThread.has(child)) {
      return Option.none();
    }

    const alias = `child${byThread.size}`;

    byAlias.set(alias, child);
    byThread.set(child, alias);

    return Option.some(child);
  };

  return {
    aliasOf: (threadId) => Option.fromUndefinedOr(byThread.get(threadId)),
    idOf: (alias) => Option.fromUndefinedOr(byAlias.get(alias)),
    threads: () => [...byThread.keys()],
    learn: (event) => {
      if (Predicate.isTagged(event, "ThreadEnsured")) {
        return Option.isSome(event.parent)
          ? add(event.threadId)
          : Option.none();
      }

      return Predicate.isTagged(event, "SubagentUpdated")
        ? add(event.child)
        : Option.none();
    },
  };
};

/**
 * `value` with every `$<alias>` the aliases know replaced by its thread id, inside any string. An
 * alias not learned yet stays as written, so an expectation naming it cannot match by accident.
 */
export const resolveAliases = (value: Json, aliases: ThreadAliases): Json => {
  if (Predicate.isString(value)) {
    return value.replaceAll(ALIAS_TOKEN, (token, alias: string) =>
      Option.getOrElse(aliases.idOf(alias), () => token)
    );
  }

  if (isJsonList(value)) {
    return value.map((item) => resolveAliases(item, aliases));
  }

  if (isJsonRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveAliases(item, aliases),
      ])
    );
  }

  return value;
};
