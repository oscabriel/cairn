// The composer's Messages and the OutMessages it hands the root. Editor facts come from the
// `ComposerInput` Mount (Editor.ts), measurements from the footer and headline Mounts, results from
// the composer's Commands, and the rest from clicks in its view.

import { ControlsMeasurement } from "@cairn/client-logic/FooterLayout";
import { AttachmentRef } from "@cairn/protocol/Attachments";
import { ProjectId, SubmissionId, ThreadId } from "@cairn/protocol/Ids";
import { ModelCatalog, ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import { RuntimeMode } from "@cairn/protocol/Policy";
import { BranchesResult, SearchEntriesResult } from "@cairn/protocol/Projects";
import { ProjectShell } from "@cairn/protocol/Shell";
import { SkillList } from "@cairn/protocol/Skills";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { Message as AttachmentsMessage } from "../attachments/Message.ts";
import { OutboxItem } from "../connection/Outbox.ts";
import { EnvMode } from "../hero/ContextStrip.ts";
import { ComposerSettings, Draft, Popover } from "./Model.ts";

/** What a send key or button asks for. */
export const SubmitIntent = Schema.Literals([
  "foreground",
  "alternate",
  "background",
]);

export type SubmitIntent = typeof SubmitIntent.Type;

/** A key the editor hands to the open `/`, `@` or `$` menu. */
export const MenuKey = Schema.Literals([
  "ArrowUp",
  "ArrowDown",
  "Enter",
  "Tab",
  "Escape",
]);

export type MenuKey = typeof MenuKey.Type;

/** Everything the composer reacts to. */
export const Message = defineMessageUnion({
  /** The editor's text changed. Its selection follows in `ChangedSelection`. */
  ChangedDraft: { value: Schema.String },
  ChangedSelection: { start: Schema.Int, end: Schema.Int },
  FocusedEditor: {},
  BlurredEditor: {},
  PressedSubmitKey: { intent: SubmitIntent },
  PressedMenuKey: { key: MenuKey },
  /** ArrowUp on the first line or ArrowDown on the last, with nothing selected. */
  PressedHistoryKey: { direction: Schema.Literals(["backward", "forward"]) },
  /** A printable key pressed with focus outside any field: it starts typing into the composer. */
  TypedOutsideEditor: { text: Schema.String },
  ClickedSend: { alternate: Schema.Boolean },
  ClickedStop: { clearQueue: Schema.Boolean },
  ClickedWithdraw: { submissionId: SubmissionId },

  HighlightedMenuItem: { id: Schema.String },
  PickedMenuItem: { id: Schema.String },

  OpenedPopover: { popover: Popover },
  ClosedPopover: {},
  ChangedPopoverQuery: { query: Schema.String },
  MovedPopoverHighlight: { id: Schema.String },
  PickedModel: { model: ModelRef },
  ToggledFavoriteModel: { key: Schema.String },
  PickedThinking: { level: ThinkingLevel },
  PickedRuntimeMode: { mode: RuntimeMode },
  PickedProject: { projectId: ProjectId },
  ClickedAddProject: {},
  ClickedStartWithoutProject: {},
  PickedEnvMode: { mode: EnvMode },
  PickedBranch: { branch: Schema.String },

  MeasuredFooter: {
    width: Schema.Finite,
    hostWidth: Schema.Finite,
    measurement: ControlsMeasurement,
  },
  MeasuredHeadline: { inline: Schema.Boolean },
  ChangedSoftwareKeyboard: { open: Schema.Boolean },

  DetectedPlatform: { isMac: Schema.Boolean },
  LoadedDrafts: { drafts: Schema.Record(Schema.String, Draft) },
  LoadedSettings: { settings: ComposerSettings },
  MintedHomeDraft: { draftId: ThreadId },
  /** The hero's URL now names its draft (`/new/<draftId>`), so a reload restores it. */
  MovedHeroToDraftUrl: {},
  ElapsedDraftDebounce: { version: Schema.Int },
  HidPage: {},
  CompletedSaveDrafts: { version: Schema.Int, saved: Schema.Boolean },
  CompletedSaveSettings: { saved: Schema.Boolean },

  SucceededModels: { epoch: Schema.Int, catalog: ModelCatalog },
  SucceededSkills: { projectId: ProjectId, list: SkillList },
  ElapsedPathSearchDebounce: { projectId: ProjectId, query: Schema.String },
  SucceededPathSearch: {
    projectId: ProjectId,
    query: Schema.String,
    result: SearchEntriesResult,
  },
  /** The `@` search for `query` failed; the menu stops waiting and says why. */
  FailedPathSearch: {
    projectId: ProjectId,
    query: Schema.String,
    message: Schema.String,
  },
  SucceededBranches: { projectId: ProjectId, result: BranchesResult },
  SucceededScratch: { project: ProjectShell },
  /**
   * A turn is ready to go: ids minted (and the scratch project made, for a projectless launch);
   * `attachments` are the refs it carries, kept to restore it if refused.
   */
  PreparedTurn: {
    item: OutboxItem,
    navigateTo: Schema.Option(Schema.String),
    attachments: Schema.Array(AttachmentRef),
  },
  /** Sending could not start; the draft at `draftKey` and its attachments go back as they were. */
  FailedPrepareTurn: {
    draftKey: Schema.String,
    draft: Draft,
    attachments: Schema.Array(AttachmentRef),
    message: Schema.String,
  },
  FailedRequest: { message: Schema.String },
  /** A list the composer loads in the background could not be read; the surface that needs it says so. */
  FailedLoad: {
    what: Schema.Literals(["models", "skills", "branches"]),
    projectId: Schema.Option(ProjectId),
    message: Schema.String,
  },
  CompletedRequest: {},
  CompletedEditorCommand: {},
  GotAttachmentsMessage: { message: AttachmentsMessage },
});

export type Message = typeof Message.Type;

/** What the composer asks the root to do. */
export const OutMessage = defineMessageUnion({
  /**
   * Queue this mutation in the outbox, then go to `navigateTo` when there is one. `attachments` are
   * the refs the turn carries, which the root keeps until the brain has the turn.
   */
  Submitted: {
    item: OutboxItem,
    navigateTo: Schema.Option(Schema.String),
    attachments: Schema.Array(AttachmentRef),
  },
  /** The hero's "Add project" was chosen; the sidebar owns the folder dialog. */
  RequestedAddProject: {},
});

export type OutMessage = typeof OutMessage.Type;
