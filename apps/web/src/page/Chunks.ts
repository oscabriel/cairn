// The views a cold load never draws, each fetched as its own chunk (ADR 0021, amended 2026-11-10):
// the settings page, the usage page, the composer's popovers (the model picker and its menus), the
// add-project picker, the work and goal panels, the refresh confirm and the rename and remove
// dialog. Their state, Messages and updates stay in the entry, so the Model is whole from the first
// update; only the views, and what they alone import, come later.
//
// A chunk is fetched the first time its view is wanted (the root's `wantedChunks`), and every chunk
// is fetched once more ahead of need a second after the page is interactive, so a later open draws
// at once and the load judge's count of requests before interactive is unchanged. A module is code,
// not state: it is held outside the Model, as the diff panel's view and the shiki grammars are, and
// the Model records each chunk's progress, so the view that waits on one is drawn again when it
// arrives. A view whose chunk is not in yet draws nothing. A failed fetch tells the root, which says
// so in the notice bar and closes the view that waited (a touch screen has no Escape, and the view's
// Cancel never drew), so its control's next tap opens it again and the chunk is asked for again. A
// page's route is not closed: the next navigation, to it or away and back, asks again.

import { Duration, Effect, Option, Predicate, Schedule, Schema } from "effect";
import { Command } from "foldkit";
import type { Update } from "foldkit";
import { focus } from "foldkit/dom";
import { defineMessageUnion } from "foldkit/message";
import { makeModifyFieldsFor, modifyFields } from "foldkit/struct";

import type * as Popovers from "../composer/Popovers.ts";
import { INTERACTIVE_MARK } from "../load/LoadMark.ts";
import type * as UsageView from "../meters/UsageView.ts";
import type { Model as RootModel } from "../Model.ts";
import type * as SettingsPage from "../settings/Page.ts";
import type * as AddProject from "../shell/AddProject.ts";
import type * as GoalPanel from "../shell/GoalPanel.ts";
import type * as ManageDialog from "../shell/ManageDialog.ts";
import type * as Refresh from "../shell/Refresh.ts";
import type * as WorkPanel from "../shell/WorkPanel.ts";

/** The views fetched on demand, one chunk each. */
export const ChunkName = Schema.Literals([
  "settings",
  "usage",
  "popovers",
  "addProject",
  "workPanel",
  "goalPanel",
  "refresh",
  "manageDialog",
]);

export type ChunkName = typeof ChunkName.Type;

/** Every chunk, in the order the warm-up fetches them. */
export const CHUNKS: ReadonlyArray<ChunkName> = ChunkName.literals;

/** Where a chunk is: not asked for, on its way after its view was wanted, in, or failed. */
export const ChunkState = Schema.Literals([
  "idle",
  "loading",
  "loaded",
  "failed",
]);

export type ChunkState = typeof ChunkState.Type;

/** Each chunk's progress; the root keeps it so a view drawn before its chunk is drawn again. */
export const Model = Schema.Struct({
  settings: ChunkState,
  usage: ChunkState,
  popovers: ChunkState,
  addProject: ChunkState,
  workPanel: ChunkState,
  goalPanel: ChunkState,
  refresh: ChunkState,
  manageDialog: ChunkState,
});

export type Model = typeof Model.Type;

/** Nothing asked for yet. */
export const initial: Model = {
  settings: "idle",
  usage: "idle",
  popovers: "idle",
  addProject: "idle",
  workPanel: "idle",
  goalPanel: "idle",
  refresh: "idle",
  manageDialog: "idle",
};

/** Everything the chunks react to. */
export const Message = defineMessageUnion({
  /** `chunk` arrived after its view was wanted; its view draws from the next render. */
  LoadedChunk: { chunk: ChunkName },
  /** `chunk` could not be fetched. */
  FailedChunk: { chunk: ChunkName },
  /** The chunks the warm-up fetched ahead of need, once the page was interactive. */
  WarmedChunks: { chunks: Schema.Array(ChunkName) },
  /** The field an arrived view opens with was given focus, or was gone. */
  CompletedChunkFocus: {},
});

/** A chunks Message. */
export type Message = typeof Message.Type;

/** What the chunks hand the root. */
export const OutMessage = defineMessageUnion({
  /** `chunk` failed after its view was wanted: the root tells the user. */
  FailedChunk: { chunk: ChunkName },
});

/** A chunks OutMessage. */
export type OutMessage = typeof OutMessage.Type;

/** Each chunk's module, as its view's import site reads it. */
interface ChunkModules {
  readonly settings: typeof SettingsPage;
  readonly usage: typeof UsageView;
  readonly popovers: typeof Popovers;
  readonly addProject: typeof AddProject;
  readonly workPanel: typeof WorkPanel;
  readonly goalPanel: typeof GoalPanel;
  readonly refresh: typeof Refresh;
  readonly manageDialog: typeof ManageDialog;
}

/** One chunk: its fetch, made once and shared, and its module once it is in. */
interface Slot<A> {
  /** Fetches the module, sharing a fetch on its way; a failed fetch is forgotten, for a retry. */
  readonly fetch: () => Promise<void>;
  readonly module: () => Option.Option<A>;
  readonly isIn: () => boolean;
}

const slotOf = <A>(load: () => Promise<A>): Slot<A> => {
  // Held outside the Model on purpose: a module is code, not state. One key each, set once.
  const held = new Map<"module", A>();
  const fetches = new Map<"fetch", Promise<void>>();

  const fetchOnce = async (): Promise<void> => {
    held.set("module", await load());
  };

  const fetchShared = async (): Promise<void> => {
    const existing = fetches.get("fetch");

    if (existing !== undefined) {
      await existing;

      return;
    }

    const fetching = fetchOnce();

    fetches.set("fetch", fetching);

    try {
      await fetching;
    } catch (error) {
      fetches.delete("fetch");

      throw error;
    }
  };

  return {
    fetch: fetchShared,
    module: () => Option.fromNullishOr(held.get("module")),
    isIn: () => held.has("module"),
  };
};

/** Every chunk's slot, each typed by its own module. */
type Slots = { readonly [K in ChunkName]: Slot<ChunkModules[K]> };

const SLOTS: Slots = {
  settings: slotOf(async () => await import("../settings/Page.ts")),
  usage: slotOf(async () => await import("../meters/UsageView.ts")),
  popovers: slotOf(async () => await import("../composer/Popovers.ts")),
  addProject: slotOf(async () => await import("../shell/AddProject.ts")),
  workPanel: slotOf(async () => await import("../shell/WorkPanel.ts")),
  goalPanel: slotOf(async () => await import("../shell/GoalPanel.ts")),
  refresh: slotOf(async () => await import("../shell/Refresh.ts")),
  manageDialog: slotOf(async () => await import("../shell/ManageDialog.ts")),
};

/** True once `chunk`'s module is in. */
const isIn = (chunk: ChunkName): boolean => SLOTS[chunk].isIn();

/** A chunk could not be fetched (offline, or a deploy removed the file this page names). */
export class ChunkLoadError extends Schema.TaggedError<ChunkLoadError>()(
  "ChunkLoadError",
  { chunk: ChunkName, cause: Schema.Defect() }
) {}

/** Fetches `chunk` once per page, sharing a fetch already on its way. */
export const fetchChunk = (chunk: ChunkName) =>
  Effect.tryPromise({
    try: async () => {
      await SLOTS[chunk].fetch();
    },
    catch: (cause) => new ChunkLoadError({ chunk, cause }),
  });

/** `chunk`'s module once it has arrived; a view draws nothing of it before. */
export const chunkModule = <K extends ChunkName>(
  chunk: K
): Option.Option<ChunkModules[K]> => SLOTS[chunk].module();

/**
 * The field each view takes focus in when it opens, which a view drawn late takes on arrival. The
 * shell's overlays are dialogs (`ui/Sheet.ts`), which move focus in as they mount, whenever
 * their chunk arrives, and back to what held it when they close; a focus from here would land
 * first and become the place focus goes back to.
 */
const FOCUS_ON_ARRIVAL: Readonly<Record<ChunkName, Option.Option<string>>> = {
  settings: Option.none(),
  usage: Option.none(),
  // The search field `FocusPopoverSearch` focuses (`composer/Command.ts`).
  popovers: Option.some('[data-testid="composer-popover-search"]'),
  addProject: Option.none(),
  workPanel: Option.none(),
  goalPanel: Option.none(),
  refresh: Option.none(),
  manageDialog: Option.none(),
};

/** How the chunks are named to the user when one fails. */
const LABELS: Readonly<Record<ChunkName, string>> = {
  settings: "The settings page",
  usage: "The usage page",
  popovers: "The composer's menu",
  addProject: "The add-project picker",
  workPanel: "The work panel",
  goalPanel: "The goal panel",
  refresh: "The refresh confirm",
  manageDialog: "The rename and remove dialog",
};

/** The notice bar's words for a chunk that failed. */
export const failureNotice = (chunk: ChunkName): string =>
  `${LABELS[chunk]} could not load. Open it again to try again.`;

/** Fetches `chunk` because its view is wanted. */
export const LoadChunk = Command.define("LoadChunk", {
  args: { chunk: ChunkName },
  messages: [Message.LoadedChunk, Message.FailedChunk],
  execute: ({ chunk }) =>
    fetchChunk(chunk).pipe(
      Effect.match({
        onSuccess: () => Message.LoadedChunk({ chunk }),
        onFailure: () => Message.FailedChunk({ chunk }),
      })
    ),
});

/** How often the warm-up looks for the interactive mark, and how long it looks. */
const MARK_POLL = Duration.millis(100);

const MARK_WAIT = Duration.seconds(30);

/**
 * How long after the mark the warm-up waits: the load judge counts the requests that start before
 * it reads the mark, a few frames after the page sets it.
 */
const WARM_DELAY = Duration.seconds(1);

const isInteractive = () =>
  performance.getEntriesByName(INTERACTIVE_MARK).length > 0;

/**
 * Fetches every chunk ahead of need once the page is interactive (or has not become so in 30 s);
 * a chunk that fails is left for its view to ask for again.
 */
export const WarmChunks = Command.define("WarmChunks", {
  messages: [Message.WarmedChunks],
  execute: Effect.gen(function* () {
    yield* Effect.sync(isInteractive).pipe(
      Effect.repeat({
        until: (interactive) => interactive,
        schedule: Schedule.spaced(MARK_POLL),
      }),
      Effect.timeoutOption(MARK_WAIT)
    );
    yield* Effect.sleep(WARM_DELAY);

    const arrived = yield* Effect.forEach(
      CHUNKS,
      (chunk) => fetchChunk(chunk).pipe(Effect.as(chunk), Effect.option),
      { concurrency: "unbounded" }
    );

    return Message.WarmedChunks({ chunks: arrived.flatMap(Option.toArray) });
  }),
});

/** Puts the keyboard in the field an arrived view opens with, when the view is still open. */
const FocusOnArrival = Command.define("FocusOnArrival", {
  args: { selector: Schema.String },
  messages: [Message.CompletedChunkFocus],
  execute: ({ selector }) =>
    focus(selector).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedChunkFocus())
    ),
});

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>;

type StepReturn = Update.Return<Model, Message>;

const withState = (model: Model, chunk: ChunkName, state: ChunkState): Model =>
  model[chunk] === state ? model : { ...model, [chunk]: state };

/** The page's start: the warm-up waits for the page to be interactive. */
export const start = (model: Model): StepReturn => ({
  model,
  commands: [WarmChunks()],
});

/** The chunks' update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    LoadedChunk: ({ chunk }) => ({
      model: withState(model, chunk, "loaded"),
      commands: Option.match(FOCUS_ON_ARRIVAL[chunk], {
        onNone: () => [],
        onSome: (selector) => [FocusOnArrival({ selector })],
      }),
    }),
    FailedChunk: ({ chunk }) => ({
      model: withState(model, chunk, "failed"),
      outMessage: OutMessage.FailedChunk({ chunk }),
    }),
    // A chunk on its way for its view is left to its own Message, which focuses its field.
    WarmedChunks: ({ chunks }) => {
      let next = model;

      for (const chunk of chunks) {
        if (next[chunk] === "idle") {
          next = withState(next, chunk, "loaded");
        }
      }

      return { model: next };
    },
    CompletedChunkFocus: () => ({ model }),
  });

/** True when every wanted chunk is asked for or in, and no unwanted one is marked failed. */
export const isServed = (
  model: Model,
  wanted: ReadonlyArray<ChunkName>
): boolean =>
  CHUNKS.every((chunk) =>
    wanted.includes(chunk) ? model[chunk] !== "idle" : model[chunk] !== "failed"
  );

/** A chunk's state once the page says whether its view is wanted and whether its module is in. */
const stateFor = (
  state: ChunkState,
  isWanted: boolean,
  arrived: boolean
): ChunkState => {
  if (!isWanted) {
    return state === "failed" ? "idle" : state;
  }

  if (state !== "idle") {
    return state;
  }

  return arrived ? "loaded" : "loading";
};

/**
 * Asks for each wanted chunk not yet asked for, or marks it in when the warm-up already holds it;
 * a failed chunk no longer wanted goes back to idle, so its view's next open tries again.
 */
export const want = (
  model: Model,
  wanted: ReadonlyArray<ChunkName>
): StepReturn => {
  const asked = CHUNKS.filter(
    (chunk) => wanted.includes(chunk) && model[chunk] === "idle" && !isIn(chunk)
  );

  let next = model;

  for (const chunk of CHUNKS) {
    next = withState(
      next,
      chunk,
      stateFor(next[chunk], wanted.includes(chunk), isIn(chunk))
    );
  }

  return {
    model: next,
    commands: asked.map((chunk) => LoadChunk({ chunk })),
  };
};

/** What the root's page reads to know which views it draws. */
type PageState = Pick<RootModel, "route" | "composer" | "nextShell">;

/** When each chunk's view is drawn. */
const IS_WANTED: Readonly<Record<ChunkName, (model: PageState) => boolean>> = {
  settings: (model) => Predicate.isTagged(model.route, "Settings"),
  usage: (model) => Predicate.isTagged(model.route, "Usage"),
  popovers: (model) => Option.isSome(model.composer.popover),
  addProject: (model) => Option.isSome(model.nextShell.addProject),
  workPanel: (model) => model.nextShell.work.isOpen,
  goalPanel: (model) => model.nextShell.goal.isOpen,
  refresh: (model) => Option.isSome(model.nextShell.refresh),
  manageDialog: (model) => Option.isSome(model.nextShell.manage),
};

/** The chunks the root's page wants drawn now. */
export const wantedChunks = (model: PageState): ReadonlyArray<ChunkName> =>
  CHUNKS.filter((chunk) => IS_WANTED[chunk](model));

const modifyPage = makeModifyFieldsFor<PageState>();

/** How the root closes each chunk's view when the chunk fails; a page's route stays as it is. */
const CLOSE: Readonly<Record<ChunkName, <M extends PageState>(model: M) => M>> =
  {
    settings: (model) => model,
    usage: (model) => model,
    popovers: (model) =>
      modifyPage(model, {
        composer: (composer) =>
          modifyFields(composer, { popover: () => Option.none() }),
      }),
    addProject: (model) =>
      modifyPage(model, {
        nextShell: (shell) =>
          modifyFields(shell, { addProject: () => Option.none() }),
      }),
    workPanel: (model) =>
      modifyPage(model, {
        nextShell: (shell) =>
          modifyFields(shell, {
            work: (work) => modifyFields(work, { isOpen: () => false }),
          }),
      }),
    goalPanel: (model) =>
      modifyPage(model, {
        nextShell: (shell) =>
          modifyFields(shell, {
            goal: (goal) => modifyFields(goal, { isOpen: () => false }),
          }),
      }),
    refresh: (model) =>
      modifyPage(model, {
        nextShell: (shell) =>
          modifyFields(shell, { refresh: () => Option.none() }),
      }),
    manageDialog: (model) =>
      modifyPage(model, {
        nextShell: (shell) =>
          modifyFields(shell, { manage: () => Option.none() }),
      }),
  };

/**
 * Closes the view that waited for `chunk`, which failed: its control's next tap is a real open, so
 * the chunk is asked for again (`want` puts a failed chunk no longer wanted back to idle).
 */
export const closeWaiting = <M extends PageState>(
  chunk: ChunkName,
  model: M
): M => CLOSE[chunk](model);

/** A navigation is a new open: every failed chunk goes back to idle, so a page's chunk is asked again. */
export const navigated = (model: Model): Model => {
  let next = model;

  for (const chunk of CHUNKS) {
    if (next[chunk] === "failed") {
      next = withState(next, chunk, "idle");
    }
  }

  return next;
};
