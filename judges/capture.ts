/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- a judge drives one browser state after another, on purpose */
// The parity capture judge for the sidebar: captures named sidebar states from the installed t3code
// nightly once, into a committed baseline, and compares Cairn's sidebar in the same states against it.
//
//   node judges/capture.ts t3 [--session <storage state>] [--t3 https://t3.gneiss.run/]
//   node judges/capture.ts cairn [--out <dir>]
//
// `t3` refuses to write unless the installed `t3code-nightly-bin` is the version ADR 0015 records,
// and writes judges/fixtures/parity/t3@fe27e8e3/sidebar/: one PNG and one sidebar HTML per state and
// width, `states.json` (the clip and masks of each capture), `fixture.json` (the rows t3code showed,
// read from its DOM) and `version.json`. `cairn` starts `pnpm dev` on throwaway ports, serves the
// fixture to the page as boot data with the clock fixed at the capture time and the socket refused,
// drives the same states, and writes Cairn's PNGs, diff PNGs and `report.json` (the share of pixels
// that differ outside the masks, per state) to `--out`. States: the shelves, the settled shelf open,
// a search, a hovered row and an open row menu at 1440x900; the shelves, the settled shelf and a
// search in the sheet at 390x844. Masks: the brand band (the top 80px, t3code's starfield and
// wordmark), the footer (t3code's pull requests and update pill), and per state the parts the
// read-only pairing changes (listed in `states.json`). Exits 0 when every state reads 0 percent.
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
import { parseArgs } from "node:util";

import { DateTime, Option, Schema } from "effect";
import { chromium } from "playwright";
import type { Browser, BrowserContextOptions, Page } from "playwright";

import { EntryId, ProjectId, ThreadId } from "../packages/protocol/src/Ids.ts";
import {
  ProjectShell,
  ShellSnapshot,
  ThreadShell,
} from "../packages/protocol/src/Shell.ts";

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
        "Developer/agent-artifacts/cairn/v2/parity-2d"
      ),
    },
  },
});

const [side] = positionals;

if (side !== "t3" && side !== "cairn") {
  throw new Error(
    "usage: capture.ts t3|cairn [--session <file>] [--t3 <url>] [--out <dir>]"
  );
}

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

/** A rectangle in CSS pixels of the viewport. */
const Rect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

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
        // oxlint-disable-next-line unicorn/consistent-function-scoping
        const text = (element: Element | null | undefined) =>
          element?.textContent?.trim() ?? "";

        const scope = document.querySelector(sidebarSelector) ?? document;

        // oxlint-disable-next-line unicorn/consistent-function-scoping
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

const captureT3 = async (browser: Browser) => {
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

interface Comparison {
  readonly differingPercent: number;
  readonly diff: string;
}

/** Compares two same-sized PNGs outside the masks: the share of pixels differing by more than 24. */
const compare = async (
  page: Page,
  left: string,
  right: string,
  masks: StateRecord["masks"]
): Promise<Comparison> =>
  await page.evaluate(
    async ([a, b, rects]) => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const image = async (src: string) => {
        const element = new Image();

        element.src = src;
        await element.decode();

        return element;
      };

      const leftImage = await image(a);
      const rightImage = await image(b);
      const width = Math.min(leftImage.width, rightImage.width);
      const height = Math.min(leftImage.height, rightImage.height);

      const pixels = (source: HTMLImageElement) => {
        const canvas = document.createElement("canvas");

        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");

        if (context === null) {
          throw new Error("no 2d context");
        }

        context.drawImage(source, 0, 0);
        context.fillStyle = "#000";

        for (const rect of rects) {
          context.fillRect(
            rect.x * 2,
            rect.y * 2,
            rect.width * 2,
            rect.height * 2
          );
        }

        return context.getImageData(0, 0, width, height).data;
      };

      const pa = pixels(leftImage);
      const pb = pixels(rightImage);
      const diff = new ImageData(width, height);
      let differing = 0;

      for (let index = 0; index < pa.length; index += 4) {
        const delta =
          Math.abs((pa[index] ?? 0) - (pb[index] ?? 0)) +
          Math.abs((pa[index + 1] ?? 0) - (pb[index + 1] ?? 0)) +
          Math.abs((pa[index + 2] ?? 0) - (pb[index + 2] ?? 0));

        const differs = delta > 24;

        if (differs) {
          differing += 1;
        }

        diff.data[index] = differs ? 255 : (pa[index] ?? 0) / 3;
        diff.data[index + 1] = differs ? 0 : (pa[index + 1] ?? 0) / 3;
        diff.data[index + 2] = differs ? 255 : (pa[index + 2] ?? 0) / 3;
        diff.data[index + 3] = 255;
      }

      const canvas = document.createElement("canvas");

      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")?.putImageData(diff, 0, 0);

      return {
        differingPercent: Number(
          ((differing / (width * height)) * 100).toFixed(3)
        ),
        diff: canvas.toDataURL("image/png"),
      };
    },
    [left, right, masks] as const
  );

const dataUrl = (file: string) =>
  `data:image/png;base64,${readFileSync(file).toString("base64")}`;

const captureCairn = async (browser: Browser) => {
  const states = decodeStates(
    readFileSync(path.join(BASELINE, "states.json"), "utf-8")
  );

  const fixture = decodeFixture(
    readFileSync(path.join(BASELINE, "fixture.json"), "utf-8")
  );

  const { out } = values;
  const dev = await startDev();
  const report: Record<string, number> = {};

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

      const file = path.join(out, `${record.view}-${record.state}-cairn.png`);

      await shot(page, record.clip, file);
      writeFileSync(
        path.join(out, `${record.view}-${record.state}-cairn.html`),
        `${await sidebarHtml(page, view)}\n`
      );

      const result = await compare(
        page,
        dataUrl(path.join(BASELINE, `${record.view}-${record.state}.png`)),
        dataUrl(file),
        record.masks
      );

      writeFileSync(
        path.join(out, `${record.view}-${record.state}-diff.png`),
        Buffer.from(result.diff.split(",")[1] ?? "", "base64")
      );
      report[`${record.view}-${record.state}`] = result.differingPercent;
      await context.close();
      console.log(
        `cairn ${record.view} ${record.state}: ${result.differingPercent}%`
      );
    }
  } finally {
    dev.stop();
    rmSync(dev.dataDir, { recursive: true, force: true });
  }

  writeFileSync(
    path.join(out, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );

  const pass = Object.values(report).every((percent) => percent === 0);

  console.log(
    JSON.stringify({ judge: "capture", side: "cairn", pass, report })
  );
  process.exitCode = pass ? 0 : 1;
};

const browser = await chromium.launch();

try {
  await (side === "t3" ? captureT3(browser) : captureCairn(browser));
} finally {
  await browser.close();
}
