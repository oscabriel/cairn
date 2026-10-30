/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one step after another, on purpose */
// The subagent flows judge (plan 6J, the behaviour script for steer, stop and escalated-question
// flows; subagents note S7 and "Judges", "Steerable from the UI"; ADR 0027, ADR 0028): the real
// web client on the `next` views (`?ui=next`) over a real in-process brain on the scripted harness
// (judges/fixtures/parity/CairnApp.ts with the delegating model of
// judges/fixtures/subagents/FlowsBrain.ts), at 390 px as a phone (touch, coarse pointer) and at
// 1,440 px, each width on a fresh brain. No model provider is called.
//
//   node judges/subagent-flows.ts [--width 390,1440] [--broken steer|stop|card] [--out <dir>]
//
// One run per width, in order. Each child is spawned by a message typed into the parent's page
// and started by Go through the protocol, as the brief card sends it. Every step is judged twice:
// on what the page shows, and on the brain's state read through the protocol as a second client.
//   steer        the parent's row for a working child opens the child's thread; the steer typed
//                there goes as a steer ("Steer message", queued as Steer) while the child works;
//                the brain's registry holds two inputs for the child; let go, the child reads the
//                steer after its tool round and answers it, the child's page shows both, the
//                parent's transcript gets one completed note carrying the answer, and the parent's
//                row says Done;
//   stop-row     the parent's row for a working child opens it; Stop on the child's page ends its
//                run: the Stop button leaves, the brain settles the child once as stopped with a
//                note in the parent, and back on the parent its row says Stopped;
//   stop-panel   Stop beside a working child in the parent's work panel ends it: the panel moves it
//                under Previous as stopped, the transcript row says Stopped, the brain settles it
//                once as stopped with a note in the parent;
//   escalated    a child's question goes to the parent first: while the parent holds it, the
//                child's row says "Asked its parent", the page shows no card, the child's record
//                is pending with route parent and the parent's model has read the question; once
//                the parent escalates, the parent's own card asks it (Open subagent links the
//                child), the child's record is routed to the user with an escalation open; an
//                option picked on the card sends one answer, the child hears it once, the child's
//                record and the parent's mirror settle decided by the user, the escalation is
//                resolved and the parent's model never answered the question itself.
//
// Broken controls, each planted in the page by this judge (never in the app), each of which must
// make the step it names fail:
//   steer  a click on Send with the steer typed never reaches the app (steer);
//   stop   a click on any Stop button never reaches the app (stop-row, stop-panel);
//   card   the request card is removed whenever it is drawn (escalated).
// Each width leaves screenshots in the out folder: the steered child, the parent after both stops,
// and the parent's card for the escalated question.
// Exits 0 when every step passed; a broken control's run exits 1 when it failed rightly, and the
// JSON line names the failing steps.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { approvalRecordsOf } from "@cairn/client-logic/PendingRequests";
import { ApprovalId, ThreadId } from "@cairn/protocol/Ids";
import type { ApprovalRecord } from "@cairn/protocol/Policy";
import { APPROVALS_DOCUMENT } from "@cairn/protocol/Policy";
import {
  ESCALATIONS_DOCUMENT,
  SUBAGENT_RESULT_ENTRY,
  SUBAGENTS_DOCUMENT,
  SubagentSettlement,
  SubagentsDocument,
} from "@cairn/protocol/Subagents";
import type { SubagentRecord } from "@cairn/protocol/Subagents";
import type { Entry } from "@cairn/protocol/Thread";
import { Effect, Exit, Option, Predicate, Schema, Stream } from "effect";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Locator, Page } from "playwright";

import { PARITY_THREAD_ID, startCairn } from "./fixtures/parity/CairnApp.ts";
import {
  CHILD_HEARD,
  CHILDREN,
  flowsBrain,
  holdAll,
  release,
  releaseParent,
  STEER,
  STEERED,
} from "./fixtures/subagents/FlowsBrain.ts";
import * as ProtocolClient from "./lib/ProtocolClient.ts";

const BROKEN_CONTROLS = ["steer", "stop", "card"] as const;

type Broken = (typeof BROKEN_CONTROLS)[number] | "";

const isBroken = (value: string): value is Broken =>
  value === "" || BROKEN_CONTROLS.some((control) => control === value);

const { values } = parseArgs({
  options: {
    width: { type: "string", default: "390,1440" },
    broken: { type: "string", default: "" },
    out: {
      type: "string",
      default: path.join(
        homedir(),
        "Developer/agent-artifacts/cairn/v2/phase-2-surfaces"
      ),
    },
  },
});

if (!isBroken(values.broken)) {
  throw new Error(
    `--broken is one of ${BROKEN_CONTROLS.join(", ")}, not ${values.broken}`
  );
}

const broken: Broken = values.broken;

const widths = values.width.split(",").map(Number);

const PARENT_TITLE = "Plan the port";

/** Where the composer saves its settings on this device (`composer/Drafts.ts`). */
const COMPOSER_SETTINGS_KEY = "cairn:composer-settings:v1";

interface Result {
  readonly check: string;
  readonly width: number;
  readonly pass: boolean;
  readonly detail: string;
}

const results: Array<Result> = [];

const record = (
  check: string,
  width: number,
  pass: boolean,
  detail: string
) => {
  results.push({ check, width, pass, detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${check}@${width} ${detail}`);
};

/** A failed expectation inside a step, with what was seen. */
class CheckFailedError extends Error {
  override name = "CheckFailedError";
}

const expect = (condition: boolean, what: string) => {
  if (!condition) {
    throw new CheckFailedError(what);
  }
};

const reasonOf = (error: Error): string =>
  error instanceof CheckFailedError
    ? error.message
    : (error.message.split("\n")[0] ?? "failed");

// The plants, each run before the app's own scripts.

// Neither a click on Send nor Enter reaches the app while the steer is typed.
const plantSteer = (steer: string) => {
  const typed = () =>
    (
      document.querySelector('[data-testid="composer-editor"]')?.textContent ??
      ""
    ).includes(steer);

  document.addEventListener(
    "click",
    (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="composer-send"]') !== null &&
        typed()
      ) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    { capture: true }
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" && typed()) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    { capture: true }
  );
};

// The phone's saved composer settings: a message sent while a run works steers it. A phone has no
// mod+Enter, so this setting is how a phone user steers. It is written where the composer reads it
// (`composer/Drafts.ts`), since the settings page's Follow-up behaviour does not reach the composer
// yet (6J's hand-off).
const saveSteerSetting = (key: string) => {
  if (localStorage.getItem(key) === null) {
    localStorage.setItem(
      key,
      JSON.stringify({
        sendShortcut: "enter",
        followUpBehavior: "steer",
        favoriteModels: [],
      })
    );
  }
};

// A click on any Stop button never reaches the app.
const plantStop = () => {
  document.addEventListener(
    "click",
    (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest(
          '[data-testid="composer-stop"], [data-testid="work-child-stop"]'
        ) !== null
      ) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    { capture: true }
  );
};

// The request card is removed whenever it is drawn.
const plantCard = () => {
  new MutationObserver(() => {
    for (const card of document.querySelectorAll(
      '[data-testid="request-card"]'
    )) {
      card.remove();
    }
  }).observe(document, { subtree: true, childList: true });
};

const newDevice = async (
  browser: Browser,
  width: number
): Promise<BrowserContext> => {
  const context = await browser.newContext(
    width < 640
      ? {
          viewport: { width, height: 844 },
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 3,
          reducedMotion: "reduce",
        }
      : { viewport: { width, height: 900 }, reducedMotion: "reduce" }
  );

  if (width < 640) {
    await context.addInitScript(saveSteerSetting, COMPOSER_SETTINGS_KEY);
  }

  if (broken === "steer") {
    await context.addInitScript(plantSteer, STEER);
  }

  if (broken === "stop") {
    await context.addInitScript(plantStop);
  }

  if (broken === "card") {
    await context.addInitScript(plantCard);
  }

  return context;
};

/** Saves what the page shows, for the user's round or beside a failed step's report. */
const shot = async (page: Page, name: string, width: number) => {
  mkdirSync(values.out, { recursive: true });
  await page
    .screenshot({
      path: path.join(values.out, `subagent-flows-${name}-${width}.png`),
    })
    .catch(() => null);
};

/** Polls `read` until `done` holds, up to `timeout` ms; returns the last reading. */
const until = async <A>(
  read: () => Promise<A>,
  done: (value: A) => boolean,
  timeout: number
): Promise<A> => {
  const end = Date.now() + timeout;
  let seen = await read();

  while (!done(seen) && Date.now() < end) {
    await sleep(100);
    seen = await read();
  }

  return seen;
};

const editor = (page: Page) =>
  page.locator('[data-testid="composer-editor"]').first();

const card = (page: Page) => page.locator('[data-testid="request-card"]');

/** The card once it shows a question (a brief's card may still be leaving after Go). */
const questionCard = (page: Page) =>
  page.locator('[data-testid="request-card"][data-request-body="Question"]');

const stopButton = (page: Page) =>
  page.locator('[data-testid="composer-stop"]').first();

/** The parent's transcript row for a child, by the child's thread id. */
const subagentRow = (page: Page, child: string) =>
  page
    .locator(`[data-testid="subagent-row"][data-child-thread-id="${child}"]`)
    .first();

const rowState = async (page: Page, child: string) =>
  (await subagentRow(page, child)
    .getAttribute("data-state", { timeout: 2000 })
    .catch(() => "")) ?? "";

/** The open thread's status word in the chat header. */
const headerWord = async (page: Page) =>
  (
    (await page
      .locator('[data-testid="next-header-status"]')
      .first()
      .textContent()
      .catch(() => "")) ?? ""
  ).trim();

/** Whether the page scrolls sideways. */
const overflows = async (page: Page) =>
  await page.evaluate(() => {
    const scroller = document.scrollingElement;

    return scroller !== null && scroller.scrollWidth > scroller.clientWidth + 1;
  });

/** Whether the open transcript shows `words` in a drawn row. */
const transcriptShows = async (page: Page, words: string) => {
  const text = await page
    .locator('[data-testid="timeline-scroll"]')
    .first()
    .textContent()
    .catch(() => "");

  return (text ?? "").includes(words);
};

/** Taps on the phone, clicks on a desktop. */
const press = async (target: Locator, width: number) => {
  await (width < 640 ? target.tap() : target.click());
};

/** Sends a message from the open page's composer. */
const send = async (page: Page, words: string) => {
  await editor(page).fill(words);
  await page.locator('[data-testid="composer-send"]').first().click();
};

/** Counts the `thread.respond` frames a page sends. */
const respondsOf = (page: Page): Array<number> => {
  const sent: Array<number> = [];

  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (String(payload).includes("thread.respond")) {
        sent.push(Date.now());
      }
    });
  });

  return sent;
};

/** What a thread's stream starts from: the parts of its view this judge reads. */
interface ThreadRead {
  readonly records: ReadonlyArray<ApprovalRecord>;
  readonly children: ReadonlyArray<SubagentRecord>;
  readonly escalations: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<Entry>;
}

/** The part of a parent's `cairn.escalations` the judge reads: where each entry stands. */
const Escalations = Schema.Struct({
  items: Schema.Record(Schema.String, Schema.Struct({ status: Schema.String })),
});

const decodeEscalations = Schema.decodeUnknownOption(Escalations);

const decodeSubagents = Schema.decodeUnknownOption(SubagentsDocument);

const decodeSettlement = Schema.decodeUnknownOption(SubagentSettlement);

const NO_DOCS: Readonly<Record<string, Schema.Json>> = {};

/** The brain's protocol, as a second client: reads a thread and answers its requests. */
const protocolOf = (brainUrl: string, origin: string) => {
  const withClient = async <A, E>(
    body: (
      client: Effect.Success<ReturnType<typeof ProtocolClient.cairn>>
    ) => Effect.Effect<A, E>
  ): Promise<A> =>
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* ProtocolClient.cairn({
            base: brainUrl,
            origin,
            headers: { host: new URL(origin).host },
            openTimeout: "10 seconds",
          });

          yield* client["session.hello"]();

          return yield* body(client);
        })
      )
    );

  const read = async (threadId: string): Promise<ThreadRead> =>
    await withClient((client) =>
      Effect.map(
        client["thread.subscribe"]({ threadId: ThreadId.make(threadId) }).pipe(
          Stream.runHead
        ),
        (first) => {
          const view = Option.flatMap(first, (item) =>
            Predicate.isTagged(item, "Snapshot")
              ? Option.some(item.view)
              : Option.none()
          );

          const docs = Option.match(view, {
            onNone: () => NO_DOCS,
            onSome: (found) => found.docs,
          });

          return {
            records: approvalRecordsOf(docs[APPROVALS_DOCUMENT]),
            children: Option.match(decodeSubagents(docs[SUBAGENTS_DOCUMENT]), {
              onNone: () => [],
              onSome: ({ items }) => Object.values(items),
            }),
            escalations: Option.match(
              decodeEscalations(docs[ESCALATIONS_DOCUMENT]),
              {
                onNone: () => [],
                onSome: ({ items }) =>
                  Object.values(items).map(({ status }) => status),
              }
            ),
            entries: Option.match(view, {
              onNone: () => [],
              onSome: (found) => found.entries,
            }),
          };
        }
      )
    );

  /** Answers one request with Go or the first option; the failure's words when refused. */
  const respond = async (
    threadId: string,
    approvalId: string
  ): Promise<Option.Option<string>> =>
    await withClient((client) =>
      Effect.map(
        Effect.exit(
          client["thread.respond"]({
            threadId: ThreadId.make(threadId),
            approvalId: ApprovalId.make(approvalId),
            decision: "accept",
            reason: Option.none(),
            answers: Option.none(),
            launch: Option.none(),
          })
        ),
        (exit) =>
          Exit.isSuccess(exit)
            ? Option.none()
            : Option.some(JSON.stringify(exit.cause))
      )
    );

  /** A thread's decision records. */
  const records = async (threadId: string) => {
    const seen = await read(threadId);

    return seen.records;
  };

  /** A thread's transcript. */
  const entries = async (threadId: string) => {
    const seen = await read(threadId);

    return seen.entries;
  };

  return { read, respond, records, entries };
};

type Protocol = ReturnType<typeof protocolOf>;

const textOfEntry = (entry: Entry): string => JSON.stringify(entry.model ?? []);

/** The settlement notes the parent's transcript holds for `child`. */
const notesFor = (
  entries: ReadonlyArray<Entry>,
  child: string
): ReadonlyArray<SubagentSettlement> =>
  entries.flatMap((entry) =>
    entry.kind === SUBAGENT_RESULT_ENTRY
      ? Option.match(decodeSettlement(entry.data), {
          onNone: () => [],
          onSome: (settlement) =>
            settlement.subagent === child ? [settlement] : [],
        })
      : []
  );

/** The parent's registry item for `child`. */
const registryOf = async (protocol: Protocol, child: string) => {
  const { children } = await protocol.read(PARITY_THREAD_ID);

  return children.find((found) => found.threadId === child);
};

/** Answers Go on the pending brief for `description`, then waits for its child; the child's id. */
const goOn = async (
  protocol: Protocol,
  description: string
): Promise<string> => {
  const findBrief = async () => {
    const records = await protocol.records(PARITY_THREAD_ID);

    return records.find(
      (found) =>
        found.kind === "brief" &&
        found.payload?.type === "brief" &&
        found.payload.title === description
    );
  };

  const brief = await until(findBrief, (found) => found !== undefined, 15_000);

  expect(brief !== undefined, `no brief for "${description}" was asked`);

  if (brief?.status === "pending") {
    const refused = await protocol.respond(PARITY_THREAD_ID, brief.id);

    expect(
      Option.isNone(refused),
      `Go was refused: ${Option.getOrElse(refused, () => "")}`
    );
  }

  const started = await until(
    async () => {
      const found = await findBrief();

      return found?.started?.childThreadId ?? "";
    },
    (child) => child !== "",
    15_000
  );

  expect(started !== "", `the brief "${description}" started no child`);

  return started;
};

/**
 * Spawns `description` from the parent's page and Go, then waits until the parent's row for it
 * says Working; the child's id.
 */
const spawnWorking = async (
  page: Page,
  protocol: Protocol,
  description: string
): Promise<string> => {
  await send(page, `delegate: ${description}`);

  const child = await goOn(protocol, description);

  const state = await until(
    async () => await rowState(page, child),
    (seen) => seen === "working",
    15_000
  );

  expect(
    state === "working",
    `the parent's row for "${description}" says ${JSON.stringify(state)}`
  );

  return child;
};

/** Opens a child from the parent's row for it, and waits for its page. */
const openFromRow = async (page: Page, child: string, width: number) => {
  await press(subagentRow(page, child), width);
  await page.waitForURL(`**/t/${child}*`, { timeout: 10_000 });
  await page
    .locator('[data-testid="subagent-parent-link"]')
    .waitFor({ state: "visible", timeout: 10_000 });
  await editor(page).waitFor({ state: "attached", timeout: 10_000 });
};

/**
 * Why the brain did not settle `child` once as stopped with a note in the parent, while its
 * registry item no longer works; none when it did.
 */
const stoppedOnce = async (
  protocol: Protocol,
  child: string
): Promise<Option.Option<string>> => {
  const parent = await until(
    async () => await protocol.read(PARITY_THREAD_ID),
    (seen) => notesFor(seen.entries, child).length > 0,
    10_000
  );

  // A moment for a second settlement to land, had the stop settled twice.
  await sleep(500);

  const after = await protocol.read(PARITY_THREAD_ID);
  const notes = notesFor(after.entries, child);
  const item = after.children.find((found) => found.threadId === child);

  if (notes.length !== 1 || notes[0]?.outcome !== "stopped") {
    return Option.some(
      `the parent holds notes ${JSON.stringify(notes.map((note) => note.outcome))} for the child (${notesFor(parent.entries, child).length} at first)`
    );
  }

  const outcomes = (item?.settlements ?? []).map((mark) => mark.outcome);

  if (outcomes.join(",") !== "stopped") {
    return Option.some(`the registry settled ${JSON.stringify(outcomes)}`);
  }

  return item?.status === "working"
    ? Option.some("the registry still says the child works")
    : Option.none();
};

/**
 * Why the escalated question `approvalId` was not answered once by the user with `pick`, after
 * a moment for a second answer to land: the child must hear `pick` once, its record and the
 * parent's mirror settle decided by the user, the escalation be resolved, and the parent's model
 * never answer the question itself. None when it was.
 */
const answeredByUser = async (
  protocol: Protocol,
  child: string,
  approvalId: string,
  pick: string
): Promise<Option.Option<string>> => {
  await until(
    async () => {
      const entries = await protocol.entries(child);

      return entries.some((entry) =>
        textOfEntry(entry).includes(`${CHILD_HEARD} `)
      );
    },
    Boolean,
    15_000
  );

  await sleep(1000);

  const own = await protocol.read(child);
  const parent = await protocol.read(PARITY_THREAD_ID);
  const answer = own.records.find((each) => each.id === approvalId);

  const mirror = parent.records.find(
    (each) => each.mirrorOf?.threadId === child
  );

  const heard = own.entries.filter(
    (entry) =>
      entry.kind === "pi.tool-result" &&
      textOfEntry(entry).includes(`The user answered: ${pick}`)
  ).length;

  // The parent's model escalated: a `subagent_reply` with an answer would carry `"answer":`.
  const replies = parent.entries.filter((entry) =>
    textOfEntry(entry).includes('"answer":')
  ).length;

  const problems = [
    heard === 1 ? "" : `the child heard "${pick}" ${heard} times`,
    answer?.status === "accepted" && answer.decidedBy?.kind === "user"
      ? ""
      : `the child's record ended ${JSON.stringify([answer?.status, answer?.decidedBy?.kind])}`,
    mirror?.status === "accepted"
      ? ""
      : `the parent's mirror is ${mirror?.status ?? "missing"}`,
    parent.escalations.length > 0 &&
    parent.escalations.every((status) => status === "resolved")
      ? ""
      : `the escalations are ${JSON.stringify(parent.escalations)}`,
    replies === 0
      ? ""
      : `the parent's model answered the question ${replies} times`,
  ].filter((problem) => problem !== "");

  return problems.length === 0
    ? Option.none()
    : Option.some(problems.join("; "));
};

/** One width's run: every step in order, each recorded on its own. */
const runWidth = async (browser: Browser, width: number) => {
  holdAll();

  const app = await startCairn(
    { projectTitle: "Cairn", threadTitle: PARENT_TITLE, entries: [] },
    { brain: flowsBrain }
  );

  const brainUrl = process.env.CAIRN_DEV_BRAIN ?? "";
  const protocol = protocolOf(brainUrl, app.origin);
  const parentUrl = new URL(app.threadUrl);

  parentUrl.searchParams.set("ui", "next");

  const context = await newDevice(browser, width);
  const page = await context.newPage();
  const responds = respondsOf(page);

  const openParent = async () => {
    await page.goto(parentUrl.href, { waitUntil: "networkidle" });
    await page
      .locator('#root[data-ui="next"]')
      .waitFor({ state: "attached", timeout: 15_000 });
    await editor(page).waitFor({ state: "attached", timeout: 15_000 });
  };

  /** Runs one step; a failed step is recorded and the rest still run. */
  const step = async (name: string, body: () => Promise<string>) => {
    try {
      record(name, width, true, await body());
    } catch (error) {
      await shot(page, `failed-${name}`, width);
      record(
        name,
        width,
        false,
        reasonOf(error instanceof Error ? error : new Error(String(error)))
      );
    }
  };

  try {
    await step("steer", async () => {
      await openParent();

      const { description } = CHILDREN.steered;
      const child = await spawnWorking(page, protocol, description);

      await openFromRow(page, child, width);
      await stopButton(page).waitFor({ state: "visible", timeout: 10_000 });

      await editor(page).fill(STEER);

      const sendButton = page.locator('[data-testid="composer-send"]').first();
      const label = (await sendButton.getAttribute("aria-label")) ?? "";

      // The phone steers with Send under its saved Steer setting; the desktop keeps the default
      // (Send queues) and steers with mod+Enter, the alternate send.
      const shown = width < 640 ? "Steer message" : "Queue message";

      expect(
        label === shown,
        `with the child working, Send reads ${JSON.stringify(label)}`
      );

      await (width < 640
        ? press(sendButton, width)
        : editor(page).press("ControlOrMeta+Enter"));

      // The brain holds the steer as the child's second input before the child reads it.
      const inputs = await until(
        async () => {
          const item = await registryOf(protocol, child);

          return Object.keys(item?.inputs ?? {}).length;
        },
        (count) => count === 2,
        10_000
      );

      expect(
        inputs === 2,
        `the brain's registry holds ${inputs} inputs for the child`
      );

      const queued = await until(
        async () =>
          await page
            .locator('[data-testid="composer-queued-input"][data-mode="steer"]')
            .filter({ hasText: STEER })
            .count(),
        (count) => count === 1,
        5000
      );

      expect(queued === 1, "the child's page does not show the queued steer");

      release(description);

      const answered = await until(
        async () => await transcriptShows(page, STEERED),
        Boolean,
        15_000
      );

      expect(answered, `the child's page never showed "${STEERED}"`);
      expect(
        await transcriptShows(page, STEER),
        "the child's page does not show the steer it was sent"
      );
      expect(
        (await page
          .locator('[data-testid="composer-queued-input"]')
          .count()) === 0,
        "the steer still shows as queued after the child read it"
      );

      // The steer reached the child's model once, after its tool round.
      const own = await protocol.read(child);

      const steers = own.entries.filter(
        (entry) =>
          entry.kind !== SUBAGENT_RESULT_ENTRY &&
          textOfEntry(entry).includes(STEER) &&
          !textOfEntry(entry).includes(STEERED)
      ).length;

      expect(steers === 1, `the child's transcript holds ${steers} steers`);

      await shot(page, "steered", width);

      // The parent's note arrives, carrying the answer to the steer.
      const parent = await until(
        async () => await protocol.read(PARITY_THREAD_ID),
        (seen) => notesFor(seen.entries, child).length > 0,
        10_000
      );

      await sleep(500);

      const notes = notesFor(await protocol.entries(PARITY_THREAD_ID), child);

      expect(
        notes.length === 1 &&
          notes[0]?.outcome === "completed" &&
          notes[0].summary.includes(STEERED),
        `the parent's notes for the child read ${JSON.stringify(notes.map(({ outcome, summary }) => ({ outcome, summary })))} (${notesFor(parent.entries, child).length} at first)`
      );

      await page.locator('[data-testid="subagent-parent-link"]').click();
      await page.waitForURL(`**/t/${PARITY_THREAD_ID}*`, { timeout: 10_000 });

      const state = await until(
        async () => await rowState(page, child),
        (seen) => seen === "done",
        10_000
      );

      expect(
        state === "done",
        `back on the parent the child's row says ${JSON.stringify(state)}`
      );
      expect(!(await overflows(page)), "the parent's page scrolls sideways");

      return `opened from the parent's row; ${width < 640 ? "Send under the Steer setting" : "mod+Enter"} queued the steer as Steer (2 inputs in the registry); the child answered "${STEERED}" on its page, once; one completed note in the parent; its row says Done`;
    });

    await step("stop-row", async () => {
      await openParent();

      const { description } = CHILDREN.stopRow;
      const child = await spawnWorking(page, protocol, description);

      await openFromRow(page, child, width);
      await stopButton(page).waitFor({ state: "visible", timeout: 10_000 });
      await press(stopButton(page), width);

      const left = await until(
        async () => await stopButton(page).count(),
        (count) => count === 0,
        10_000
      );

      expect(left === 0, "the child's Stop button stayed after Stop");

      const once = await stoppedOnce(protocol, child);

      expect(
        Option.isNone(once),
        Option.getOrElse(once, () => "")
      );

      await page.locator('[data-testid="subagent-parent-link"]').click();
      await page.waitForURL(`**/t/${PARITY_THREAD_ID}*`, { timeout: 10_000 });

      const state = await until(
        async () => await rowState(page, child),
        (seen) => seen === "stopped",
        10_000
      );

      const word = (
        (await subagentRow(page, child)
          .locator('[data-slot="subagent-state"]')
          .textContent()
          .catch(() => "")) ?? ""
      ).trim();

      expect(
        state === "stopped" && word === "Stopped",
        `back on the parent the child's row says ${JSON.stringify([state, word])}`
      );

      return `opened from the parent's row; Stop on the child's page ended its run (Stop left); one stopped note in the parent, the registry settled it stopped; its row says Stopped`;
    });

    await step("stop-panel", async () => {
      await openParent();

      const { description } = CHILDREN.stopPanel;
      const child = await spawnWorking(page, protocol, description);

      const toggle = page.locator('[data-testid="work-toggle"]');

      await toggle.waitFor({ state: "visible", timeout: 15_000 });

      if ((await toggle.getAttribute("aria-expanded")) !== "true") {
        await press(toggle, width);
      }

      const panel = page.locator('[data-testid="work-panel"]');

      await panel.waitFor({ state: "visible", timeout: 5000 });

      const childRow = panel
        .locator(`[data-testid="work-child"][data-thread-id="${child}"]`)
        .first();

      await childRow.waitFor({ state: "visible", timeout: 10_000 });

      const before = (await childRow.getAttribute("data-state")) ?? "";

      expect(
        before === "working",
        `the panel's row for the child says ${JSON.stringify(before)}`
      );

      await press(childRow.locator('[data-testid="work-child-stop"]'), width);

      const moved = await until(
        async () =>
          await panel
            .locator(
              `[data-testid="work-children"] [data-testid="work-child"][data-thread-id="${child}"]`
            )
            .count(),
        (count) => count === 0,
        10_000
      );

      expect(moved === 0, "the child stayed with the live children after Stop");

      if (
        (await panel.locator('[data-testid="work-previous"]').count()) === 0
      ) {
        await press(
          panel.locator('[data-testid="work-previous-toggle"]'),
          width
        );
      }

      const rested =
        (await panel
          .locator(
            `[data-testid="work-previous"] [data-testid="work-child"][data-thread-id="${child}"]`
          )
          .first()
          .getAttribute("data-state", { timeout: 5000 })
          .catch(() => "")) ?? "";

      expect(
        rested === "stopped",
        `under Previous the child reads ${JSON.stringify(rested)}`
      );

      const once = await stoppedOnce(protocol, child);

      expect(
        Option.isNone(once),
        Option.getOrElse(once, () => "")
      );
      expect(!(await overflows(page)), "the page scrolls sideways after Stop");

      await shot(page, "stopped", width);

      // Closed again, the transcript's row agrees with the panel.
      // The panel's own close: on the phone the sheet's scrim covers the header's button.
      await press(panel.locator('[data-testid="work-close"]'), width);
      await panel.waitFor({ state: "hidden", timeout: 5000 });

      const state = await until(
        async () => await rowState(page, child),
        (seen) => seen === "stopped",
        10_000
      );

      expect(
        state === "stopped",
        `the transcript's row for the child says ${JSON.stringify(state)}`
      );

      return `Stop in the work panel moved the child under Previous as stopped; one stopped note in the parent, the registry settled it stopped; the transcript's row says Stopped`;
    });

    await step("escalated", async () => {
      await openParent();

      const { description, question, options } = CHILDREN.escalated;

      await send(page, `delegate: ${description}`);

      const child = await goOn(protocol, description);

      // With the parent first: the child's record names the parent, and the parent's model read it.
      const asked = await until(
        async () => {
          const records = await protocol.records(child);

          return records.find((found) => found.kind === "user-input");
        },
        (found) => found?.status === "pending" && found.route === "parent",
        15_000
      );

      expect(
        asked?.status === "pending" && asked.route === "parent",
        `the child's question reads ${JSON.stringify([asked?.status, asked?.route])}`
      );

      const heldBy = await until(
        async () => {
          const entries = await protocol.entries(PARITY_THREAD_ID);

          return entries.some((entry) => textOfEntry(entry).includes(question));
        },
        Boolean,
        10_000
      );

      expect(heldBy, "the parent's transcript never received the question");

      const asking = await until(
        async () => await rowState(page, child),
        (seen) => seen === "asking-parent",
        10_000
      );

      expect(
        asking === "asking-parent",
        `while the parent holds the question the child's row says ${JSON.stringify(asking)}`
      );

      // For a second while the parent holds it, the user is not asked.
      const seen = new Set<string>();
      const end = Date.now() + 1000;

      while (Date.now() < end) {
        if ((await questionCard(page).count()) > 0) {
          seen.add("card");
        }

        if ((await headerWord(page)) === "Input") {
          seen.add("header Input");
        }

        await sleep(100);
      }

      expect(
        seen.size === 0,
        `while the parent held the question the page showed ${[...seen].join(", ")}`
      );

      releaseParent();

      // Escalated: the child's record goes to the user, the parent gains a mirror and an escalation.
      const routed = await until(
        async () => await protocol.read(child),
        (found) =>
          found.records.some(
            (each) =>
              each.id === asked?.id &&
              each.route === "user" &&
              each.escalatedAt !== null
          ),
        10_000
      );

      expect(
        routed.records.some(
          (each) => each.id === asked?.id && each.route === "user"
        ),
        "the parent's escalation never routed the question to the user"
      );

      const escalation = await protocol.read(PARITY_THREAD_ID);

      expect(
        escalation.escalations.join(",") === "open" &&
          escalation.records.some(
            (each) =>
              each.mirrorOf?.threadId === child && each.status === "pending"
          ),
        `the parent's escalations read ${JSON.stringify(escalation.escalations)}`
      );

      const shown = await until(
        async () => await questionCard(page).count(),
        (count) => count === 1,
        15_000
      );

      expect(shown === 1, "the parent's page never showed the question card");

      const words = ((await card(page).textContent()) ?? "").trim();

      const href =
        (await card(page)
          .locator('[data-testid="request-card-subagent"]')
          .getAttribute("href")
          .catch(() => "")) ?? "";

      expect(
        words.includes(question),
        `the card does not ask ${JSON.stringify(question)}`
      );
      expect(
        href === `/t/${child}`,
        `Open subagent links to ${JSON.stringify(href)}`
      );
      expect(
        !(await overflows(page)),
        "the page scrolls sideways with the card"
      );

      await shot(page, "escalated", width);

      const before = responds.length;
      const option = card(page).locator('[data-option-index="1"]');

      await option.waitFor({ state: "visible", timeout: 10_000 });
      await press(option, width);

      // The last question's pick opens the undo window (3 s), then the answer goes.
      await card(page).waitFor({ state: "hidden", timeout: 10_000 });

      expect(
        responds.length - before === 1,
        `the parent's page sent ${responds.length - before} answers`
      );

      const once = await answeredByUser(
        protocol,
        child,
        asked?.id ?? "",
        options[0]
      );

      expect(
        Option.isNone(once),
        Option.getOrElse(once, () => "")
      );

      const done = await until(
        async () => await rowState(page, child),
        (state) => state === "done",
        10_000
      );

      expect(
        done === "done",
        `once answered the child's row says ${JSON.stringify(done)}`
      );
      expect(
        (await questionCard(page).count()) === 0,
        "the parent still shows the question card"
      );

      return `the parent held the question first (record route parent, row "Asked its parent", no card); escalated, it showed as the parent's card with Open subagent; one answer "${options[0]}" reached the child once; record and mirror decided by the user, escalation resolved; the child's row says Done`;
    });
  } finally {
    await context.close();
    await app.stop();
  }
};

const browser = await chromium.launch();

try {
  for (const width of widths) {
    await runWidth(browser, width);
  }
} finally {
  await browser.close();
}

const passing = results.filter((result) => result.pass).length;

mkdirSync(values.out, { recursive: true });

writeFileSync(
  path.join(
    values.out,
    broken === ""
      ? "subagent-flows.json"
      : `subagent-flows-broken-${broken}.json`
  ),
  `${JSON.stringify({ judge: "subagent-flows", broken, passing, checks: results.length, results }, null, 2)}\n`
);

console.log(
  JSON.stringify({
    judge: "subagent-flows",
    broken,
    checks: results.length,
    passing,
    failing: results.flatMap((result) =>
      result.pass ? [] : [`${result.check}@${result.width}`]
    ),
  })
);

process.exit(results.length > 0 && passing === results.length ? 0 : 1);
