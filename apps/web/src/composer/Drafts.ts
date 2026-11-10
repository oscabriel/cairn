// Ported in shape from github.com/pingdotgg/t3code, apps/web/src/composerDraftStore.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92 (shape only, no code): drafts live in localStorage per
// thread or draft id, written after a 300 ms pause and on `pagehide`, with attachments kept as ids
// rather than data. Changed: Cairn's record is small (plan D28) and keyed `cairn:composer-drafts:v1`,
// and a save writes only the drafts this tab changed, so tabs keep each other's (`TabChanges.ts`).
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import type { ProjectShell } from "@cairn/protocol/Shell";
import { Array, DateTime, Effect, Option, Order, Record, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";

import {
  applyRecordChanges,
  loadShared,
  mergeRecord,
  mergeStored,
  recordChanges,
  persistedRecord,
} from "../storage/TabChanges.ts";
import type { Loaded } from "../storage/TabChanges.ts";
import {
  ComposerSettings,
  ComposerTarget,
  Draft,
  emptyDraft,
} from "./Model.ts";
import type { Model } from "./Model.ts";

/**
 * The localStorage key every draft is saved under, as one JSON object of `Draft`s by draft key. Add
 * a field to `Draft` as optional, or a literal, and an older build keeps the drafts it cannot decode
 * as stored (`TabChanges.ts`); change what a stored field means, or the object's outer shape, and
 * bump the version.
 */
export const DRAFTS_STORAGE_KEY = "cairn:composer-drafts:v1";

/** The localStorage key of the composer's settings. */
export const SETTINGS_STORAGE_KEY = "cairn:composer-settings:v1";

/** How long typing must pause before drafts are written. */
export const DRAFT_SAVE_DEBOUNCE_MS = 300;

/** The key of the draft the composer edits now, or none when it has no target yet. */
export const draftKey = (model: Model): Option.Option<string> =>
  ComposerTarget.match(model.context.target, {
    None: () => Option.none(),
    Home: () => Option.map(model.homeDraftId, (id) => `draft:${id}`),
    Draft: ({ draftId }) => Option.some(`draft:${draftId}`),
    Thread: ({ threadId }) => Option.some(`thread:${threadId}`),
  });

/** The notice to show now: one about the open draft, or one about no one draft. */
export const shownNotice = (model: Model): Option.Option<string> =>
  Option.map(
    Option.filter(model.notice, (notice) =>
      Option.match(notice.draftKey, {
        onNone: () => true,
        onSome: (key) => Option.contains(draftKey(model), key),
      })
    ),
    (notice) => notice.text
  );

/** The draft id a new thread launches with: the URL's draft, or the home hero's. */
export const draftThreadId = (model: Model): Option.Option<string> =>
  ComposerTarget.match(model.context.target, {
    None: () => Option.none(),
    Home: () => model.homeDraftId,
    Draft: ({ draftId }) => Option.some(draftId),
    Thread: () => Option.none(),
  });

/** True when the composer writes a thread that does not exist yet. */
export const isDraftTarget = (model: Model): boolean =>
  ComposerTarget.match(model.context.target, {
    None: () => false,
    Home: () => true,
    Draft: () => true,
    Thread: () => false,
  });

/** The draft the composer edits now; an untouched draft is empty. */
export const activeDraft = (model: Model): Draft =>
  Option.getOrElse(
    Option.flatMap(draftKey(model), (key) => Record.get(model.drafts, key)),
    () => emptyDraft
  );

const isEmpty = (draft: Draft): boolean =>
  draft.text.length === 0 &&
  draft.attachments.length === 0 &&
  Option.isNone(draft.model) &&
  Option.isNone(draft.thinking) &&
  Option.isNone(draft.projectId) &&
  Option.isNone(draft.baseBranch) &&
  draft.envMode === "local" &&
  draft.runtimeMode === "full-access";

/** The Model with the active draft changed by `change`; an emptied draft is dropped. */
export const modifyActiveDraft = (
  model: Model,
  change: (draft: Draft) => Draft
): Model =>
  Option.match(draftKey(model), {
    onNone: () => model,
    onSome: (key) => {
      const next = change(activeDraft(model));

      const drafts = isEmpty(next)
        ? Record.remove(model.drafts, key)
        : Record.set(model.drafts, key, next);

      return { ...model, drafts, draftsVersion: model.draftsVersion + 1 };
    },
  });

const byRecentUpdate = Order.mapInput(
  Order.flip(DateTime.Order),
  (project: ProjectShell) => project.updatedAt
);

/** The folder projects the hero offers, most recently updated first. */
export const pickableProjects = (model: Model): ReadonlyArray<ProjectShell> =>
  Array.sort(
    Array.filter(
      model.context.projects,
      (project) => project.kind === "folder"
    ),
    byRecentUpdate
  );

/**
 * The project a new thread launches in: the one the draft chose, else the most recently updated
 * folder project. None when there is no project (the hero then offers to start without one).
 */
export const draftProject = (model: Model): Option.Option<ProjectShell> => {
  const draft = activeDraft(model);

  return Option.match(draft.projectId, {
    onNone: () => Array.head(pickableProjects(model)),
    onSome: (id) =>
      Array.findFirst(model.context.projects, (project) => project.id === id),
  });
};

/** The project of the composer's target: a draft's project or the open thread's. */
export const targetProject = (model: Model): Option.Option<ProjectShell> =>
  isDraftTarget(model)
    ? draftProject(model)
    : Option.flatMap(model.context.thread, (thread) =>
        Array.findFirst(
          model.context.projects,
          (project) => project.id === thread.projectId
        )
      );

const persistedDrafts = persistedRecord(Schema.toCodecJson(Draft));

const SettingsJson = Schema.fromJsonString(
  Schema.toCodecJson(ComposerSettings)
);

const decodeSettings = Schema.decodeEffect(SettingsJson);

const encodeSettings = Schema.encodeEffect(SettingsJson);

/**
 * Reads every saved draft this build can decode, and whether storage holds drafts it cannot. Missing
 * storage is no drafts: typing must never wait on it. A draft this build cannot decode, or a value
 * it cannot read at all, is left as stored, and never written over.
 */
export const readDrafts: Effect.Effect<
  Loaded<Record<string, Draft>>,
  never,
  KeyValueStore.KeyValueStore
> = loadShared(DRAFTS_STORAGE_KEY, persistedDrafts);

/** The saved drafts this build can decode (`readDrafts`). */
export const loadDrafts: Effect.Effect<
  Record<string, Draft>,
  never,
  KeyValueStore.KeyValueStore
> = Effect.map(readDrafts, ({ value }) => value);

const draftEquivalence = Schema.toEquivalence(Draft);

const draftChanges = recordChanges(draftEquivalence);

/**
 * Writes the drafts this tab changed or removed since `base` (the drafts as it last read or wrote
 * them) into what storage holds now, so another tab's drafts are kept, and writes back a draft of
 * this tab's that another tab's write dropped without removing it. Answers what storage holds
 * afterwards, or none when storage refused.
 */
export const saveDrafts = (
  base: Record<string, Draft>,
  drafts: Record<string, Draft>
): Effect.Effect<
  Option.Option<Record<string, Draft>>,
  never,
  KeyValueStore.KeyValueStore
> =>
  mergeStored(
    DRAFTS_STORAGE_KEY,
    persistedDrafts,
    mergeRecord(draftEquivalence)(base, drafts)
  );

/**
 * This tab's drafts once storage holds `stored`: what it changed since `written` (the drafts it
 * last wrote or read) stays, and every other draft is as stored, so other tabs' writes show here.
 */
export const rebaseDrafts = (
  written: Record<string, Draft>,
  mine: Record<string, Draft>,
  stored: Record<string, Draft>
): Record<string, Draft> =>
  applyRecordChanges(stored, draftChanges(written, mine));

/** Reads the composer's settings, falling back to the defaults. */
export const loadSettings = (
  fallback: ComposerSettings
): Effect.Effect<ComposerSettings, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const saved = yield* store.get(SETTINGS_STORAGE_KEY);

    return yield* Option.match(Option.fromUndefinedOr(saved), {
      onNone: () => Effect.succeed(fallback),
      onSome: decodeSettings,
    });
  }).pipe(Effect.orElseSucceed(() => fallback));

/** Writes the composer's settings; false when storage refused. */
export const saveSettings = (
  settings: ComposerSettings
): Effect.Effect<boolean, never, KeyValueStore.KeyValueStore> =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const json = yield* encodeSettings(settings);

    yield* store.set(SETTINGS_STORAGE_KEY, json);

    return true;
  }).pipe(Effect.orElseSucceed(() => false));
