// The settings page's state: what the root tells it (the connection, whether the page is open, the
// projects), this device's settings, and what the brain answered for each section. Plan windows
// arrive on their own stream whenever a client exists, because the composer's meter reads them on
// every page.

import { ExecutorStatus } from "@cairn/protocol/Executor";
import { ProjectId } from "@cairn/protocol/Ids";
import { ModelCatalog, ProviderStatus } from "@cairn/protocol/Models";
import { ServerSettings } from "@cairn/protocol/Settings";
import { SkillList } from "@cairn/protocol/Skills";
import { UsageSnapshot } from "@cairn/protocol/Usage";
import { Option, Schema } from "effect";
import * as AsyncData from "foldkit/asyncData";

import { ClientSettings, DEFAULT_CLIENT_SETTINGS } from "./ClientSettings.ts";

/** A project the Skills section can be pointed at. */
export const SettingsProject = Schema.Struct({
  id: ProjectId,
  title: Schema.String,
});

export type SettingsProject = typeof SettingsProject.Type;

/** What the root tells the settings page on every change. */
export const SettingsContext = Schema.Struct({
  epoch: Schema.Int,
  hasClient: Schema.Boolean,
  /** True while the route is the settings page; the brain is asked only then. */
  isOpen: Schema.Boolean,
  projects: Schema.Array(SettingsProject),
});

export type SettingsContext = typeof SettingsContext.Type;

const remote = <A, AI>(schema: Schema.Codec<A, AI>) =>
  AsyncData.Schema(schema, Schema.String).schema;

/** The settings page's Model. */
export const Model = Schema.Struct({
  context: SettingsContext,
  /** The epoch whose answers the sections hold; a new epoch or a reopened page asks again. */
  loadedEpoch: Schema.Option(Schema.Int),
  /** False until this device's settings were read from storage. */
  clientLoaded: Schema.Boolean,
  client: ClientSettings,
  server: remote(ServerSettings),
  catalog: remote(ModelCatalog),
  providers: remote(Schema.Array(ProviderStatus)),
  executor: remote(ExecutorStatus),
  /** The project the Skills section shows; the first project until the user picks one. */
  skillsProject: Schema.Option(ProjectId),
  skills: remote(SkillList),
  /** The newest plan windows; none until the stream's first frame. */
  usage: Schema.Option(UsageSnapshot),
  /** A sentence for the user about a change that did not take. */
  notice: Schema.Option(Schema.String),
});

export type Model = typeof Model.Type;

/** The page before the root said anything and before storage was read. */
export const initial: Model = {
  context: { epoch: 0, hasClient: false, isOpen: false, projects: [] },
  loadedEpoch: Option.none(),
  clientLoaded: false,
  client: DEFAULT_CLIENT_SETTINGS,
  server: AsyncData.Idle(),
  catalog: AsyncData.Idle(),
  providers: AsyncData.Idle(),
  executor: AsyncData.Idle(),
  skillsProject: Option.none(),
  skills: AsyncData.Idle(),
  usage: Option.none(),
  notice: Option.none(),
};
