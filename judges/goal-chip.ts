/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one step after another, on purpose */
// The goal chip judge (plan 6H, the behaviour script `goal-chip`; ADR 0026, briefs note B6): the
// real web client on the `next` views (`?ui=next`) over a real in-process brain on the scripted
// harness (judges/fixtures/parity/CairnApp.ts), its project thread given the goal of
// judges/fixtures/surfaces/GoalBrain.ts, at 390 px as a phone (touch, coarse pointer) and at
// 1,440 px, each width on a fresh brain. No model provider is called.
//
//   node judges/goal-chip.ts [--width 390,1440] [--broken mark|count|state] [--out <dir>]
//
// The goal is bound as the user binds one (`goal.setCriteria`'s service) and every verdict is the
// verdict writer's: the tests command ran (met), the model judge of another family said not met,
// the user's and lint's criteria are open. Each step is judged on what the page shows and on what
// the brain holds.
//   goal-chip  the chat header's chip reads "1 of 4 met, 1 not met" ("1/4" on a phone) and the
//              project thread's sidebar row "1/4 met". The chip opens the goal panel: at 1,440 a
//              column beside the chat column, at 390 a bottom sheet over a scrim, its controls at
//              least 44 px. The criteria read met, not met, open, open, each as the brain holds
//              it, with their judges (command, model, user, command); the met one shows its exit
//              code and output, the failed one the judge's model and reply; only the user's
//              criterion offers Met and Not met. Nothing scrolls sideways.
//   mark       Met on the user's criterion reaches the verdict writer: the brain holds it met with
//              a user verdict, then the page says so and the chip reads "2 of 4 met, 1 not met".
//              Through the protocol, a mark on lint (a command judges it) and on a criterion the
//              goal does not hold are refused InvalidInput, and so is binding a model judge on the
//              thread's own model; the goal is unchanged by all three.
//   verdict    the lint command runs in the brain and its verdict reaches the open page with no
//              reload: lint reads met with its output, the chip "3 of 4 met, 1 not met". After a
//              reload the chip and the sidebar row still say so.
//   clear      the goal's criteria taken away, the chip and the sidebar row's tally go.
//
// Broken controls, each planted in the page by this judge (never in the app), each of which must
// make the step it names fail:
//   mark   a click on Met never reaches the app, and the row claims met anyway (mark);
//   count  the chip's count always reads "4 of 4 met" (goal-chip);
//   state  every criterion row claims to be met (goal-chip).
// Each width leaves screenshots in the out folder for the user's round: the panel at the start and
// after the lint verdict.
// Exits 0 when every step passed; a broken control's run exits 1 when it failed rightly, and the
// JSON line names the failing steps.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { ThreadId } from "@cairn/protocol/Ids";
import { RoleSpec } from "@cairn/protocol/Roles";
import { Effect, Option, Predicate } from "effect";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import { ScriptedGoals } from "../apps/server/src/brain/ScriptedHarness.ts";
import {
  PARITY_THREAD_ID,
  SHELL_SEED,
  startCairn,
} from "./fixtures/parity/CairnApp.ts";
import type { CairnApp } from "./fixtures/parity/CairnApp.ts";
import {
  clearGoal,
  CRITERIA,
  goalRecords,
  JUDGE_MODEL,
  runCommandJudge,
  seedGoal,
} from "./fixtures/surfaces/GoalBrain.ts";
import * as ProtocolClient from "./lib/ProtocolClient.ts";

const BROKEN_CONTROLS = ["mark", "count", "state"] as const;

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

const THREAD_TITLE = "Plan the parser";

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

// A click on Met never reaches the app, and the row claims met anyway.
const plantMark = () => {
  // The page's own claim, never a verdict: the brain still holds the criterion open.
  const claim = "met";

  document.addEventListener(
    "click",
    (event) => {
      const target =
        event.target instanceof Element
          ? event.target.closest('[data-testid="goal-mark-met"]')
          : null;

      if (target === null) {
        return;
      }

      event.stopImmediatePropagation();
      event.preventDefault();

      const row = target.closest<HTMLElement>('[data-testid="goal-criterion"]');

      if (row !== null) {
        row.dataset.state = claim;
      }
    },
    { capture: true }
  );
};

// The chip's count always reads "4 of 4 met".
const plantCount = () => {
  new MutationObserver(() => {
    for (const count of document.querySelectorAll(
      '[data-slot="goal-chip-count"] span'
    )) {
      const text = count.textContent ?? "";
      const lie = text.includes("of") ? "4 of 4 met" : "4/4";

      if (text !== lie) {
        count.textContent = lie;
      }
    }
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  });
};

// Every criterion row says it is met, whatever its verdict.
const plantState = () => {
  const claim = "met";

  new MutationObserver(() => {
    for (const row of document.querySelectorAll<HTMLElement>(
      '[data-testid="goal-criterion"]'
    )) {
      if (row.dataset.state !== claim) {
        row.dataset.state = claim;
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true });
};

const PLANTS: Readonly<Record<Exclude<Broken, "">, () => void>> = {
  mark: plantMark,
  count: plantCount,
  state: plantState,
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

  if (broken !== "") {
    await context.addInitScript(PLANTS[broken]);
  }

  return context;
};

/** Saves what the page shows, for the user's round or beside a failed step's report. */
const shot = async (page: Page, name: string, width: number) => {
  mkdirSync(values.out, { recursive: true });
  await page
    .screenshot({
      path: path.join(values.out, `goal-chip-${name}-${width}.png`),
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

const chip = (page: Page) => page.locator('[data-testid="goal-chip"]');

const panel = (page: Page) => page.locator('[data-testid="goal-panel"]');

/** The chip's words as drawn at this width (one of its two spans is hidden by a breakpoint). */
const chipText = async (page: Page) =>
  (await chip(page).count()) === 0
    ? ""
    : await chip(page)
        .locator('[data-slot="goal-chip-count"]')
        .evaluate((count) =>
          [...count.querySelectorAll("span")]
            .flatMap((span) =>
              span.getBoundingClientRect().width > 0
                ? [span.textContent ?? ""]
                : []
            )
            .join("")
            .trim()
        );

/** Each criterion as `text=state`, in the order the panel lists them. */
const pageCriteria = async (page: Page) =>
  await page.locator('[data-testid="goal-criterion"]').evaluateAll((rows) =>
    rows.map((row) => {
      const text =
        row.querySelector('[data-slot="goal-criterion-text"]')?.textContent ??
        "";

      return `${text}=${row instanceof HTMLElement ? (row.dataset.state ?? "") : ""}`;
    })
  );

/** Each criterion's judge kind, in order. */
const pageJudges = async (page: Page) =>
  await page
    .locator('[data-testid="goal-criterion"]')
    .evaluateAll((rows) =>
      rows.map((row) =>
        row instanceof HTMLElement ? (row.dataset.judge ?? "") : ""
      )
    );

const criterionRow = (page: Page, text: string) =>
  page
    .locator('[data-testid="goal-criterion"]')
    .filter({ hasText: text })
    .first();

/** The brain's criteria as `text=state`, in order. */
const brainCriteria = async (app: CairnApp) => {
  const records = await app.inBrain(goalRecords);

  return records.map((criterion) => `${criterion.text}=${criterion.state}`);
};

/** Whether the page scrolls sideways. */
const overflows = async (page: Page) =>
  await page.evaluate(() => {
    const scroller = document.scrollingElement;

    return scroller !== null && scroller.scrollWidth > scroller.clientWidth + 1;
  });

/** Every control in the panel narrower or shorter than `minimum` px. */
const smallTargets = async (page: Page, minimum: number) =>
  await panel(page).evaluate((element, least) => {
    const controls = element.querySelectorAll("a[href], button");

    return [...controls].flatMap((control) => {
      const box = control.getBoundingClientRect();

      return box.width > 0 &&
        (box.width < least - 0.5 || box.height < least - 0.5)
        ? [
            `${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim().slice(0, 30)} ${box.width.toFixed(0)}x${box.height.toFixed(0)}`,
          ]
        : [];
    });
  }, minimum);

/** The panel's and the chat column's boxes, and whether the scrim shows. */
const placement = async (page: Page) =>
  await page.evaluate(() => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page code: it runs in the browser, where nothing outside this callback exists
    const boxOf = (selector: string) => {
      const element = document.querySelector(selector);

      if (element === null) {
        return null;
      }

      const box = element.getBoundingClientRect();

      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    };

    const scrim = document.querySelector('[data-testid="goal-scrim"]');

    return {
      panel: boxOf('[data-testid="goal-panel"]'),
      column: boxOf('[data-chat-column="true"]'),
      viewport: { width: innerWidth, height: innerHeight },
      scrim:
        scrim !== null && scrim.getBoundingClientRect().width > 0
          ? "shown"
          : "hidden",
    };
  });

const reload = async (page: Page) => {
  await page.reload({ waitUntil: "networkidle" });
  await page
    .locator('#root[data-ui="next"]')
    .waitFor({ state: "attached", timeout: 15_000 });
};

/** The project thread's goal tally in the sidebar; on a phone the sheet is opened, then the page reloaded. */
const sidebarTally = async (page: Page, isPhone: boolean) => {
  if (isPhone) {
    await page
      .getByRole("button", { name: "Toggle main sidebar" })
      .first()
      .click();
    await page
      .getByTestId("sidebar-sheet")
      .waitFor({ state: "attached", timeout: 5000 });
  }

  const scope = page.getByTestId(isPhone ? "sidebar-sheet" : "shell-column");

  await scope
    .getByTestId("shell-project-thread")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });

  const tally = scope.getByTestId("shell-goal-tally");

  const text =
    (await tally.count()) === 0
      ? ""
      : ((await tally.first().textContent()) ?? "").trim();

  if (isPhone) {
    await reload(page);
  }

  return text;
};

const openPanel = async (page: Page) => {
  await chip(page).waitFor({ state: "visible", timeout: 15_000 });

  if ((await chip(page).getAttribute("aria-expanded")) !== "true") {
    await chip(page).click();
  }

  await panel(page).waitFor({ state: "visible", timeout: 5000 });
};

/** What a protocol call failed with: its error's tag and field, or "ok". */
const outcomeOf = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<string> =>
  effect.pipe(
    Effect.match({
      onSuccess: () => "ok",
      onFailure: (failure) => {
        const tag = Predicate.hasProperty(failure, "_tag")
          ? String(failure._tag)
          : "failed";

        const field =
          Predicate.hasProperty(failure, "field") &&
          Option.isOption(failure.field)
            ? Option.getOrElse(
                Option.map(failure.field, (name) => `(${String(name)})`),
                () => ""
              )
            : "";

        return `${tag}${field}`;
      },
    })
  );

/**
 * The refusals, through the protocol as a client sends them: a mark on a command's criterion, a
 * mark on a criterion the goal does not hold, and a model judge on the thread's own model.
 */
const refusals = async (
  brainUrl: string,
  origin: string,
  lintId: string,
  ownModel: string
) =>
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

        const threadId = ThreadId.make(PARITY_THREAD_ID);

        const command = yield* outcomeOf(
          client["goal.mark"]({
            threadId,
            criterionId: lintId,
            ok: true,
            note: Option.none(),
          })
        );

        const unknown = yield* outcomeOf(
          client["goal.mark"]({
            threadId,
            criterionId: "c99",
            ok: true,
            note: Option.none(),
          })
        );

        const sameModel = yield* outcomeOf(
          client["goal.setCriteria"]({
            threadId,
            objective: Option.none(),
            criteria: [
              {
                text: "Graded by the thread's own model",
                judge: {
                  kind: "model",
                  spec: RoleSpec.make(ownModel),
                  rubric: "Anything",
                },
              },
            ],
          })
        );

        return { command, unknown, sameModel };
      })
    )
  );

/** The thread's own model as a literal spec, `provider/modelId`. */
const ownModelOf = async (app: CairnApp) =>
  await app.inBrain(
    ScriptedGoals.use((goals) =>
      Effect.map(goals.thread(PARITY_THREAD_ID), (found) =>
        Option.match(found, {
          onNone: () => "",
          onSome: ({ model }) => `${model.provider}/${model.modelId}`,
        })
      )
    )
  );

/** Each criterion's words, as the panel and the brain name it. */
const [TESTS, README, MESSAGES, LINT] = [
  CRITERIA.tests.text,
  CRITERIA.readme.text,
  CRITERIA.messages.text,
  CRITERIA.lint.text,
];

/** One width's run: every step in order, each recorded on its own. */
const runWidth = async (browser: Browser, width: number) => {
  // The shell seed makes the thread its project's project thread, with its running list (5H).
  const app = await startCairn(
    { projectTitle: "Cairn", threadTitle: THREAD_TITLE, entries: [] },
    { shell: SHELL_SEED }
  );

  const brainUrl = process.env.CAIRN_DEV_BRAIN ?? "";
  const threadUrl = new URL(app.threadUrl);

  threadUrl.searchParams.set("ui", "next");

  const context = await newDevice(browser, width);
  const page = await context.newPage();
  const isPhone = width < 640;
  const minimum = isPhone ? 44 : 28;

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

  /** What the chip should say for `met` of 4 with one not met, at this width. */
  const chipWords = (met: number) =>
    isPhone ? `${String(met)}/4` : `${String(met)} of 4 met, 1 not met`;

  try {
    await app.inBrain(seedGoal);
    await page.goto(threadUrl.href, { waitUntil: "networkidle" });
    await page
      .locator('#root[data-ui="next"]')
      .waitFor({ state: "attached", timeout: 15_000 });

    await step("goal-chip", async () => {
      const words = await until(
        async () => await chipText(page),
        (seen) => seen === chipWords(1),
        15_000
      );

      expect(
        words === chipWords(1),
        `the goal chip reads ${JSON.stringify(words)}`
      );
      expect(
        (await chip(page).getAttribute("data-state")) === "failed",
        "the chip's mark does not say a criterion failed"
      );

      const tally = await sidebarTally(page, isPhone);

      expect(
        tally === "1/4 met",
        `the project thread's row reads ${JSON.stringify(tally)}`
      );

      await openPanel(page);

      const where = await placement(page);
      const box = where.panel;
      const { column } = where;

      expect(
        box !== null && column !== null,
        "the panel or the chat column is missing"
      );

      if (box !== null && column !== null) {
        if (isPhone) {
          expect(
            Math.abs(box.bottom - where.viewport.height) <= 1 &&
              box.width >= where.viewport.width - 1 &&
              box.top > 0,
            `the phone's panel is not a bottom sheet: ${JSON.stringify(box)}`
          );
          expect(where.scrim === "shown", "the sheet has no scrim");
        } else {
          expect(
            box.left >= column.right - 1 &&
              box.height >= where.viewport.height - 2 &&
              box.right <= where.viewport.width + 1,
            `the panel is not a column beside the chat: panel ${JSON.stringify(box)}, column ${JSON.stringify(column)}`
          );
          expect(where.scrim === "hidden", "a scrim covers the desktop page");
        }
      }

      const seen = await pageCriteria(page);
      const held = await brainCriteria(app);

      const expected = [
        `${TESTS}=met`,
        `${README}=failed`,
        `${MESSAGES}=open`,
        `${LINT}=open`,
      ];

      expect(
        JSON.stringify(held) === JSON.stringify(expected),
        `the brain holds ${JSON.stringify(held)}`
      );
      expect(
        JSON.stringify(seen) === JSON.stringify(held),
        `the panel reads ${JSON.stringify(seen)}, the brain holds ${JSON.stringify(held)}`
      );

      const judges = await pageJudges(page);

      expect(
        judges.join(",") === "command,model,user,command",
        `the judges read ${JSON.stringify(judges)}`
      );

      const testsEvidence =
        (await criterionRow(page, TESTS)
          .locator('[data-testid="goal-evidence"]')
          .textContent()) ?? "";

      const readmeRow = (await criterionRow(page, README).textContent()) ?? "";

      expect(
        testsEvidence.includes("12 passed") && testsEvidence.includes("Exit 0"),
        `the tests' evidence reads ${JSON.stringify(testsEvidence)}`
      );
      expect(
        readmeRow.includes(JUDGE_MODEL) && readmeRow.includes("NOT MET"),
        `the model judge's row reads ${JSON.stringify(readmeRow)}`
      );

      const marks = await page.locator('[data-testid="goal-mark-met"]').count();

      const marksOnUser = await criterionRow(page, MESSAGES)
        .locator('[data-testid="goal-mark-met"]')
        .count();

      expect(
        marks === 1 && marksOnUser === 1,
        `Met is offered on ${String(marks)} criteria, ${String(marksOnUser)} of them the user's`
      );

      const small = await smallTargets(page, minimum);

      expect(
        small.length === 0,
        `controls under ${minimum} px: ${small.join("; ")}`
      );
      expect(!(await overflows(page)), "the page scrolls sideways");

      await shot(page, "panel", width);

      return `chip ${JSON.stringify(words)}, row "1/4 met"; ${isPhone ? "a bottom sheet over a scrim" : "a column beside the chat"}; criteria met, not met, open, open as the brain holds them; Met offered only on the user's criterion`;
    });

    await step("mark", async () => {
      await openPanel(page);

      const before = await app.inBrain(goalRecords);

      await criterionRow(page, MESSAGES)
        .locator('[data-testid="goal-mark-met"]')
        .click();

      const held = await until(
        async () => await brainCriteria(app),
        (seen) => seen.includes(`${MESSAGES}=met`),
        10_000
      );

      expect(
        held.includes(`${MESSAGES}=met`),
        `the brain holds ${JSON.stringify(held)} after Met`
      );

      const records = await app.inBrain(goalRecords);

      const marked = records.find((criterion) => criterion.text === MESSAGES);

      expect(
        marked?.verdictJudge === "user",
        `the mark's verdict was decided by ${JSON.stringify(marked?.verdictJudge)}`
      );

      const words = await until(
        async () => await chipText(page),
        (seen) => seen === chipWords(2),
        10_000
      );

      expect(
        words === chipWords(2),
        `after Met the chip reads ${JSON.stringify(words)}`
      );

      const seen = await pageCriteria(page);

      expect(
        JSON.stringify(seen) === JSON.stringify(held),
        `the panel reads ${JSON.stringify(seen)}, the brain holds ${JSON.stringify(held)}`
      );

      const lintId =
        before.find((criterion) => criterion.text === LINT)?.id ?? "";

      const ownModel = await ownModelOf(app);
      const settled = await app.inBrain(goalRecords);
      const refused = await refusals(brainUrl, app.origin, lintId, ownModel);

      expect(
        refused.command === "InvalidInput(criterionId)",
        `a mark on lint answered ${refused.command}`
      );
      expect(
        refused.unknown.startsWith("InvalidInput"),
        `a mark on a criterion the goal does not hold answered ${refused.unknown}`
      );
      expect(
        refused.sameModel === "InvalidInput(criteria[0].judge)",
        `a model judge on the thread's own model (${ownModel}) answered ${refused.sameModel}`
      );

      const after = await app.inBrain(goalRecords);

      expect(
        JSON.stringify(after) === JSON.stringify(settled),
        `the refusals changed the goal: ${JSON.stringify(after)}`
      );

      return `Met reached the verdict writer (a user verdict), then the page and the chip ${JSON.stringify(words)}; refused: lint's mark ${refused.command}, an unknown criterion ${refused.unknown}, a model judge on ${ownModel} ${refused.sameModel}; the goal unchanged`;
    });

    await step("verdict", async () => {
      await openPanel(page);
      await app.inBrain(runCommandJudge("lint"));

      const seen = await until(
        async () => await pageCriteria(page),
        (criteria) => criteria.includes(`${LINT}=met`),
        10_000
      );

      expect(
        seen.includes(`${LINT}=met`),
        `the lint verdict never reached the page: ${JSON.stringify(seen)}`
      );

      const lintEvidence =
        (await criterionRow(page, LINT)
          .locator('[data-testid="goal-evidence"]')
          .textContent()) ?? "";

      expect(
        lintEvidence.includes("0 problems"),
        `lint's evidence reads ${JSON.stringify(lintEvidence)}`
      );

      const words = await until(
        async () => await chipText(page),
        (text) => text === chipWords(3),
        10_000
      );

      expect(
        words === chipWords(3),
        `after lint's verdict the chip reads ${JSON.stringify(words)}`
      );

      await shot(page, "verdict", width);
      await reload(page);

      const reloaded = await until(
        async () => await chipText(page),
        (text) => text === chipWords(3),
        15_000
      );

      expect(
        reloaded === chipWords(3),
        `after a reload the chip reads ${JSON.stringify(reloaded)}`
      );

      const tally = await sidebarTally(page, isPhone);

      expect(
        tally === "3/4 met",
        `after a reload the project thread's row reads ${JSON.stringify(tally)}`
      );

      return `lint's verdict reached the open page (met, "0 problems"), the chip ${JSON.stringify(words)}; after a reload ${JSON.stringify(reloaded)} and the row "3/4 met"`;
    });

    await step("clear", async () => {
      await app.inBrain(clearGoal);

      const gone = await until(
        async () => await chip(page).count(),
        (count) => count === 0,
        10_000
      );

      expect(gone === 0, "the goal chip stays on a thread with no criteria");

      const tally = await sidebarTally(page, isPhone);

      expect(
        tally === "",
        `the project thread's row still reads ${JSON.stringify(tally)}`
      );

      return "with no criteria the chip and the row's tally are gone";
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
    broken === "" ? "goal-chip.json" : `goal-chip-broken-${broken}.json`
  ),
  `${JSON.stringify({ judge: "goal-chip", broken, passing, checks: results.length, results }, null, 2)}\n`
);

console.log(
  JSON.stringify({
    judge: "goal-chip",
    broken,
    checks: results.length,
    passing,
    failing: results.flatMap((result) =>
      result.pass ? [] : [`${result.check}@${result.width}`]
    ),
  })
);

process.exit(results.length > 0 && passing === results.length ? 0 : 1);
