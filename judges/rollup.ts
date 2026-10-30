/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one step after another, on purpose */
// The rollup judge (plan 6D, the behaviour script `rollup`; surfaces note "Judges", S6; ADR 0027's
// gate played through the page): the real web client on the `next` views over a real
// in-process brain on the scripted harness (judges/fixtures/parity/CairnApp.ts with the delegating
// model of judges/fixtures/subagents/RollupBrain.ts), its seeded thread the project thread, at
// 390 px as a phone (touch, coarse pointer) and at 1,440 px, each width on a fresh brain. No model
// provider is called.
//
//   node judges/rollup.ts [--width 390,1440] [--broken banner|lit] [--out <dir>]
//
// One run per width, in order, each step judged on what the page shows. Each child is spawned by a
// message to the parent and started by Go through the protocol, as the brief card will send it.
//   approval      a child's gated tool call lights its ancestors: the parent's page says "Subagent
//                 needs approval" in the banner above the composer, naming the child as a link, the
//                 parent's header says "Approval" (and at 1,440 its sidebar row and the child's
//                 row do too), and the parent shows no card of its own; the page does not scroll
//                 sideways, and on the phone "Open approval" is at least 44 px tall; it opens the
//                 child, whose card Approve answers once; back on the parent the banner is gone;
//   parent-first  a child's question goes to the parent's model first: while the parent holds it,
//                 the parent's page never shows the banner, a card or "Input", and the child's row
//                 says "Asked its parent"; once the parent answers, the child goes on, its record
//                 decided by the parent's thread, and the user was never asked;
//   in-parent     the gate's second half: a question the parent escalates shows as the parent's
//                 own card (the banner stays hidden while it does), with "Open subagent" linking
//                 the child; picking an option in the parent's page sends one answer, the child
//                 hears it, both records and the escalation settle, and a second answer to the
//                 child's record changes nothing;
//   in-child      an escalated question answered on the child's own page (reached from the
//                 parent's card) resolves the parent's card once: one answer sent, the parent's
//                 mirror settled, and a second answer to it changes nothing.
// (`thread.respond` on a settled record succeeds and changes nothing, as the seam's `respond`
// says; "answered once" is judged on the records and on what the child heard.)
//
// Broken controls, each planted in the page by this judge (never in the app), each of which must
// make the step it names fail:
//   banner  the parent banner is removed whenever it is drawn (approval);
//   lit     the shell stream reads as before 6D's server change: a child whose question is with
//           its parent arrives as asking the user (parent-first).
// Each width leaves screenshots in the out folder for the user's round: the parent with the
// banner, and the parent with an escalated question's card.
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
import type { Entry } from "@cairn/protocol/Thread";
import { Effect, Exit, Option, Predicate, Schema, Stream } from "effect";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Locator, Page } from "playwright";

import { PARITY_THREAD_ID, startCairn } from "./fixtures/parity/CairnApp.ts";
import {
  CHILD_HEARD,
  CHILDREN,
  holdParent,
  releaseParent,
  rollupBrain,
} from "./fixtures/subagents/RollupBrain.ts";
import * as ProtocolClient from "./lib/ProtocolClient.ts";

const BROKEN_CONTROLS = ["banner", "lit"] as const;

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

// The parent banner is removed whenever it is drawn.
const plantBanner = () => {
  new MutationObserver(() => {
    for (const banner of document.querySelectorAll(
      '[data-testid="parent-banner"]'
    )) {
      banner.remove();
    }
  }).observe(document, { subtree: true, childList: true });
};

// The shell stream as the brain sent it before 6D: a child whose question is with its parent reads
// as asking the user. Page code, kept as text: it patches the browser's own MessageEvent, which this
// module's types cannot describe without casts.
const PLANT_LIT = `
  const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data").get;
  Object.defineProperty(MessageEvent.prototype, "data", {
    configurable: true,
    get() {
      const raw = data.call(this);
      return typeof raw === "string"
        ? raw.replaceAll(
            '"waitingFor":"parent","pendingRuntimeRequest":null',
            '"waitingFor":"none","pendingRuntimeRequest":{"id":"apr_planted","kind":"user-input","createdAt":"2026-10-30T00:00:00.000Z","origin":null}'
          )
        : raw;
    },
  });
`;

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

  if (broken === "banner") {
    await context.addInitScript(plantBanner);
  }

  if (broken === "lit") {
    await context.addInitScript({ content: PLANT_LIT });
  }

  return context;
};

/** Saves what the page shows, for the user's round or beside a failed step's report. */
const shot = async (page: Page, name: string, width: number) => {
  mkdirSync(values.out, { recursive: true });
  await page
    .screenshot({ path: path.join(values.out, `rollup-${name}-${width}.png`) })
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

const banner = (page: Page) => page.locator('[data-testid="parent-banner"]');

const card = (page: Page) => page.locator('[data-testid="request-card"]');

/** The card once it shows a question (a brief's card may still be leaving after Go). */
const questionCard = (page: Page) =>
  page.locator('[data-testid="request-card"][data-request-body="Question"]');

const editor = (page: Page) =>
  page.locator('[data-testid="composer-editor"]').first();

/** The open thread's status word in the chat header (drawn at every width, shown from `sm`). */
const headerWord = async (page: Page) =>
  (
    (await page
      .locator('[data-testid="next-header-status"]')
      .first()
      .textContent()
      .catch(() => "")) ?? ""
  ).trim();

/** A sidebar row's status word, at 1,440 px where the column shows; none on the phone. */
const rowWord = async (page: Page, title: Option.Option<string>) => {
  const row = Option.match(title, {
    onNone: () => page.locator('[data-testid="shell-project-thread"]'),
    onSome: (name) =>
      page
        .locator('[data-testid="shell-managed-thread"]')
        .filter({ hasText: name }),
  });

  return (
    (await row
      .first()
      .locator('[data-testid="shell-status"]')
      .getAttribute("title", { timeout: 2000 })
      .catch(() => "")) ?? ""
  );
};

/** Whether the page scrolls sideways. */
const overflows = async (page: Page) =>
  await page.evaluate(() => {
    const scroller = document.scrollingElement;

    return scroller !== null && scroller.scrollWidth > scroller.clientWidth + 1;
  });

/** What a thread's stream starts from: its decision records and its transcript. */
interface ThreadRead {
  readonly records: ReadonlyArray<ApprovalRecord>;
  readonly escalations: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<Entry>;
}

/** The part of a parent's `cairn.escalations` the judge reads: where each entry stands. */
const Escalations = Schema.Struct({
  items: Schema.Record(Schema.String, Schema.Struct({ status: Schema.String })),
});

const decodeEscalations = Schema.decodeUnknownOption(Escalations);

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
            escalations: Option.match(
              decodeEscalations(docs["cairn.escalations"]),
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

  /** Answers one request; the failure's words when the brain refused it. */
  const respond = async (
    threadId: string,
    approvalId: string,
    answers: Option.Option<
      ReadonlyArray<{
        index: number;
        picks: ReadonlyArray<string>;
        custom: string | null;
      }>
    >
  ): Promise<Option.Option<string>> =>
    await withClient((client) =>
      Effect.map(
        Effect.exit(
          client["thread.respond"]({
            threadId: ThreadId.make(threadId),
            approvalId: ApprovalId.make(approvalId),
            decision: "accept",
            reason: Option.none(),
            answers,
            launch: Option.none(),
          })
        ),
        (exit) =>
          Exit.isSuccess(exit)
            ? Option.none()
            : Option.some(JSON.stringify(exit.cause))
      )
    );

  /** The first of a thread's records `found` matches. */
  const findRecord = async (
    threadId: string,
    found: (record: ApprovalRecord) => boolean
  ): Promise<ApprovalRecord | undefined> => {
    const { records } = await read(threadId);

    return records.find(found);
  };

  /** Whether any of a thread's entries `found` matches. */
  const someEntry = async (
    threadId: string,
    found: (entry: Entry) => boolean
  ): Promise<boolean> => {
    const { entries } = await read(threadId);

    return entries.some(found);
  };

  return { read, respond, findRecord, someEntry };
};

type Protocol = ReturnType<typeof protocolOf>;

const textOfEntry = (entry: Entry): string => JSON.stringify(entry.model ?? []);

/** Answers Go on the pending brief for `description`, then waits for its child; the child's id. */
const goOn = async (
  protocol: Protocol,
  description: string
): Promise<string> => {
  const brief = await until(
    async () =>
      await protocol.findRecord(
        PARITY_THREAD_ID,
        (found) =>
          found.kind === "brief" &&
          found.payload?.type === "brief" &&
          found.payload.title === description
      ),
    (found) => found !== undefined,
    15_000
  );

  expect(brief !== undefined, `no brief for "${description}" was asked`);

  if (brief?.status === "pending") {
    const refused = await protocol.respond(
      PARITY_THREAD_ID,
      brief.id,
      Option.none()
    );

    expect(
      Option.isNone(refused),
      `Go was refused: ${Option.getOrElse(refused, () => "")}`
    );
  }

  const started = await until(
    async () => {
      const found = await protocol.findRecord(
        PARITY_THREAD_ID,
        (each) => each.id === brief?.id
      );

      return found?.started?.childThreadId ?? "";
    },
    (child) => child !== "",
    15_000
  );

  expect(started !== "", `the brief "${description}" started no child`);

  return started;
};

/**
 * Why the child's question was not answered exactly once with `pick`, after a moment for a second
 * answer to land: its record and the parent's mirror must both keep `pick`, and the child must have
 * heard one answer. None when it was.
 */
const answeredOnce = async (
  protocol: Protocol,
  child: string,
  pick: string
): Promise<Option.Option<string>> => {
  await sleep(1000);

  const [own, parent] = [
    await protocol.read(child),
    await protocol.read(PARITY_THREAD_ID),
  ];

  const question = own.records.find((found) => found.kind === "user-input");

  const mirror = parent.records.find(
    (found) => found.mirrorOf?.threadId === child
  );

  const picks = [question, mirror].map((found) =>
    (found?.answer?.answers?.[0]?.picks ?? []).join(",")
  );

  // The asking tool's results: the child's "Child heard: ..." answer repeats the words.
  const heard = own.entries.filter(
    (entry) =>
      entry.kind === "pi.tool-result" &&
      textOfEntry(entry).includes("The user answered:")
  ).length;

  if (picks.some((found) => found !== pick)) {
    return Option.some(
      `the records hold ${JSON.stringify(picks)}, not "${pick}"`
    );
  }

  return heard === 1
    ? Option.none()
    : Option.some(`the child heard ${heard} answers`);
};

/** Taps on the phone, clicks on a desktop. */
const press = async (target: Locator, width: number) => {
  await (width < 640 ? target.tap() : target.click());
};

/** Sends the parent a message from the page's composer. */
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

/** Picks option `index` (1-based) on the card's question and waits for its answer to go. */
const pickOption = async (page: Page, width: number, index: number) => {
  const option = card(page).locator(`[data-option-index="${index}"]`);

  await option.waitFor({ state: "visible", timeout: 10_000 });

  await press(option, width);

  // The last question's pick opens the undo window (3 s), then the answer goes.
  await card(page).waitFor({ state: "hidden", timeout: 10_000 });
};

/** One width's run: every step in order, each recorded on its own. */
const runWidth = async (browser: Browser, width: number) => {
  holdParent();

  const app = await startCairn(
    { projectTitle: "Cairn", threadTitle: PARENT_TITLE, entries: [] },
    {
      brain: rollupBrain,
      // A shell seed makes the seeded thread its project's project thread, so the sidebar lists it
      // with the children it manages; no seeded managed rows.
      shell: { managed: [], projects: [{ title: "myr", favicon: false }] },
    }
  );

  const brainUrl = process.env.CAIRN_DEV_BRAIN ?? "";
  const protocol = protocolOf(brainUrl, app.origin);
  const parentUrl = new URL(app.threadUrl);

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
    await openParent();

    await step("approval", async () => {
      const { description } = CHILDREN.approval;

      await send(page, `delegate: ${description}`);

      const child = await goOn(protocol, description);

      const shown = await until(
        async () => await banner(page).count(),
        (count) => count === 1,
        15_000
      );

      expect(
        shown === 1,
        "no banner showed while the child asked for approval"
      );

      const title = (
        (await banner(page)
          .locator('[data-slot="parent-banner-title"]')
          .textContent()) ?? ""
      ).trim();

      const kind = await banner(page).getAttribute("data-request");

      const named = await banner(page)
        .locator('[data-testid="parent-banner-child"]')
        .allTextContents();

      const opens = banner(page).locator('[data-testid="parent-banner-open"]');

      const header = await until(
        async () => await headerWord(page),
        (word) => word === "Approval",
        5000
      );

      expect(
        title === "Subagent needs approval",
        `the banner reads ${JSON.stringify(title)}`
      );
      expect(kind === "approval", `the banner asks for ${kind ?? "nothing"}`);
      expect(
        named.join("|") === description,
        `the banner names ${JSON.stringify(named)}`
      );
      expect(
        ((await opens.textContent()) ?? "").trim() === "Open approval",
        "the banner's action is not Open approval"
      );
      expect(
        header === "Approval",
        `the parent's header says ${JSON.stringify(header)}`
      );

      // The brief's card leaves once the stream shows Go; nothing takes its place.
      const cards = await until(
        async () => await card(page).count(),
        (count) => count === 0,
        3000
      );

      expect(cards === 0, "the parent shows a card for its child's approval");

      let rows = "sidebar rows not drawn at 390";

      if (width >= 640) {
        const parentRow = await rowWord(page, Option.none());
        const childRow = await rowWord(page, Option.some(description));

        expect(
          parentRow === "Approval" && childRow === "Approval",
          `the sidebar rows say ${JSON.stringify([parentRow, childRow])}`
        );
        rows = `rows "${parentRow}", "${childRow}"`;
      }

      if (width < 640) {
        const box = await opens.boundingBox();
        const height = box?.height ?? 0;

        expect(height >= 43.5, `Open approval is ${height} px tall`);
      }

      expect(
        !(await overflows(page)),
        "the parent's page scrolls sideways with the banner up"
      );

      await shot(page, "banner", width);

      // Open approval: the child's own card answers it.
      const before = responds.length;

      await press(opens, width);

      await page.waitForURL(`**/t/${child}*`, { timeout: 10_000 });
      await card(page)
        .locator('[data-action="approve"]')
        .waitFor({ state: "visible", timeout: 10_000 });
      await card(page).locator('[data-action="approve"]').click();
      await card(page).waitFor({ state: "hidden", timeout: 10_000 });

      const heard = await until(
        async () =>
          await protocol.someEntry(child, (entry) =>
            textOfEntry(entry).includes(CHILD_HEARD)
          ),
        Boolean,
        10_000
      );

      expect(heard, "the child did not go on after Approve");
      expect(
        responds.length - before === 1,
        `Approve sent ${responds.length - before} answers`
      );

      await openParent();

      const gone = await until(
        async () => await banner(page).count(),
        (count) => count === 0,
        10_000
      );

      const after = await headerWord(page);

      expect(
        gone === 0,
        "the banner stayed after the child's approval was answered"
      );
      expect(after !== "Approval", `the parent's header still says ${after}`);

      return `"${title}" (${rows}, header "${header}"), Open approval opened the child, one Approve, the banner left`;
    });

    await step("parent-first", async () => {
      const { description } = CHILDREN.parentFirst;

      await send(page, `delegate: ${description}`);

      const child = await goOn(protocol, description);

      // The question is with the parent once the child's record names it for the parent.
      const asked = await until(
        async () =>
          await protocol.findRecord(
            child,
            (found) => found.kind === "user-input"
          ),
        (found) => found?.status === "pending" && found.route === "parent",
        15_000
      );

      expect(
        asked !== undefined,
        "the child's question never reached its parent"
      );

      let childRow = "not drawn at 390";

      if (width >= 640) {
        childRow = await until(
          async () => await rowWord(page, Option.some(description)),
          (word) => word === "Asked its parent",
          5000
        );
        expect(
          childRow === "Asked its parent",
          `the child's row says ${JSON.stringify(childRow)}`
        );
      }

      // For 1.5 s while the parent holds the question: no banner, no card, no request word.
      const seen = new Set<string>();
      const end = Date.now() + 1500;

      while (Date.now() < end) {
        if ((await banner(page).count()) > 0) {
          seen.add("banner");
        }

        if ((await card(page).count()) > 0) {
          seen.add("card");
        }

        const word = await headerWord(page);

        if (word === "Input" || word === "Approval") {
          seen.add(`header ${word}`);
        }

        if (width >= 640) {
          const parentRow = await rowWord(page, Option.none());

          if (parentRow === "Input" || parentRow === "Approval") {
            seen.add(`row ${parentRow}`);
          }
        }

        await sleep(100);
      }

      expect(
        seen.size === 0,
        `while the parent held the question the page showed ${[...seen].join(", ")}`
      );

      releaseParent();

      const answered = await until(
        async () =>
          await protocol.findRecord(child, (found) => found.id === asked?.id),
        (found) => found?.status === "accepted",
        15_000
      );

      expect(
        answered?.status === "accepted" &&
          answered.decidedBy?.kind === "thread",
        `the question ended ${JSON.stringify([answered?.status, answered?.decidedBy])}`
      );
      expect(
        (await banner(page).count()) === 0 && (await card(page).count()) === 0,
        "the banner or a card showed once the parent answered"
      );

      const parent = await protocol.read(PARITY_THREAD_ID);

      expect(
        !parent.records.some((found) => found.mirrorOf !== null),
        "the question reached the user's card in the parent"
      );

      return `held 1.5 s with nothing lit (child row "${childRow}"), answered by the parent's thread`;
    });

    // A failed step above leaves the parent free for the next one.
    releaseParent();

    await step("in-parent", async () => {
      const { description, options } = CHILDREN.inParent;

      await send(page, `delegate: ${description}`);

      const child = await goOn(protocol, description);

      await questionCard(page).waitFor({ state: "visible", timeout: 15_000 });

      const body = await card(page).getAttribute("data-request-body");
      const words = ((await card(page).textContent()) ?? "").trim();
      const link = card(page).locator('[data-testid="request-card-subagent"]');
      const href = (await link.getAttribute("href").catch(() => "")) ?? "";

      const header = await until(
        async () => await headerWord(page),
        (word) => word === "Input",
        5000
      );

      expect(
        body === "Question",
        `the parent's card body is ${body ?? "none"}`
      );
      expect(
        words.includes(CHILDREN.inParent.question),
        `the card does not ask ${JSON.stringify(CHILDREN.inParent.question)}`
      );
      expect(
        href === `/t/${child}`,
        `Open subagent links to ${JSON.stringify(href)}`
      );
      expect(
        (await banner(page).count()) === 0,
        "the banner showed beside the parent's own card"
      );
      expect(
        header === "Input",
        `the parent's header says ${JSON.stringify(header)}`
      );

      await shot(page, "escalated", width);

      const before = responds.length;

      await pickOption(page, width, 1);

      const settled = await until(
        async () =>
          await protocol.findRecord(
            child,
            (found) => found.kind === "user-input"
          ),
        (found) => found?.status === "accepted",
        10_000
      );

      const heard = await until(
        async () =>
          await protocol.someEntry(child, (entry) =>
            textOfEntry(entry).includes(`The user answered: ${options[0]}`)
          ),
        Boolean,
        10_000
      );

      const parent = await protocol.read(PARITY_THREAD_ID);

      const mirror = parent.records.find(
        (found) => found.mirrorOf?.threadId === child
      );

      expect(
        responds.length - before === 1,
        `the parent's page sent ${responds.length - before} answers`
      );
      expect(
        settled?.decidedBy?.kind === "user",
        `the child's record was decided by ${settled?.decidedBy?.kind ?? "nobody"}`
      );
      expect(heard, `the child did not hear "${options[0]}"`);
      expect(
        mirror?.status === "accepted",
        `the mirror is ${mirror?.status ?? "missing"}`
      );
      expect(
        parent.escalations.every((status) => status === "resolved"),
        `the escalations are ${parent.escalations.join(", ")}`
      );

      // A second answer, from the other thread, changes nothing (ADR 0027: resolved once).
      await protocol.respond(
        child,
        settled?.id ?? "",
        Option.some([{ index: 0, picks: [options[1]], custom: null }])
      );

      const once = await answeredOnce(protocol, child, options[0]);

      expect(
        Option.isNone(once),
        Option.getOrElse(once, () => "")
      );

      return `the parent's own card (header "${header}", Open subagent to the child, no banner); one answer "${options[0]}" reached the child; a second answer from the child's thread changed nothing`;
    });

    await step("in-child", async () => {
      const { description, options } = CHILDREN.inChild;

      await send(page, `delegate: ${description}`);

      const child = await goOn(protocol, description);

      await questionCard(page).waitFor({ state: "visible", timeout: 15_000 });

      const link = card(page).locator('[data-testid="request-card-subagent"]');

      await press(link, width);

      await page.waitForURL(`**/t/${child}*`, { timeout: 10_000 });

      const before = responds.length;

      await pickOption(page, width, 2);

      const parent = await until(
        async () => await protocol.read(PARITY_THREAD_ID),
        (found) =>
          found.records.some(
            (each) =>
              each.mirrorOf?.threadId === child && each.status === "accepted"
          ),
        10_000
      );

      const mirror = parent.records.find(
        (found) => found.mirrorOf?.threadId === child
      );

      expect(
        responds.length - before === 1,
        `the child's page sent ${responds.length - before} answers`
      );
      expect(
        mirror?.status === "accepted",
        `the mirror is ${mirror?.status ?? "missing"}`
      );

      await protocol.respond(
        PARITY_THREAD_ID,
        mirror?.id ?? "",
        Option.some([{ index: 0, picks: [options[0]], custom: null }])
      );

      const once = await answeredOnce(protocol, child, options[1]);

      expect(
        Option.isNone(once),
        Option.getOrElse(once, () => "")
      );

      await openParent();
      await sleep(500);

      const pending = await card(page)
        .locator('[data-action="send"], [data-option-index]')
        .count();

      expect(pending === 0, "the parent still offers the answered question");
      expect(
        (await banner(page).count()) === 0,
        "the banner showed after the question was answered"
      );

      return `answered on the child's page ("${options[1]}"), one answer sent; the parent's mirror settled once; a second answer from the parent's thread changed nothing`;
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
    broken === "" ? "rollup.json" : `rollup-broken-${broken}.json`
  ),
  `${JSON.stringify({ judge: "rollup", broken, passing, checks: results.length, results }, null, 2)}\n`
);

console.log(
  JSON.stringify({
    judge: "rollup",
    broken,
    checks: results.length,
    passing,
    failing: results.flatMap((result) =>
      result.pass ? [] : [`${result.check}@${result.width}`]
    ),
  })
);

process.exit(results.length > 0 && passing === results.length ? 0 : 1);
