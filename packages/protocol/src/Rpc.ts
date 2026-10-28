// The one RPC group the browser, the judges and any later client speak over `GET /ws?protocol=1`
// (ADR 0007): two streams (the shell and a thread) plus unary calls. Errors cross the socket typed.
// The identity Caddy and the guard decided at the upgrade reaches every handler as `Viewer`,
// through `ViewerMiddleware` reading the upgrade headers each request carries.

import { Context, Schema } from "effect";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";

import {
  CreateUploadUrlInput,
  CreateUploadUrlResult,
  DiscardAttachmentInput,
} from "./Attachments.ts";
import { FullDiffInput, ThreadDiff, TurnDiffInput } from "./Checkpoints.ts";
import {
  AttachmentRejected,
  Conflict,
  Internal,
  InvalidInput,
  LiveStreamOverflow,
  NotFound,
  Unauthorized,
  Unavailable,
} from "./Errors.ts";
import { ExecutorSignIn, ExecutorStatus } from "./Executor.ts";
import { TrimmedNonEmptyString } from "./Ids.ts";
import { ThreadLaunchInput, ThreadLaunchResult } from "./Launch.ts";
import {
  LoginProgress,
  ModelCatalog,
  ModelDefaults,
  ProviderLoginInput,
  ProviderStatus,
} from "./Models.ts";
import { SetCriteriaInput } from "./Policy.ts";
import {
  BranchesInput,
  BranchesResult,
  BrowseInput,
  BrowseResult,
  SearchEntriesInput,
  SearchEntriesResult,
} from "./Projects.ts";
import {
  PresenceReport,
  PushSubscriptionInput,
  PushUnsubscribeInput,
  VapidKey,
} from "./Push.ts";
import {
  ArtifactRevokeInput,
  PortalInput,
  ReachList,
  ReachListInput,
} from "./Reach.ts";
import { RoleCheck, RolesCheckInput } from "./Roles.ts";
import { ServerSettings, SettingsPatch } from "./Settings.ts";
import { ProjectShell, ShellStreamItem, SubscribeShellInput } from "./Shell.ts";
import { DispatchResult, ShellCommand } from "./ShellCommands.ts";
import { SkillList, SkillsInput } from "./Skills.ts";
import { Spend, SpendGetInput } from "./Spend.ts";
import {
  ConfigureInput,
  EntryInput,
  FullEntry,
  HistoryInput,
  HistoryPage,
  RespondInput,
  RetryTaskInput,
  SendInput,
  SendResult,
  StopInput,
  SubscribeThreadInput,
  ThreadStreamItem,
  WithdrawInput,
  WithdrawResult,
} from "./Thread.ts";
import { UsageSnapshot } from "./Usage.ts";
import {
  EventStatus,
  RecipeList,
  WorkflowListInput,
  WorkflowStopInput,
  WorkflowStopNodeInput,
} from "./Workflows.ts";

/** The wire protocol this package describes. Bumped on any change an older client cannot read. */
export const PROTOCOL_VERSION = 2;

/** The query parameter that carries the protocol version on the WebSocket upgrade. */
export const PROTOCOL_QUERY_PARAM = "protocol";

/** `session.hello` result: what a page needs to notice it talks to a rebuilt server. */
export const Hello = Schema.Struct({
  protocol: Schema.Literal(PROTOCOL_VERSION),
  /** The id of the web build the server serves; a page holding another id reloads. */
  build: TrimmedNonEmptyString,
  serverTime: Schema.DateTimeUtc,
  /** The Tailscale login the socket was admitted as. */
  viewer: TrimmedNonEmptyString,
  defaults: ModelDefaults,
  /** None until push is configured. */
  vapidPublicKey: Schema.OptionFromNullOr(VapidKey),
});

export type Hello = typeof Hello.Type;

/** Who is on the other end of the socket: the Tailscale login the guard admitted. */
export class Viewer extends Context.Service<
  Viewer,
  { readonly login: string }
>()("cairn/protocol/Viewer") {}

/**
 * Provides `Viewer` to every handler from the upgrade's headers, and refuses a request whose
 * identity is missing or no longer the owner's.
 */
export class ViewerMiddleware extends RpcMiddleware.Service<
  ViewerMiddleware,
  { provides: Viewer }
>()("cairn/protocol/ViewerMiddleware", { error: Unauthorized }) {}

const Common = Schema.Union([Unavailable, Internal]);

const Lookup = Schema.Union([Unavailable, Internal, NotFound]);

const Change = Schema.Union([
  Unavailable,
  Internal,
  NotFound,
  InvalidInput,
  Conflict,
]);

const Turn = Schema.Union([
  Unavailable,
  Internal,
  NotFound,
  InvalidInput,
  Conflict,
  AttachmentRejected,
]);

/** Every RPC of phases 1 and 2. Tags are dotted, as t3code's are. */
export const CairnRpcs = RpcGroup.make(
  Rpc.make("session.hello", { success: Hello, error: Common }),

  // Stream 1: Cairn's own state, event-sourced and resumable from a sequence.
  Rpc.make("shell.subscribe", {
    payload: SubscribeShellInput,
    success: ShellStreamItem,
    error: Schema.Union([Unavailable, Internal, LiveStreamOverflow]),
    stream: true,
  }),
  Rpc.make("shell.dispatch", {
    payload: ShellCommand,
    success: DispatchResult,
    error: Change,
  }),

  Rpc.make("thread.launch", {
    payload: ThreadLaunchInput,
    success: ThreadLaunchResult,
    error: Turn,
  }),
  Rpc.make("thread.send", {
    payload: SendInput,
    success: SendResult,
    error: Turn,
  }),
  Rpc.make("thread.stop", { payload: StopInput, error: Change }),
  Rpc.make("thread.withdraw", {
    payload: WithdrawInput,
    success: WithdrawResult,
    error: Change,
  }),
  Rpc.make("thread.configure", { payload: ConfigureInput, error: Change }),
  Rpc.make("thread.respond", { payload: RespondInput, error: Change }),
  Rpc.make("thread.retryTask", { payload: RetryTaskInput, error: Change }),

  // Stream 2: pi-durable's view of one conversation; a fresh snapshot on every subscribe.
  Rpc.make("thread.subscribe", {
    payload: SubscribeThreadInput,
    success: ThreadStreamItem,
    error: Lookup,
    stream: true,
  }),
  Rpc.make("thread.history", {
    payload: HistoryInput,
    success: HistoryPage,
    error: Lookup,
  }),
  Rpc.make("thread.entry", {
    payload: EntryInput,
    success: FullEntry,
    error: Lookup,
  }),

  Rpc.make("projects.browse", {
    payload: BrowseInput,
    success: BrowseResult,
    error: Lookup,
  }),
  Rpc.make("projects.ensureScratch", { success: ProjectShell, error: Common }),
  Rpc.make("projects.searchEntries", {
    payload: SearchEntriesInput,
    success: SearchEntriesResult,
    error: Lookup,
  }),
  Rpc.make("git.branches", {
    payload: BranchesInput,
    success: BranchesResult,
    error: Lookup,
  }),

  Rpc.make("attachments.createUploadUrl", {
    payload: CreateUploadUrlInput,
    success: CreateUploadUrlResult,
    error: Schema.Union([Unavailable, Internal, AttachmentRejected]),
  }),
  Rpc.make("attachments.discard", {
    payload: DiscardAttachmentInput,
    error: Lookup,
  }),

  Rpc.make("diff.turn", {
    payload: TurnDiffInput,
    success: ThreadDiff,
    error: Lookup,
  }),
  Rpc.make("diff.full", {
    payload: FullDiffInput,
    success: ThreadDiff,
    error: Lookup,
  }),

  Rpc.make("models.list", { success: ModelCatalog, error: Common }),
  Rpc.make("providers.status", {
    success: Schema.Array(ProviderStatus),
    error: Common,
  }),
  Rpc.make("usage.subscribe", {
    success: UsageSnapshot,
    error: Common,
    stream: true,
  }),

  Rpc.make("skills.list", {
    payload: SkillsInput,
    success: SkillList,
    error: Lookup,
  }),
  Rpc.make("skills.reload", {
    payload: SkillsInput,
    success: SkillList,
    error: Lookup,
  }),

  Rpc.make("executor.status", { success: ExecutorStatus, error: Common }),
  Rpc.make("executor.signIn", { success: ExecutorSignIn, error: Common }),

  Rpc.make("push.subscribe", { payload: PushSubscriptionInput, error: Change }),
  Rpc.make("push.unsubscribe", {
    payload: PushUnsubscribeInput,
    error: Common,
  }),
  Rpc.make("presence.report", { payload: PresenceReport, error: Common }),

  Rpc.make("settings.get", { success: ServerSettings, error: Common }),
  Rpc.make("settings.update", {
    payload: SettingsPatch,
    success: ServerSettings,
    error: Change,
  }),

  // Phase 2. Steering, stopping and answering a subagent are thread.send, thread.stop and
  // thread.respond on the child's own thread id (ADR 0028); no RPC is added for them.
  Rpc.make("roles.check", {
    payload: RolesCheckInput,
    success: Schema.Array(RoleCheck),
    error: Common,
  }),
  Rpc.make("spend.get", {
    payload: SpendGetInput,
    success: Spend,
    error: Lookup,
  }),
  Rpc.make("providers.login.start", {
    payload: ProviderLoginInput,
    success: LoginProgress,
    error: Schema.Union([Unavailable, Internal, InvalidInput, Conflict]),
    stream: true,
  }),
  Rpc.make("providers.login.cancel", {
    payload: ProviderLoginInput,
    error: Common,
  }),
  Rpc.make("providers.logout", { payload: ProviderLoginInput, error: Change }),

  Rpc.make("goal.setCriteria", { payload: SetCriteriaInput, error: Change }),

  Rpc.make("workflow.stop", { payload: WorkflowStopInput, error: Change }),
  Rpc.make("workflow.stopNode", {
    payload: WorkflowStopNodeInput,
    error: Change,
  }),
  Rpc.make("workflow.list", {
    payload: WorkflowListInput,
    success: RecipeList,
    error: Lookup,
  }),
  Rpc.make("workflow.eventStatus", { success: EventStatus, error: Common }),

  Rpc.make("reach.list", {
    payload: ReachListInput,
    success: ReachList,
    error: Lookup,
  }),
  Rpc.make("artifact.revoke", { payload: ArtifactRevokeInput, error: Change }),
  Rpc.make("portal.close", { payload: PortalInput, error: Change }),
  Rpc.make("portal.start", { payload: PortalInput, error: Change })
).middleware(ViewerMiddleware);

/** The RPC group's type, for handler layers and clients. */
export type CairnRpcs = typeof CairnRpcs;
