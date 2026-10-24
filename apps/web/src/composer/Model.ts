// The composer's state. One composer serves every route that takes input: a draft (the new-thread
// hero, at `/` and `/new/<draftId>`) and an open thread (docked under its transcript). What it needs
// from the rest of the app arrives as `ComposerContext`, which the root hands it after every update
// (`Update.ts`, `inform`); everything else here is the composer's own.
import {
  FollowUpBehavior,
  SendShortcut,
} from "@cairn/client-logic/ComposerLogic";
import { ComposerPromptHistoryPosition } from "@cairn/client-logic/ComposerPromptHistory";
import { ComposerTrigger } from "@cairn/client-logic/ComposerTrigger";
import { ControlsLayout } from "@cairn/client-logic/FooterLayout";
import { AttachmentId, ProjectId, ThreadId } from "@cairn/protocol/Ids";
import {
  ModelCatalog,
  ModelDefaults,
  ModelRef,
  ThinkingLevel,
} from "@cairn/protocol/Models";
import { RuntimeMode } from "@cairn/protocol/Policy";
import { BranchesResult, SearchEntry } from "@cairn/protocol/Projects";
import { ProjectShell, ThreadShell } from "@cairn/protocol/Shell";
import { SkillSummary } from "@cairn/protocol/Skills";
import { UsageSnapshot } from "@cairn/protocol/Usage";
import { Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import * as Attachments from "../attachments/Model.ts";
import { EnvMode } from "../hero/ContextStrip.ts";

/** What the composer writes into: nothing, the home draft, a named draft, or an open thread. */
export const ComposerTarget = defineTaggedUnion({
  None: {},
  /** The new-thread hero at `/`; its draft id is minted by the composer. */
  Home: {},
  /** A thread not launched yet, at `/new/<draftId>`. */
  Draft: { draftId: Schema.String },
  Thread: { threadId: ThreadId },
});

export type ComposerTarget = typeof ComposerTarget.Type;

/** What the root tells the composer after every update. */
export const ComposerContext = Schema.Struct({
  target: ComposerTarget,
  /** The connection's epoch and whether its client exists and the shell is live. */
  epoch: Schema.Int,
  hasClient: Schema.Boolean,
  live: Schema.Boolean,
  projects: Schema.Array(ProjectShell),
  /** The open thread's shell row, when the target is a thread the shell knows. */
  thread: Schema.Option(ThreadShell),
  /** The open thread's `pi.inbox` document, its queued inputs, when its stream has a snapshot. */
  inbox: Schema.Option(Schema.Json),
  /**
   * The prompts the user sent in the open thread, oldest first, for the arrow-key history. Only
   * these two parts of the thread's view, so a streamed token leaves the composer alone.
   */
  prompts: Schema.Array(
    Schema.Struct({ id: Schema.String, prompt: Schema.String })
  ),
  /** The server's default model and thinking level, from `session.hello`. */
  defaults: Schema.Option(ModelDefaults),
  /** The newest plan windows, for the usage meter. */
  usage: Schema.Option(UsageSnapshot),
});

export type ComposerContext = typeof ComposerContext.Type;

/** A context with no target, no connection and no data. */
export const emptyContext: ComposerContext = {
  target: ComposerTarget.None(),
  epoch: 0,
  hasClient: false,
  live: false,
  projects: [],
  thread: Option.none(),
  inbox: Option.none(),
  prompts: [],
  defaults: Option.none(),
  usage: Option.none(),
};

/**
 * One draft, saved on this device (plan D28). A thread's draft keeps only its text and
 * attachments; the launch settings matter only before a thread exists.
 */
export const Draft = Schema.Struct({
  text: Schema.String,
  attachments: Schema.Array(AttachmentId),
  /** A model the user picked for this draft; none follows the project's or the server's default. */
  model: Schema.Option(ModelRef),
  thinking: Schema.Option(ThinkingLevel),
  runtimeMode: RuntimeMode,
  projectId: Schema.Option(ProjectId),
  envMode: EnvMode,
  baseBranch: Schema.Option(Schema.String),
});

export type Draft = typeof Draft.Type;

/** A draft with nothing in it. */
export const emptyDraft: Draft = {
  text: "",
  attachments: [],
  model: Option.none(),
  thinking: Option.none(),
  runtimeMode: "full-access",
  projectId: Option.none(),
  envMode: "local",
  baseBranch: Option.none(),
};

/** The composer's settings on this device. */
export const ComposerSettings = Schema.Struct({
  sendShortcut: SendShortcut,
  followUpBehavior: FollowUpBehavior,
  /** Model keys (`modelPickerModelKey`) the user starred. */
  favoriteModels: Schema.Array(Schema.String),
});

export type ComposerSettings = typeof ComposerSettings.Type;

/** t3code's defaults: Enter sends, a send during a run queues. */
export const defaultSettings: ComposerSettings = {
  sendShortcut: "enter",
  followUpBehavior: "queue",
  favoriteModels: [],
};

/** A popover the footer, the hero or the context strip has open. At most one is open. */
export const Popover = defineTaggedUnion({
  ModelPicker: {
    query: Schema.String,
    highlighted: Schema.Option(Schema.String),
  },
  Thinking: {},
  RuntimeMode: {},
  Overflow: {},
  Project: { query: Schema.String, highlighted: Schema.Option(Schema.String) },
  EnvMode: {},
  Branch: { query: Schema.String },
});

export type Popover = typeof Popover.Type;

/** The `/`, `@` or `$` menu under the caret. */
export const TriggerMenu = Schema.Struct({
  trigger: ComposerTrigger,
  /** The item the user moved to, and the query it was picked under. */
  highlighted: Schema.Option(Schema.String),
  highlightedKey: Schema.Option(Schema.String),
});

export type TriggerMenu = typeof TriggerMenu.Type;

/** The `@` search's last request and answer. */
export const PathSearch = Schema.Struct({
  projectId: Schema.Option(ProjectId),
  /** The query the results answer. */
  query: Schema.String,
  /** The query waiting for its debounce or its answer. */
  pending: Schema.Option(Schema.String),
  entries: Schema.Array(SearchEntry),
});

export type PathSearch = typeof PathSearch.Type;

/** A selection in the editor, in UTF-16 offsets. */
export const Selection = Schema.Struct({ start: Schema.Int, end: Schema.Int });

export type Selection = typeof Selection.Type;

/** The footer's measured state. */
export const FooterState = Schema.Struct({
  /** The composer's own width, once measured. */
  width: Schema.Option(Schema.Finite),
  layout: ControlsLayout,
});

export type FooterState = typeof FooterState.Type;

/** The composer's Model. */
export const Model = Schema.Struct({
  context: ComposerContext,
  /** Every draft on this device, by `draftKey`. */
  drafts: Schema.Record(Schema.String, Draft),
  draftsLoaded: Schema.Boolean,
  /** Bumped on every draft change; the saver writes when it is ahead of `savedVersion`. */
  draftsVersion: Schema.Int,
  savedVersion: Schema.Int,
  /** The draft id behind the home hero, minted on first need. */
  homeDraftId: Schema.Option(Schema.String),
  settings: ComposerSettings,
  isMac: Schema.Boolean,
  softKeyboardOpen: Schema.Boolean,
  focused: Schema.Boolean,
  selection: Selection,
  triggerMenu: Schema.Option(TriggerMenu),
  /** A trigger the user dismissed with Escape stays closed until the caret leaves it. */
  dismissedTrigger: Schema.Option(Schema.String),
  pathSearch: PathSearch,
  skills: Schema.Option(
    Schema.Struct({ projectId: ProjectId, list: Schema.Array(SkillSummary) })
  ),
  catalog: Schema.Option(ModelCatalog),
  /** Why the models could not be loaded, shown in the picker. */
  catalogError: Schema.Option(Schema.String),
  branches: Schema.Option(
    Schema.Struct({ projectId: ProjectId, result: BranchesResult })
  ),
  popover: Schema.Option(Popover),
  history: Schema.Option(ComposerPromptHistoryPosition),
  footer: FooterState,
  headlineInline: Schema.Boolean,
  /** Why the last send did not go, or another note for the user. */
  notice: Schema.Option(Schema.String),
  /** Every draft's attachment tray (pasted, dropped and picked files, and their uploads). */
  attachments: Attachments.Model,
});

export type Model = typeof Model.Type;

/** The composer before anything is known. */
export const initial: Model = {
  context: emptyContext,
  drafts: {},
  draftsLoaded: false,
  draftsVersion: 0,
  savedVersion: 0,
  homeDraftId: Option.none(),
  settings: defaultSettings,
  isMac: false,
  softKeyboardOpen: false,
  focused: false,
  selection: { start: 0, end: 0 },
  triggerMenu: Option.none(),
  dismissedTrigger: Option.none(),
  pathSearch: {
    projectId: Option.none(),
    query: "",
    pending: Option.none(),
    entries: [],
  },
  skills: Option.none(),
  catalog: Option.none(),
  catalogError: Option.none(),
  branches: Option.none(),
  popover: Option.none(),
  history: Option.none(),
  footer: {
    width: Option.none(),
    layout: { hiddenCount: 0, iconOnlyCount: 0, visible: true },
  },
  headlineInline: true,
  notice: Option.none(),
  attachments: Attachments.initial,
};
