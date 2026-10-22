/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one browser state after another, on purpose */
// The parity capture judge (plans 2D and 4F): captures named states from the installed t3code
// nightly once, into a committed baseline, and the same states from Cairn, for judges/parity.ts
// (pixels) and judges/parity-structure.ts (landmarks) to compare.
//
//   node judges/capture.ts t3 [--group all|sidebar|hero|thread] [--session <storage state>] [--t3 <url>]
//   node judges/capture.ts cairn [--group ...] [--out <dir>]
//
// `t3` refuses to write unless the installed `t3code-nightly-bin` is the version ADR 0015 records
// (D56), and writes judges/fixtures/parity/t3@fe27e8e3/<group>/: one PNG, one HTML and one landmark
// file per state and view, `states.json` (each capture's view, clip and masks) and `version.json`.
// `cairn` drives the same states in Cairn and writes the same files to `--out/<group>/`.
//
// Groups:
// - sidebar (2D): the shelves, the settled shelf open, a search, a hovered row and an open row menu
//   at 1440x900; the shelves, the settled shelf and a search in the sheet at 390x844. Cairn's half
//   is `pnpm dev` with the fixture t3code showed served as boot data, the clock fixed at the capture
//   time and the socket refused. Masks: the brand band (t3code's starfield and wordmark), the footer
//   (t3code's pull requests and update pill), and per state the parts the read-only pairing changes.
// - hero (4F): the new-thread hero, its project popover, the `/` and `@` menus, the composer with an
//   attachment, at 1440x900 and 390x844; and the hero at three widths (1180, 980, 820) where the
//   composer footer folds. The sidebar is masked at desktop widths: the sidebar group judges it.
// - thread (4F): t3code's thread "Executor MCP Stdio Bridges" (an idle thread whose last turn
//   changed files, with a failed run among its last three), at its end (assistant message,
//   changed-files card), with its last turn in view (user message, "Worked for"), with that fold
//   open ("Ran N commands"), and with the newest changed-files card centred. The t3 half also
//   exports the thread's last three runs from t3code's projection (read-only, from
//   `~/.t3/userdata/statev2.sqlite`) to `thread.json`; the Cairn half imports them with T3Import
//   into an in-process brain, so both apps render the same conversation.
// Cairn's hero and thread halves run the real client over a real in-process brain
// (judges/fixtures/parity/CairnApp.ts). The Cairn half also writes the controls: the 390 hero with
// the sidebar wrongly open (`390-control-sidebar-open.png`) and the 1440 hero's landmarks after a
// sabotaged class string (`1440-hero.sabotaged.landmarks.json`).
// A streaming assistant has no t3code baseline: the read-only pairing cannot start a turn, so it is
// listed as missing in the report rather than captured.
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { DateTime, Effect, Option, Predicate, Schema } from "effect";
import { chromium } from "playwright";
import type { Browser, BrowserContextOptions, Page } from "playwright";

import {
  formatT3ThreadExport,
  importT3Thread,
  parseT3ThreadExport,
} from "../apps/server/src/brain/conformance/fixtures/T3Import.ts";
import type { T3ThreadExport } from "../apps/server/src/brain/conformance/fixtures/T3Import.ts";
import { EntryId, ProjectId, ThreadId } from "../packages/protocol/src/Ids.ts";
import {
  ProjectShell,
  ShellSnapshot,
  ThreadShell,
} from "../packages/protocol/src/Shell.ts";
import { startCairn } from "./fixtures/parity/CairnApp.ts";
import { Rect, readLandmarks } from "./fixtures/parity/Landmarks.ts";

const root = path.join(import.meta.dirname, "..");

const BASELINE = path.join(root, "judges/fixtures/parity/t3@fe27e8e3/sidebar");

const T3_COMMIT = "fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92";

const SEARCH_QUERY = "bridge";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    t3: { type: "string", default: "https://t3.gneiss.run/" },
    session: {
      type: "string",
      default: path.join(
        homedir(),
        "Developer/projects/cairn/spikes/2-foldkit/runs/t3-session.json"
      ),
    },
    out: {
      type: "string",
      default: path.join(
        homedir(),
        "Developer/agent-artifacts/cairn/v2/phase-1-parity/cairn"
      ),
    },
    group: { type: "string", default: "all" },
    /** t3code's environment id, the first segment of its thread URLs. */
    "t3-env": {
      type: "string",
      default: "56d5ca97-94e9-4c66-9582-d89356b56e14",
    },
  },
});

const [side] = positionals;

if (side !== "t3" && side !== "cairn") {
  throw new Error(
    "usage: capture.ts t3|cairn [--group all|sidebar|hero|thread] [--session <file>] [--t3 <url>] [--out <dir>]"
  );
}

const GROUPS = ["sidebar", "hero", "thread"] as const;

const groups = GROUPS.filter(
  (group) => values.group === "all" || values.group === group
);

/** One width the states are captured at. */
interface View {
  readonly name: "1440" | "390";
  readonly viewport: { readonly width: number; readonly height: number };
  readonly mobile: boolean;
}

const VIEWS: ReadonlyArray<View> = [
  { name: "1440", viewport: { width: 1440, height: 900 }, mobile: false },
  { name: "390", viewport: { width: 390, height: 844 }, mobile: true },
];

const StateName = Schema.Literals([
  "sections",
  "settled-open",
  "search",
  "row-hovered",
  "menu-open",
]);

type StateName = typeof StateName.Type;

const STATES: Readonly<Record<View["name"], ReadonlyArray<StateName>>> = {
  "1440": ["sections", "settled-open", "search", "row-hovered", "menu-open"],
  "390": ["sections", "settled-open", "search"],
};

type Rect = typeof Rect.Type;

/** One row read from t3code's sidebar. */
const FixtureRow = Schema.Struct({
  title: Schema.String,
  project: Schema.String,
  /** The status label ("Waiting", "Working", "Done"), or "" when the row shows its age. */
  status: Schema.String,
  /** The age ("3h") or the status duration ("2m"). */
  time: Schema.String,
  branch: Schema.String,
  claude: Schema.Boolean,
});

type FixtureRow = typeof FixtureRow.Type;

/** One search result read from t3code. */
const FixtureResult = Schema.Struct({
  title: Schema.String,
  project: Schema.String,
  age: Schema.String,
  settled: Schema.Boolean,
  role: Schema.Literals(["user", "assistant", ""]),
  excerpt: Schema.String,
});

/** What one look at t3code's sidebar reads. */
const FixtureRead = Schema.Struct({
  active: Schema.Array(FixtureRow),
  settledCount: Schema.Finite,
  settled: Schema.Array(FixtureRow),
  search: Schema.Array(FixtureResult),
});

type FixtureRead = typeof FixtureRead.Type;

/** Everything t3code showed, enough to rebuild the same shell for Cairn. */
const Fixture = Schema.Struct({
  ...FixtureRead.fields,
  capturedAtMs: Schema.Finite,
});

type Fixture = typeof Fixture.Type;

/** What a baseline capture recorded about one state. */
const StateRecord = Schema.Struct({
  view: Schema.Literals(["1440", "390"]),
  state: StateName,
  clip: Rect,
  /** When t3code drew it; Cairn's clock is fixed here for the same state. */
  capturedAtMs: Schema.Finite,
  /** The card rows t3code showed in this state, so their running labels can be rebuilt exactly. */
  cards: Schema.Array(FixtureRow),
  /** Masked rectangles, relative to the clip, each with why. */
  masks: Schema.Array(Schema.Struct({ ...Rect.fields, reason: Schema.String })),
});

type StateRecord = typeof StateRecord.Type;

const decodeRead = Schema.decodeUnknownSync(FixtureRead);

const decodeStates = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(StateRecord))
);

const decodeFixture = Schema.decodeUnknownSync(Schema.fromJsonString(Fixture));

const contextOptions = (view: View): BrowserContextOptions => ({
  viewport: view.viewport,
  deviceScaleFactor: 2,
  isMobile: view.mobile,
  hasTouch: view.mobile,
  colorScheme: "dark",
  reducedMotion: "reduce",
});

/** Hides t3code's toasts, which float over the sidebar and are not part of it. */
const HIDE_TOASTS =
  '[data-slot^="toast"]{display:none!important} *{caret-color:transparent!important}';

const SIDEBAR_SELECTOR = (view: View) =>
  view.mobile
    ? '[data-slot="sidebar"][data-mobile="true"]'
    : '[data-slot="sidebar-container"]';

const boxOf = async (
  page: Page,
  selector: string
): Promise<Option.Option<Rect>> => {
  const box = await page.locator(selector).first().boundingBox();

  return Option.fromNullOr(box);
};

const union = (left: Rect, right: Rect): Rect => {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);

  return {
    x,
    y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y,
  };
};

/** Brings the page into `state`; both apps share these steps. */
const enterState = async (page: Page, view: View, state: StateName) => {
  if (view.mobile) {
    await page
      .getByRole("button", { name: "Toggle main sidebar" })
      .first()
      .click();
    await page.waitForTimeout(900);
  }

  const scope = page.locator(SIDEBAR_SELECTOR(view)).first();

  if (state === "settled-open") {
    await scope.getByTestId("sidebar-settled-shelf-toggle").click();
  }

  if (state === "search") {
    await scope
      .getByRole("combobox", { name: "Search threads" })
      .fill(SEARCH_QUERY);
    await page.waitForTimeout(1500);
  }

  if (state === "row-hovered") {
    await scope.getByTestId("sidebar-row-card").first().hover();
  }

  if (state === "menu-open") {
    await scope
      .getByTestId("sidebar-row-card")
      .first()
      .click({ button: "right" });
  }

  if (state !== "row-hovered" && state !== "menu-open" && !view.mobile) {
    await page.mouse.move(view.viewport.width - 10, view.viewport.height - 10);
  }

  await page.waitForTimeout(800);
};

/** The clip of a state: the sidebar, and an open menu when there is one. */
const clipOf = async (
  page: Page,
  view: View,
  state: StateName
): Promise<Rect> => {
  const sidebar = Option.getOrThrow(await boxOf(page, SIDEBAR_SELECTOR(view)));

  if (state !== "menu-open") {
    return sidebar;
  }

  const menu = await boxOf(page, '[data-level="0"]');

  return Option.match(menu, {
    onNone: () => sidebar,
    onSome: (box) => union(sidebar, box),
  });
};

const round = (rect: Rect): Rect => ({
  x: Math.round(rect.x),
  y: Math.round(rect.y),
  width: Math.round(rect.width),
  height: Math.round(rect.height),
});

/** The declared differences of a state, as rectangles relative to its clip. */
const masksOf = async (
  page: Page,
  view: View,
  state: StateName,
  clip: Rect
): Promise<StateRecord["masks"]> => {
  const relative = (rect: Rect, reason: string) => ({
    ...round({
      x: rect.x - clip.x,
      y: rect.y - clip.y,
      width: rect.width,
      height: rect.height,
    }),
    reason,
  });

  const masks = [
    relative(
      { x: clip.x, y: clip.y, width: clip.width, height: 80 },
      "brand band: t3code's starfield backdrop and wordmark (plan D24)"
    ),
  ];

  const footer = await boxOf(
    page,
    `${SIDEBAR_SELECTOR(view)} [data-slot="sidebar-footer"]`
  );

  Option.map(footer, (box) => {
    masks.push(
      relative(
        { x: clip.x, y: box.y, width: clip.width, height: box.height },
        "footer: t3code's pull requests and update pill; Cairn's usage and connection state"
      )
    );
  });

  masks.push(
    relative(
      { x: clip.x + 255, y: clip.y, width: 1, height: clip.height },
      "right border: translucent, so it shows the page behind the sidebar, which the hero and thread pages own"
    )
  );

  const staleFade = await page.evaluate((selector) => {
    const viewport = document.querySelector<HTMLElement>(
      `${selector} [data-slot="scroll-area-viewport"]`
    );

    if (viewport === null) {
      return null;
    }

    const box = viewport.getBoundingClientRect();
    const overflows = viewport.scrollHeight > viewport.clientHeight + 1;

    const end = viewport.style
      .getPropertyValue("--scroll-area-overflow-y-end")
      .trim();

    return overflows && end === "0px"
      ? { x: box.x, y: box.y + box.height - 24, width: box.width, height: 24 }
      : null;
  }, SIDEBAR_SELECTOR(view));

  if (staleFade !== null) {
    masks.push(
      relative(
        staleFade,
        "scroll fade: t3code had not refreshed its bottom fade after the search results arrived; Cairn fades an overflowing list"
      )
    );
  }

  const ages = await page.evaluate((selector) => {
    const scope = document.querySelector(selector);

    return [...(scope?.querySelectorAll("*") ?? [])].flatMap((element) => {
      if (
        element.childElementCount !== 0 ||
        !/^(?:\d+[smhd]|now)$/u.test(element.textContent.trim())
      ) {
        return [];
      }

      const box = element.getBoundingClientRect();

      return [{ x: box.x, y: box.y, width: box.width, height: box.height }];
    });
  }, SIDEBAR_SELECTOR(view));

  for (const box of ages) {
    masks.push(
      relative(
        {
          x: box.x - 8,
          y: box.y - 1,
          width: box.width + 10,
          height: box.height + 2,
        },
        "ticking label: a relative age or duration, rebuilt from its rounded value, may sit in the next unit"
      )
    );
  }

  const favicons = await page
    .locator(`${SIDEBAR_SELECTOR(view)} img.rounded-\\[25\\%\\]`)
    .all();

  for (const favicon of favicons) {
    const box = await favicon.boundingBox();

    if (box !== null) {
      masks.push(
        relative(
          {
            x: box.x - 1,
            y: box.y - 1,
            width: box.width + 2,
            height: box.height + 2,
          },
          "project favicon: t3code shows a project's own favicon image; Cairn draws the monogram"
        )
      );
    }
  }

  if (state === "menu-open") {
    const menu = await boxOf(page, '[data-level="0"]');

    Option.map(menu, (box) => {
      masks.push(
        relative(
          box,
          "menu items: t3code adds New thread on main, Regenerate title and Project settings, which Cairn trims, and the read-only pairing greys out the actions that change a thread"
        )
      );
    });
  }

  if (state === "row-hovered" || state === "menu-open") {
    const card = await boxOf(
      page,
      `${SIDEBAR_SELECTOR(view)} [data-testid="sidebar-row-card"]`
    );

    Option.map(card, (box) => {
      masks.push(
        relative(
          {
            x: clip.x + clip.width - 6,
            y: box.y - 8,
            width: 6,
            height: box.height + 160,
          },
          "hover card: t3code's thread details card opens beside the row; Cairn has none yet"
        )
      );
    });

    const slot = await boxOf(
      page,
      `${SIDEBAR_SELECTOR(view)} [data-testid="sidebar-row-card"] .group\\/sidebar-status-slot`
    );

    Option.map(slot, (box) => {
      masks.push(
        relative(
          {
            x: box.x - 40,
            y: box.y,
            width: box.width + 40,
            height: box.height,
          },
          "row controls: the read-only pairing hides Snooze in t3code; Cairn's owner may snooze"
        )
      );
    });
  }

  return masks;
};

/** Reads the rows, the settled count and the search results t3code shows. */
const readFixture = async (page: Page, view: View): Promise<FixtureRead> =>
  decodeRead(
    await page.evaluate(
      ([sidebarSelector]) => {
        // These helpers run in the page, so they must live inside the evaluated function.
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
        const text = (element: Element | null | undefined) =>
          element?.textContent?.trim() ?? "";

        const scope = document.querySelector(sidebarSelector) ?? document;

        // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
        const lastLabelPart = (element: Element) =>
          (element.getAttribute("aria-label") ?? "").split(", ").at(-1) ?? "";

        const cards = [
          ...scope.querySelectorAll('[data-testid="sidebar-row-card"]'),
        ].map((card) => {
          const status = text(card.querySelector('[role="status"]'));
          const slot = card.querySelector(".tabular-nums");

          return {
            title: text(card.querySelector(".mt-1 span")),
            project: text(card.querySelector(".text-secondary-label.text-xs")),
            status,
            time:
              status === ""
                ? text(slot)
                : text(card.querySelector("span[aria-hidden] .tabular-nums")),
            branch: text(card.querySelector(".mt-0\\.5 .truncate")),
            claude: card.querySelector("svg.fill-\\[\\#d97757\\]") !== null,
          };
        });

        const slims = [
          ...scope.querySelectorAll('[data-testid="sidebar-row-slim"]'),
        ].map((slim) => ({
          title: text(slim.querySelector(".sr-only")),
          project: lastLabelPart(slim),
          status: "",
          time: text(slim.querySelector(".tabular-nums .text-xs")),
          branch: "",
          claude: false,
        }));

        const header = text(
          scope.querySelector('[data-testid="sidebar-settled-shelf-toggle"]')
        );

        const roles = new Map([
          ["You:", "user"],
          ["Agent:", "assistant"],
        ]);

        const results = [
          ...scope.querySelectorAll('[role="option"][data-search-result-key]'),
        ].map((option) => {
          const excerpt = option.querySelector(".text-muted-foreground\\/85");
          const who = text(excerpt?.querySelector("span"));

          return {
            title: text(option.querySelector(".truncate")),
            project: lastLabelPart(option),
            age: text(option.querySelector(".w-8")),
            settled:
              option.querySelector(".text-secondary-label\\/70") !== null,
            role: roles.get(who) ?? "",
            excerpt: text(excerpt).replace(/^(?:You|Agent):\s*/u, ""),
          };
        });

        return {
          active: cards,
          settledCount: Number(
            /\((?<count>\d+)\)/u.exec(header)?.groups?.count ?? 0
          ),
          settled: slims,
          search: results,
        };
      },
      [SIDEBAR_SELECTOR(view)] as const
    )
  );

const shot = async (page: Page, clip: Rect, file: string) => {
  await page.screenshot({ path: file, clip });
};

const sidebarHtml = async (page: Page, view: View): Promise<string> =>
  await page
    .locator(SIDEBAR_SELECTOR(view))
    .first()
    .evaluate((element) => element.outerHTML);

/** The installed nightly's version, as ADR 0015 writes it. */
const installedVersion = (): string =>
  execFileSync("pacman", ["-Q", "t3code-nightly-bin"], { encoding: "utf-8" })
    .trim()
    .split(" ")[1]
    ?.replace(/-\d+$/u, "")
    .replaceAll("_", "-") ?? "";

const recordedVersion = (): string => {
  const adr = readFileSync(
    path.join(root, "docs/decisions/0015-parity-against-t3code-nightly.md"),
    "utf-8"
  );

  return (
    /`(?<version>\d+\.\d+\.\d+-nightly\.\d+\.\d+)`/u.exec(adr)?.groups
      ?.version ?? ""
  );
};

/** Folds one 1440 state's reading into the fixture: rows from sections, settled rows from the open shelf, results from search. */
const mergeFixture = (
  fixture: Fixture | undefined,
  state: StateName,
  read: FixtureRead,
  capturedAtMs: number
): Fixture => ({
  capturedAtMs: fixture?.capturedAtMs ?? capturedAtMs,
  active: state === "sections" ? read.active : (fixture?.active ?? []),
  settledCount:
    state === "sections" ? read.settledCount : (fixture?.settledCount ?? 0),
  settled: state === "settled-open" ? read.settled : (fixture?.settled ?? []),
  search: state === "search" ? read.search : (fixture?.search ?? []),
});

const captureSidebarT3 = async (browser: Browser) => {
  const version = installedVersion();
  const recorded = recordedVersion();

  if (version !== recorded) {
    throw new Error(
      `The installed t3code-nightly-bin is ${version}, but ADR 0015 records ${recorded}. Move the pin first.`
    );
  }

  mkdirSync(BASELINE, { recursive: true });

  const states: Array<StateRecord> = [];
  let fixture: Fixture | undefined;

  for (const view of VIEWS) {
    for (const state of STATES[view.name]) {
      const context = await browser.newContext({
        ...contextOptions(view),
        storageState: values.session,
      });

      const page = await context.newPage();

      await page.goto(values.t3, { waitUntil: "networkidle" });
      await page.addStyleTag({ content: HIDE_TOASTS });
      await page.waitForTimeout(2500);
      await enterState(page, view, state);

      const clip = round(await clipOf(page, view, state));
      const masks = await masksOf(page, view, state, clip);

      const capturedAtMs = await page.evaluate(() => Date.now());

      await shot(page, clip, path.join(BASELINE, `${view.name}-${state}.png`));
      writeFileSync(
        path.join(BASELINE, `${view.name}-${state}.html`),
        `${await sidebarHtml(page, view)}\n`
      );
      const read = await readFixture(page, view);

      states.push({
        view: view.name,
        state,
        clip,
        capturedAtMs,
        cards: read.active,
        masks,
      });

      if (view.name === "1440") {
        fixture = mergeFixture(fixture, state, read, capturedAtMs);
      }

      await context.close();
      console.log(`t3 ${view.name} ${state}`);
    }
  }

  writeFileSync(
    path.join(BASELINE, "states.json"),
    `${JSON.stringify(states, null, 2)}\n`
  );
  writeFileSync(
    path.join(BASELINE, "fixture.json"),
    `${JSON.stringify(fixture, null, 2)}\n`
  );
  writeFileSync(
    path.join(BASELINE, "version.json"),
    `${JSON.stringify(
      {
        package: "t3code-nightly-bin",
        version,
        commit: T3_COMMIT,
        capturedAt: new Date(fixture?.capturedAtMs ?? Date.now()).toISOString(),
      },
      null,
      2
    )}\n`
  );

  // The repo formats every file it holds, the baseline markup included.
  execFileSync("pnpm", ["exec", "oxfmt", BASELINE], {
    cwd: root,
    stdio: "ignore",
  });
};

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

const UNITS = new Map([
  ["s", 1000],
  ["m", MINUTE],
  ["h", HOUR],
  ["d", DAY],
]);

/** A relative label's value and unit: "3h" is 3 and an hour; "now" is 0 seconds. */
/** A relative label read as a count of units. */
interface LabelReading {
  readonly value: number;
  readonly unit: number;
}

const parseLabel = (label: string): LabelReading => {
  const duration = /^(?<hours>\d+)h (?<minutes>\d+)m$/u.exec(label.trim());

  if (duration?.groups !== undefined) {
    return {
      value:
        Number(duration.groups.hours) * 60 + Number(duration.groups.minutes),
      unit: MINUTE,
    };
  }

  const match = /^(?<value>\d+)(?<unit>[smhd])$/u.exec(label.trim());

  return {
    value: Number(match?.groups?.value ?? 0),
    unit: UNITS.get(match?.groups?.unit ?? "s") ?? 1000,
  };
};

/** The middle of the span a relative label covers ("3h" is 3h30m ago), in milliseconds. */
const labelMiddle = (label: string): number => {
  const { unit, value } = parseLabel(label);

  return value === 0 ? 20_000 : value * unit + unit / 2;
};

/** Just inside the start of the span a relative label covers ("1d" is a little over 24h ago). */
const labelStart = (label: string): number => {
  const { unit, value } = parseLabel(label);

  return value * unit + 60_000;
};

const time = (ms: number) => DateTime.makeUnsafe(ms);

const baseThread = (input: {
  readonly index: number;
  readonly title: string;
  readonly projectId: ProjectId;
  readonly createdAtMs: number;
}): ThreadShell =>
  ThreadShell.make({
    id: ThreadId.make(
      `0199f0c2-6a4e-7d4c-9a6b-${String(input.index).padStart(12, "0")}`
    ),
    projectId: input.projectId,
    title: input.title,
    provider: "opencode-go",
    modelId: "small",
    thinkingLevel: "medium",
    runtimeMode: "full-access",
    branch: Option.none(),
    worktreePath: Option.none(),
    activity: "idle",
    activeRunId: Option.none(),
    latestRunRequestedAt: Option.none(),
    latestRunStartedAt: Option.none(),
    latestRunCompletedAt: Option.none(),
    queueLength: 0,
    lastError: Option.none(),
    lastErrorClass: Option.none(),
    usageLimitResetAt: Option.none(),
    waitingFor: "none",
    pendingRuntimeRequest: Option.none(),
    latestVisibleMessage: Option.none(),
    latestUserMessageAt: Option.none(),
    createdAt: time(input.createdAtMs),
    updatedAt: time(input.createdAtMs),
    archivedAt: Option.none(),
    settledOverride: Option.none(),
    settledAt: Option.none(),
    unsettledAt: Option.none(),
    snoozedUntil: Option.none(),
    snoozedAt: Option.none(),
    pinnedAt: Option.none(),
    pinOrderKey: Option.none(),
    activeOrderKey: Option.none(),
    autoSettleDisabledAt: Option.none(),
    lastVisitedAt: Option.none(),
    parkedTaskIds: [],
  });

/** The activity behind each status label t3code shows on a card. */
const ACTIVITIES = new Map<string, ThreadShell["activity"]>([
  ["Waiting", "waiting"],
  ["Working", "running"],
]);

/**
 * The shell that makes Cairn's sidebar show what t3code showed: the active rows in order with their
 * status and age, the settled rows with their ages, enough older settled threads for the count, and
 * every search result with its excerpt. Threads appear in the shell in search-result order, so
 * Cairn's search lists them in t3code's order.
 */
const shellFromFixture = (
  fixture: Fixture,
  record: StateRecord
): ShellSnapshot => {
  const now = fixture.capturedAtMs;

  const projectNames = [
    ...new Set([
      ...fixture.active.map((row) => row.project),
      ...fixture.settled.map((row) => row.project),
      ...fixture.search.map((row) => row.project),
    ]),
  ].filter((name) => name !== "");

  const projectIdOf = (name: string) =>
    ProjectId.make(`prj_${Math.max(0, projectNames.indexOf(name))}`);

  const projects = projectNames.map((title, position) =>
    ProjectShell.make({
      id: ProjectId.make(`prj_${position}`),
      title,
      kind: "folder",
      workspaceRoot: `/home/owner/Developer/projects/${title}`,
      repository: Option.none(),
      defaultModel: Option.none(),
      createdAt: time(now - 90 * DAY),
      updatedAt: time(now - 90 * DAY),
    })
  );

  let index = 0;

  const nextIndex = () => {
    index += 1;

    return index;
  };

  // Which thread each search result became, by result position.
  const resultThreads = new Map<number, ThreadShell>();

  const claim = (title: string, settled: boolean): number =>
    fixture.search.findIndex(
      (result, position) =>
        !resultThreads.has(position) &&
        result.title === title &&
        result.settled === settled
    );

  const withExcerpt = (thread: ThreadShell, position: number): ThreadShell => {
    const result = fixture.search[position];

    if (result === undefined) {
      return thread;
    }

    const spoken: ThreadShell =
      result.role === ""
        ? thread
        : {
            ...thread,
            latestVisibleMessage: Option.some({
              entryId: EntryId.make(1),
              role: result.role,
              text: result.excerpt,
              at: time(now - labelMiddle(result.age)),
            }),
          };

    const aged: ThreadShell = {
      ...spoken,
      latestUserMessageAt: Option.some(time(now - labelMiddle(result.age))),
    };

    resultThreads.set(position, aged);

    return aged;
  };

  const active = fixture.active.map((fixtureRow, position) => {
    // This state's own reading of the card, against this state's clock, when t3code showed it.
    const stateRow = record.cards.find(
      (card) => card.title === fixtureRow.title
    );

    const row = stateRow ?? fixtureRow;
    const rowNow = stateRow === undefined ? now : record.capturedAtMs;

    const thread = baseThread({
      index: nextIndex(),
      title: row.title,
      projectId: projectIdOf(row.project),
      createdAtMs: now - 60 * DAY + (fixture.active.length - position) * MINUTE,
    });

    const ago = labelMiddle(row.time);

    const card: ThreadShell = {
      ...thread,
      provider: row.claude ? "claude-bridge" : "opencode-go",
      branch: row.branch === "" ? Option.none() : Option.some(row.branch),
      latestUserMessageAt: Option.some(
        time(rowNow - (row.status === "" ? ago : 4 * HOUR))
      ),
      activity: ACTIVITIES.get(row.status) ?? "idle",
      latestRunRequestedAt:
        row.status === ""
          ? Option.none()
          : Option.some(time(rowNow - 4 * HOUR)),
      latestRunStartedAt:
        row.status === "Working"
          ? Option.some(time(rowNow - ago))
          : Option.none(),
      latestRunCompletedAt:
        row.status === "Waiting" || row.status === "Done"
          ? Option.some(time(rowNow - ago))
          : Option.none(),
      lastVisitedAt:
        row.status === "Done" ? Option.none() : Option.some(time(rowNow)),
    };

    return withExcerpt(card, claim(row.title, false));
  });

  const settled = fixture.settled.map((row, position) => {
    const settledAt = time(now - labelStart(row.time) - position * 1000);

    const thread: ThreadShell = {
      ...baseThread({
        index: nextIndex(),
        title: row.title,
        projectId: projectIdOf(row.project),
        createdAtMs: now - 80 * DAY,
      }),
      settledOverride: Option.some("settled" as const),
      settledAt: Option.some(settledAt),
      latestUserMessageAt: Option.some(settledAt),
      lastVisitedAt: Option.some(time(now)),
    };

    return withExcerpt(thread, claim(row.title, true));
  });

  const searchOnly = fixture.search.flatMap((result, position) => {
    if (resultThreads.has(position)) {
      return [];
    }

    const thread: ThreadShell = {
      ...baseThread({
        index: nextIndex(),
        title: result.title,
        projectId: projectIdOf(result.project),
        createdAtMs: now - 85 * DAY,
      }),
      settledOverride: result.settled
        ? Option.some("settled" as const)
        : Option.none(),
      settledAt: result.settled
        ? Option.some(time(now - 40 * DAY - position * 1000))
        : Option.none(),
      lastVisitedAt: Option.some(time(now)),
    };

    return [withExcerpt(thread, position)];
  });

  const all = [...active, ...settled, ...searchOnly];

  const settledSoFar = all.filter((thread) =>
    Option.isSome(thread.settledAt)
  ).length;

  const filler = Array.from(
    { length: Math.max(0, fixture.settledCount - settledSoFar) },
    (_, position): ThreadShell => ({
      ...baseThread({
        index: nextIndex(),
        title: `Older settled thread ${position + 1}`,
        projectId: projectIdOf(projectNames[0] ?? ""),
        createdAtMs: now - 89 * DAY,
      }),
      settledOverride: Option.some("settled" as const),
      settledAt: Option.some(time(now - 60 * DAY - position * 1000)),
      lastVisitedAt: Option.some(time(now)),
    })
  );

  // Search order first, so Cairn's search lists the results in t3code's order.
  const inSearchOrder = fixture.search.flatMap((_, position) => {
    const thread = resultThreads.get(position);

    return thread === undefined ? [] : [thread];
  });

  const ordered = [...inSearchOrder, ...all].filter(
    (thread, position, list) =>
      list.findIndex((other) => other.id === thread.id) === position
  );

  return ShellSnapshot.make({
    snapshotSequence: 1,
    projects,
    threads: [...ordered, ...filler],
  });
};

const encodeBoot = Schema.encodeSync(
  Schema.toCodecJson(Schema.Struct({ shell: ShellSnapshot }))
);

/** Starts `tools/dev.ts` on throwaway ports and returns the page origin and a stop function. */
const startDev = async (): Promise<{
  readonly origin: string;
  readonly stop: () => void;
  readonly dataDir: string;
}> => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-capture-"));

  const dev = spawn(
    process.execPath,
    [path.join(root, "tools/dev.ts"), "--data-dir", dataDir],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }
  );

  const lines = createInterface({ input: dev.stdout });

  for await (const line of lines) {
    const match = /Cairn dev: (?<origin>http:\/\/[^\s]+)/u.exec(line);

    if (match?.groups?.origin !== undefined) {
      const { origin } = match.groups;

      return {
        origin,
        dataDir,
        stop: () => {
          if (dev.pid !== undefined) {
            process.kill(-dev.pid, "SIGTERM");
          }
        },
      };
    }
  }

  throw new Error("tools/dev.ts ended before it printed its address.");
};

/** The sidebar group, Cairn's half: the same states from `pnpm dev` with the fixture as boot data. */
const captureSidebarCairn = async (browser: Browser) => {
  const states = decodeStates(
    readFileSync(path.join(BASELINE, "states.json"), "utf-8")
  );

  const fixture = decodeFixture(
    readFileSync(path.join(BASELINE, "fixture.json"), "utf-8")
  );

  const out = path.join(values.out, "sidebar");
  const dev = await startDev();

  mkdirSync(out, { recursive: true });

  try {
    for (const record of states) {
      const view =
        VIEWS.find((candidate) => candidate.name === record.view) ?? VIEWS[0];

      if (view === undefined) {
        continue;
      }

      const context = await browser.newContext(contextOptions(view));
      const page = await context.newPage();

      const boot = JSON.stringify(
        encodeBoot({ shell: shellFromFixture(fixture, record) })
      );

      await page.clock.setFixedTime(record.capturedAtMs);
      await page.routeWebSocket(/\/ws/u, (socket) => {
        void socket.close();
      });
      await page.route(`${dev.origin}/`, async (route) => {
        const response = await route.fetch();

        const body = await response.text();

        const html = body.replace(
          "</head>",
          `<script id="cairn-boot" type="application/json">${boot.replaceAll("<", "\\u003c")}</script></head>`
        );

        await route.fulfill({ response, body: html });
      });
      await page.goto(`${dev.origin}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(2500);
      await enterState(page, view, record.state);

      await shot(
        page,
        record.clip,
        path.join(out, `${record.view}-${record.state}.png`)
      );
      writeFileSync(
        path.join(out, `${record.view}-${record.state}.html`),
        `${await sidebarHtml(page, view)}\n`
      );
      await context.close();
      console.log(`cairn sidebar ${record.view} ${record.state}`);
    }
  } finally {
    dev.stop();
    rmSync(dev.dataDir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------------------------
// The hero and thread groups (4F).

const BASELINE_ROOT = path.join(root, "judges/fixtures/parity/t3@fe27e8e3");

/**
 * The thread both apps show. A thread that is running while the baseline is captured would give a
 * half-finished turn, so this is an idle one whose last turn has a changed-files card.
 */
const T3_THREAD_ID = "906d5d18-6060-4eae-81a2-033a850a4983";

/**
 * How many of the thread's newest runs are exported and imported at least; the export reaches
 * back further, to the newest run that changed files, so the changed-files card is in it.
 */
const EXPORTED_RUNS = 3;

/** Tool output kept per item in the export: enough to render, small enough to commit. */
const OUTPUT_LIMIT = 2000;

/** One viewport a hero or thread state is captured at. */
interface PageView {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly mobile: boolean;
}

const desktop = (width: number): PageView => ({
  name: String(width),
  width,
  height: 900,
  mobile: false,
});

const PHONE: PageView = { name: "390", width: 390, height: 844, mobile: true };

const HeroState = Schema.Literals([
  "hero",
  "project-popover",
  "slash-menu",
  "at-menu",
  "attachments",
  "footer",
]);

type HeroState = typeof HeroState.Type;

const ThreadState = Schema.Literals([
  "thread-end",
  "thread-turn",
  "thread-fold-open",
  "thread-changed-files",
]);

type ThreadState = typeof ThreadState.Type;

const isThreadState = Schema.is(ThreadState);

type PageGroup = "hero" | "thread";

interface PageCapture {
  readonly view: PageView;
  readonly state: HeroState | ThreadState;
}

const PAGE_STATES: Readonly<Record<PageGroup, ReadonlyArray<PageCapture>>> = {
  hero: [
    ...[desktop(1440), PHONE].flatMap((view) =>
      (
        [
          "hero",
          "project-popover",
          "slash-menu",
          "at-menu",
          "attachments",
        ] as const
      ).map((state) => ({ view, state }))
    ),
    // The composer footer folds by width (t3code's composerFooterLayout).
    ...[1180, 980, 820].map((width) => ({
      view: desktop(width),
      state: "footer" as const,
    })),
  ],
  thread: [desktop(1440), PHONE].flatMap((view) =>
    (
      [
        "thread-end",
        "thread-turn",
        "thread-fold-open",
        "thread-changed-files",
      ] as const
    ).map((state) => ({ view, state }))
  ),
};

/** What a baseline capture recorded about one hero or thread state. */
const PageRecord = Schema.Struct({
  group: Schema.Literals(["hero", "thread"]),
  view: Schema.String,
  viewport: Schema.Struct({ width: Schema.Finite, height: Schema.Finite }),
  mobile: Schema.Boolean,
  state: Schema.Union([HeroState, ThreadState]),
  clip: Rect,
  capturedAtMs: Schema.Finite,
  masks: Schema.Array(Schema.Struct({ ...Rect.fields, reason: Schema.String })),
});

type PageRecord = typeof PageRecord.Type;

const pageContextOptions = (view: PageView): BrowserContextOptions => ({
  viewport: { width: view.width, height: view.height },
  deviceScaleFactor: 2,
  isMobile: view.mobile,
  hasTouch: view.mobile,
  colorScheme: "dark",
  reducedMotion: "reduce",
});

/** A small, fixed PNG for the attachment state: the same bytes in both apps. */
const attachmentPng = async (browser: Browser): Promise<Buffer> => {
  const page = await browser.newPage({
    viewport: { width: 160, height: 100 },
  });

  await page.setContent(
    '<body style="margin:0"><div style="width:160px;height:100px;background:linear-gradient(135deg,#3b82f6,#f59e0b)"></div></body>'
  );

  const png = await page.screenshot();

  await page.close();

  return png;
};

/** Hides what floats over both apps and is not part of a state: toasts and the caret. */
const prepare = async (page: Page) => {
  await page.addStyleTag({ content: HIDE_TOASTS });

  // t3code's thread details panel is outside the surfaces compared; Cairn has none.
  if ((await page.locator('aside[aria-label="Thread details"]').count()) > 0) {
    await page
      .getByRole("button", { name: "Toggle thread details panel" })
      .first()
      .click();
    await page.waitForTimeout(600);
  }
};

const editor = (page: Page) =>
  page.locator('[data-testid="composer-editor"]').first();

/**
 * Opens a hero or thread page and waits for its composer (attached: a phone thread page folds it
 * away). Vite may reload the page once while it optimizes a dependency it met late, so a page that
 * does not settle gets one more load.
 */
const open = async (page: Page, url: string) => {
  await page.goto(url, { waitUntil: "networkidle" });
  await editor(page)
    .waitFor({ state: "attached", timeout: 15_000 })
    .catch(async () => {
      await page.goto(url, { waitUntil: "networkidle" });
      await editor(page).waitFor({ state: "attached", timeout: 15_000 });
    });
};

/** Brings a hero page into `state`; both apps share these steps. */
const enterHeroState = async (
  page: Page,
  state: HeroState,
  png: Buffer
): Promise<void> => {
  await editor(page).waitFor({ state: "visible", timeout: 15_000 });

  if (state === "project-popover") {
    await page.locator("h1 button").first().click();
  }

  if (state === "slash-menu") {
    await editor(page).click();
    await page.keyboard.type("/");
  }

  if (state === "at-menu") {
    await editor(page).click();
    await page.keyboard.type("@src");
    await page.waitForTimeout(1200);
  }

  if (state === "attachments") {
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "screenshot.png",
      mimeType: "image/png",
      buffer: png,
    });
    await page.waitForTimeout(1200);
  }

  await page.waitForTimeout(800);
};

/** Brings a thread page into `state`. */
const enterThreadState = async (page: Page, state: ThreadState) => {
  const folds = page.locator('[data-timeline-row-kind="turn-fold"]');

  await page
    .locator("[data-timeline-row-kind]")
    .last()
    .waitFor({ state: "attached", timeout: 20_000 });
  await page.waitForTimeout(1500);

  // An app without fold rows is captured as it stands; the structure judge lists the rows missing.
  if ((await folds.count()) === 0) {
    console.log(`  no turn-fold row for ${state}`);
    await page.waitForTimeout(800);

    return;
  }

  if (state === "thread-turn" || state === "thread-fold-open") {
    await folds.last().scrollIntoViewIfNeeded();
    await folds.last().evaluate((element) => {
      element.scrollIntoView({ block: "start" });
    });
    await page.waitForTimeout(600);
  }

  if (state === "thread-changed-files") {
    // The card may sit in a turn the list has not rendered yet: scroll up until it appears.
    const card = page.locator("[data-changed-files-state]");

    for (let step = 0; step < 40 && (await card.count()) === 0; step += 1) {
      await folds.first().evaluate((element) => {
        let scroller = element.parentElement;

        while (
          scroller !== null &&
          scroller.scrollHeight <= scroller.clientHeight + 1
        ) {
          scroller = scroller.parentElement;
        }

        scroller?.scrollBy({ top: -600 });
      });
      await page.waitForTimeout(250);
    }

    if ((await card.count()) > 0) {
      await card.last().evaluate((element) => {
        element.scrollIntoView({ block: "center" });
      });
    }

    await page.waitForTimeout(600);
  }

  if (state === "thread-fold-open") {
    await folds.last().locator("button").first().click();
    await page.waitForTimeout(800);
    await folds.last().evaluate((element) => {
      element.scrollIntoView({ block: "start" });
    });
  }

  await page.mouse.move(2, 2);
  await page.waitForTimeout(800);
};

/** The declared differences of a hero or thread state, relative to the full-page clip. */
const pageMasks = async (
  page: Page,
  view: PageView
): Promise<PageRecord["masks"]> => {
  if (view.mobile) {
    return [];
  }

  const sidebar = await boxOf(page, '[data-slot="sidebar-container"]');

  return Option.match(sidebar, {
    onNone: () => [],
    onSome: (box) => [
      {
        ...round(box),
        reason:
          "sidebar: judged by the sidebar group, whose fixture rebuilds t3code's rows",
      },
    ],
  });
};

/** One page state of one app: the screenshot, the page HTML and the landmarks. */
const captureState = async (
  page: Page,
  dir: string,
  capture: PageCapture
): Promise<Rect> => {
  const clip = {
    x: 0,
    y: 0,
    width: capture.view.width,
    height: capture.view.height,
  };

  const base = path.join(dir, `${capture.view.name}-${capture.state}`);

  await shot(page, clip, `${base}.png`);
  writeFileSync(`${base}.html`, `${await page.content()}\n`);
  writeFileSync(
    `${base}.landmarks.json`,
    `${JSON.stringify(await readLandmarks(page), null, 2)}\n`
  );

  return clip;
};

/** A t3code turn item row, as t3code's projection stores it. */
const T3ItemRow = Schema.Struct({
  run_ordinal: Schema.Finite,
  type: Schema.String,
  status: Schema.String,
  payload_json: Schema.String,
});

const T3RunRow = Schema.Struct({
  ordinal: Schema.Finite,
  requested_at: Schema.String,
  completed_at: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
});

const T3ThreadRow = Schema.Struct({
  title: Schema.String,
  project: Schema.String,
});

const T3Payload = Schema.Struct({
  startedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  completedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  toolName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  input: Schema.optionalKey(
    Schema.Union([
      Schema.String,
      Schema.Record(Schema.String, Schema.Json),
      Schema.Null,
    ])
  ),
  output: Schema.optionalKey(Schema.Json),
  fileName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  diffStr: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const decodeItemRows = Schema.decodeUnknownSync(Schema.Array(T3ItemRow));

const decodeRunRows = Schema.decodeUnknownSync(Schema.Array(T3RunRow));

const decodeThreadRow = Schema.decodeUnknownSync(T3ThreadRow);

const decodePayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(T3Payload)
);

const millis = (iso: string | null | undefined): Option.Option<number> =>
  iso === null || iso === undefined
    ? Option.none()
    : Option.some(Date.parse(iso));

const cut = (text: string) =>
  text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n…` : text;

const outputText = (output: Schema.Json | undefined): Option.Option<string> => {
  if (output === undefined || output === null) {
    return Option.none();
  }

  return Option.some(
    cut(Predicate.isString(output) ? output : JSON.stringify(output))
  );
};

/**
 * Exports t3code's thread from its own database, read-only: the thread's title and project, and
 * its newest runs with their turn items in t3code's order.
 */
const exportT3Thread = (): T3ThreadExport => {
  const database = new DatabaseSync(
    path.join(homedir(), ".t3/userdata/statev2.sqlite"),
    { readOnly: true }
  );

  try {
    const thread = decodeThreadRow(
      database
        .prepare(
          `select t.title as title, coalesce(p.title, '') as project
             from orchestration_v2_projection_threads t
             left join projection_projects p on p.project_id = t.project_id
            where t.thread_id = ?`
        )
        .get(T3_THREAD_ID)
    );

    const runs = decodeRunRows(
      database
        .prepare(
          `select ordinal, requested_at, completed_at,
                  json_extract(payload_json, '$.modelSelection.model') as model
             from orchestration_v2_projection_runs
            where thread_id = ? order by ordinal desc`
        )
        .all(T3_THREAD_ID)
    );

    const changedRow = database
      .prepare(
        `select max(r.ordinal) as ordinal
           from orchestration_v2_projection_turn_items i
           join orchestration_v2_projection_runs r on r.run_id = i.run_id
          where i.thread_id = ? and i.type = 'checkpoint'
            and json_array_length(json_extract(i.payload_json, '$.files')) > 0`
      )
      .get(T3_THREAD_ID);

    const changed = Schema.decodeUnknownSync(
      Schema.Struct({ ordinal: Schema.NullOr(Schema.Finite) })
    )(changedRow).ordinal;

    const newest = runs.slice(0, EXPORTED_RUNS).at(-1)?.ordinal ?? 0;
    const from = Math.min(newest, changed ?? newest);
    const exported = runs.filter((run) => run.ordinal >= from).toReversed();

    const items = decodeItemRows(
      database
        .prepare(
          `select r.ordinal as run_ordinal, i.type, i.status, i.payload_json
             from orchestration_v2_projection_turn_items i
             join orchestration_v2_turn_item_positions p on p.turn_item_id = i.turn_item_id
             join orchestration_v2_projection_runs r on r.run_id = i.run_id
            where i.thread_id = ? and r.ordinal >= ?
            order by p.ordinal`
        )
        .all(T3_THREAD_ID, from)
    );

    return {
      threadId: T3_THREAD_ID,
      title: thread.title,
      projectTitle: thread.project,
      model: exported.at(-1)?.model ?? "claude",
      runs: exported.map((run) => ({
        ordinal: run.ordinal,
        requestedAtMs: Date.parse(run.requested_at),
        completedAtMs: millis(run.completed_at),
        items: items
          .filter((row) => row.run_ordinal === run.ordinal)
          .map((row) => {
            const payload = decodePayload(row.payload_json);

            const startedAtMs = Option.getOrElse(
              millis(payload.startedAt),
              () => Date.parse(run.requested_at)
            );

            return {
              type: row.type,
              startedAtMs,
              completedAtMs: millis(payload.completedAt),
              text: Option.fromNullishOr(payload.text),
              toolName: Option.fromNullishOr(payload.toolName),
              title: Option.fromNullishOr(payload.title),
              input: Predicate.isString(payload.input)
                ? Option.some(payload.input)
                : Option.none(),
              arguments: Predicate.isObject(payload.input)
                ? Option.some(payload.input)
                : Option.none(),
              output: outputText(payload.output),
              path: Option.fromNullishOr(payload.fileName),
              created: payload.diffStr?.includes('"type":"create"') ?? false,
              isError: row.status === "failed",
            };
          }),
      })),
    };
  } finally {
    database.close();
  }
};

/** The URL each app shows a group at. */
const t3GroupUrl = (group: PageGroup) =>
  group === "hero"
    ? values.t3
    : new URL(`${values["t3-env"]}/${T3_THREAD_ID}`, values.t3).toString();

/** The hero and thread groups, t3code's half: screenshots, HTML, landmarks, masks, the export. */
const capturePagesT3 = async (browser: Browser, group: PageGroup) => {
  const dir = path.join(BASELINE_ROOT, group);
  const png = await attachmentPng(browser);
  const records: Array<PageRecord> = [];

  mkdirSync(dir, { recursive: true });

  if (group === "thread") {
    writeFileSync(
      path.join(dir, "thread.json"),
      `${formatT3ThreadExport(exportT3Thread())}\n`
    );
  }

  for (const capture of PAGE_STATES[group]) {
    const context = await browser.newContext({
      ...pageContextOptions(capture.view),
      storageState: values.session,
    });

    const page = await context.newPage();

    await open(page, t3GroupUrl(group));
    await page.waitForTimeout(2500);
    await prepare(page);
    await (isThreadState(capture.state)
      ? enterThreadState(page, capture.state)
      : enterHeroState(page, capture.state, png));

    const clip = await captureState(page, dir, capture);

    records.push({
      group,
      view: capture.view.name,
      viewport: { width: capture.view.width, height: capture.view.height },
      mobile: capture.view.mobile,
      state: capture.state,
      clip,
      capturedAtMs: await page.evaluate(() => Date.now()),
      masks: await pageMasks(page, capture.view),
    });
    await context.close();
    console.log(`t3 ${group} ${capture.view.name} ${capture.state}`);
  }

  writeFileSync(
    path.join(dir, "states.json"),
    `${JSON.stringify(records, null, 2)}\n`
  );
  writeFileSync(
    path.join(dir, "version.json"),
    `${JSON.stringify(
      {
        package: "t3code-nightly-bin",
        version: installedVersion(),
        commit: T3_COMMIT,
        capturedAt: new Date(records[0]?.capturedAtMs ?? 0).toISOString(),
      },
      null,
      2
    )}\n`
  );
};

/** The hero and thread groups, Cairn's half, over one seeded in-process brain. */
const capturePagesCairn = async (
  browser: Browser,
  pageGroups: ReadonlyArray<PageGroup>
) => {
  const exported = await Effect.runPromise(
    parseT3ThreadExport(
      readFileSync(path.join(BASELINE_ROOT, "thread/thread.json"), "utf-8")
    )
  );

  const imported = importT3Thread(exported);

  // The hero names the project t3code's draft showed; its h1 text ends with the project.
  const heroProject =
    /in (?<project>.+)\?$/u.exec(
      /<h1[^>]*>(?<inner>[\s\S]*?)<\/h1>/u
        .exec(
          readFileSync(path.join(BASELINE_ROOT, "hero/1440-hero.html"), "utf-8")
        )
        ?.groups?.inner?.replaceAll(/<[^>]+>/gu, "")
        .trim() ?? ""
    )?.groups?.project ?? exported.projectTitle;

  const app = await startCairn({
    projectTitle: heroProject,
    threadTitle: exported.title,
    entries: imported.entries,
  });

  const png = await attachmentPng(browser);

  try {
    for (const group of pageGroups) {
      const dir = path.join(values.out, group);

      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "import.json"),
        `${JSON.stringify({ entries: imported.entries.length, skipped: imported.skipped }, null, 2)}\n`
      );

      for (const capture of PAGE_STATES[group]) {
        const context = await browser.newContext(
          pageContextOptions(capture.view)
        );

        const page = await context.newPage();
        const url = group === "hero" ? `${app.origin}/` : app.threadUrl;

        await open(page, url);
        await page.waitForTimeout(2500);
        await prepare(page);
        await (isThreadState(capture.state)
          ? enterThreadState(page, capture.state)
          : enterHeroState(page, capture.state, png));
        await captureState(page, dir, capture);

        // The structure control: the same page after one class string is sabotaged.
        if (capture.state === "hero" && capture.view.name === "1440") {
          await editor(page).evaluate((element) => {
            element.setAttribute(
              "class",
              `${element.getAttribute("class") ?? ""} text-2xl px-8`
            );
          });
          writeFileSync(
            path.join(dir, "1440-hero.sabotaged.landmarks.json"),
            `${JSON.stringify(await readLandmarks(page), null, 2)}\n`
          );
        }

        // The pixel control: the phone hero with the sidebar wrongly open.
        if (capture.state === "hero" && capture.view.mobile) {
          await page
            .getByRole("button", { name: "Toggle main sidebar" })
            .first()
            .click();
          await page.waitForTimeout(900);
          await shot(
            page,
            {
              x: 0,
              y: 0,
              width: capture.view.width,
              height: capture.view.height,
            },
            path.join(dir, "390-control-sidebar-open.png")
          );
        }

        await context.close();
        console.log(`cairn ${group} ${capture.view.name} ${capture.state}`);
      }
    }
  } finally {
    await app.stop();
  }
};

const browser = await chromium.launch();

try {
  if (side === "t3") {
    const version = installedVersion();
    const recorded = recordedVersion();

    if (version !== recorded) {
      throw new Error(
        `The installed t3code-nightly-bin is ${version}, but ADR 0015 records ${recorded}. Move the pin first.`
      );
    }

    for (const group of groups) {
      await (group === "sidebar"
        ? captureSidebarT3(browser)
        : capturePagesT3(browser, group));
    }
  } else {
    if (groups.includes("sidebar")) {
      await captureSidebarCairn(browser);
    }

    const pageGroups = groups.filter(
      (group): group is PageGroup => group !== "sidebar"
    );

    if (pageGroups.length > 0) {
      await capturePagesCairn(browser, pageGroups);
    }

    console.log(
      JSON.stringify({
        judge: "capture",
        side: "cairn",
        groups,
        out: values.out,
      })
    );
  }
} finally {
  await browser.close();
}
