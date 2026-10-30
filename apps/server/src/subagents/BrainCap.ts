// The brain-wide cap on live children (subagents note S3, `MAX_LIVE_CHILDREN_PER_BRAIN`): beside a
// parent's own cap of 8, the whole brain holds at most 32 children working, waiting, or on their
// way. A child counts from its ask: a brief waiting for Go, an accepted brief whose start task has
// not run (parked ones too, since a Retry starts them), and every registry item not settled.
//
// The count reads every thread that holds children, which `cairn.subagent-parents` (session scope)
// lists: the spawn adds its parent, and so do the paths that bring a settled child back to work
// (`subagent_send`, a user's steer), so no live child is ever under an unlisted parent. A spawn's
// count drops the parents it finds with nothing live, which keeps the list to threads that matter.
// Parents from before the list existed join it when they next spawn, send or steer.
//
// The spawn refuses at the cap; the start task's creating commit counts again (without itself),
// so a race between spawns of two threads cannot start a 33rd child.

import type { ConversationId, TaskId, Tx } from "@earendil-works/pi-durable";

import { Approvals } from "../brain/CairnDocs.ts";
import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { conversationOf } from "./Delivery.ts";
import { SubagentParentsDoc, SubagentsDoc } from "./SubagentDocs.ts";

/** The tool whose brief records start a subagent at Go. */
export const SPAWN_TOOL = "subagent_spawn";

/**
 * Whether a record is a subagent's brief, which Go starts as a child: a workflow's launch and a
 * workflow node's own brief are briefs too, and their workflow acts on them instead.
 */
export const isSpawnBrief = (record: ApprovalRecord): boolean =>
  record.kind === "brief" && record.tool === SPAWN_TOOL;

/** Task states a start can still run from: everything short of completing or terminal. */
const RUNNABLE = ["pending", "running", "waiting", "sleeping"] as const;

/** How many task records a scan reads per page. */
const SCAN_PAGE = 256;

/** The most start tasks a count reads per state: far past the cap, so a runaway scan stops. */
const SCAN_CEILING = 4096;

/** What the brain holds live, and which listed parents hold nothing. */
export interface BrainCount {
  readonly live: number;
  /** Listed parents with no live child, pending brief or start: a spawn may drop them. */
  readonly idle: ReadonlyArray<string>;
}

/**
 * Lists `parent` among the threads that hold children. A doc write only when it is new, so a
 * parent already listed changes nothing.
 */
export const listParent = async (tx: Tx, parent: ConversationId) => {
  const parents = await tx.doc(SubagentParentsDoc);
  const key = String(parent);

  if (parents.parents[key] !== true) {
    parents.parents[key] = true;
  }
};

/**
 * The start tasks of `kind` that can still run, by their conversation. Table reads: call it before
 * the commit's first table write (a created task or conversation).
 */
const startsByParent = async (
  tx: Tx,
  kind: string,
  except: TaskId | null
): Promise<ReadonlyMap<string, number>> => {
  const found = new Map<string, number>();

  for (const status of RUNNABLE) {
    let cursor: Parameters<Tx["scanTasks"]>[2];
    let read = 0;

    do {
      // oxlint-disable-next-line no-await-in-loop -- pages of one scan, in order
      const page = await tx.scanTasks({ kind, status }, SCAN_PAGE, cursor);

      for (const task of page.items) {
        if (task.id !== except) {
          const key = String(task.conversationId);

          found.set(key, (found.get(key) ?? 0) + 1);
        }
      }

      read += page.items.length;
      cursor = page.next;
    } while (cursor !== undefined && read < SCAN_CEILING);
  }

  return found;
};

/**
 * How many children the brain holds live: over every listed parent, its registry items not
 * settled and its briefs waiting for Go, plus every start task of `startKind` that can still run
 * (except `except`, the start counting). Table reads first, so call it before any table write.
 */
export const countLive = async (
  tx: Tx,
  startKind: string,
  except: TaskId | null
): Promise<BrainCount> => {
  const starts = await startsByParent(tx, startKind, except);
  const parents = await tx.doc(SubagentParentsDoc);
  const idle: Array<string> = [];
  let live = [...starts.values()].reduce((sum, count) => sum + count, 0);

  for (const key of Object.keys(parents.parents)) {
    const conversation = conversationOf(Number(key));
    // oxlint-disable-next-line no-await-in-loop -- document reads, in order, in one transaction
    const registry = await tx.doc(SubagentsDoc, conversation);
    // oxlint-disable-next-line no-await-in-loop -- document reads, in order, in one transaction
    const ledger = await tx.doc(Approvals, conversation);

    const children = Object.values(registry.items).filter(
      (item) => item.status !== "settled"
    ).length;

    const proposed = Object.values(ledger.items).filter(
      (record) => isSpawnBrief(record) && record.status === "pending"
    ).length;

    live += children + proposed;

    if (children + proposed === 0 && !starts.has(key)) {
      idle.push(key);
    }
  }

  return { live, idle };
};

/** Drops the parents a count found idle, except `keep` (the thread that is about to add one). */
export const dropIdle = async (
  tx: Tx,
  count: BrainCount,
  keep: ConversationId
) => {
  const dropped = new Set(count.idle.filter((key) => key !== String(keep)));

  if (dropped.size === 0) {
    return;
  }

  const parents = await tx.doc(SubagentParentsDoc);

  parents.parents = Object.fromEntries(
    Object.entries(parents.parents).filter(([key]) => !dropped.has(key))
  );
};
