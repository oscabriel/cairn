// The meters' state (plan wave 6, 6G): the usage page (the spend ledger, plan windows and budgets)
// and the role table editor on the settings page, over one Model. What the root tells it (the
// connection, which of its pages is open, the plan windows the settings page already streams, the
// thread rows' spend) arrives as its context; what it asks the brain for (the whole roll-up, the
// server settings with the role table and the default budget, the model catalog, and what each
// role resolves to now) is held per epoch, as the settings page holds its sections. Only this
// module and the Messages load with the entry; the update and views come with the `next` chunk.

import { ThreadId } from "@cairn/protocol/Ids";
import { ModelCatalog } from "@cairn/protocol/Models";
import { RoleCheck, RoleName } from "@cairn/protocol/Roles";
import { ServerSettings } from "@cairn/protocol/Settings";
import { Spend, SpendSummary } from "@cairn/protocol/Spend";
import { UsageSnapshot } from "@cairn/protocol/Usage";
import { Option, Schema } from "effect";
import * as AsyncData from "foldkit/asyncData";

/** Which of the meters' pages is open: the usage page, the settings page, or neither. */
export const MetersPage = Schema.Literals(["usage", "settings", "closed"]);

export type MetersPage = typeof MetersPage.Type;

/** A thread row with spend recorded, as the ledger and the budgets list it. */
export const MeteredThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  spend: SpendSummary,
});

export type MeteredThread = typeof MeteredThread.Type;

/** What the root tells the meters on every change. */
export const MetersContext = Schema.Struct({
  epoch: Schema.Int,
  hasClient: Schema.Boolean,
  page: MetersPage,
  /** The newest plan windows, from the settings page's stream; none before its first frame. */
  usage: Schema.Option(UsageSnapshot),
  /** The rows with spend recorded, while a page is open; empty otherwise. */
  threads: Schema.Array(MeteredThread),
});

export type MetersContext = typeof MetersContext.Type;

const remote = <A, AI>(schema: Schema.Codec<A, AI>) =>
  AsyncData.Schema(schema, Schema.String).schema;

/** The meters' Model. */
export const Model = Schema.Struct({
  context: MetersContext,
  /** The epoch whose answers the sections hold; a new epoch or a reopened page asks again. */
  loadedEpoch: Schema.Option(Schema.Int),
  /** `spend.get` over everything the brain recorded. */
  spend: remote(Spend),
  /** The rows' token total when `spend` was asked, so new spend asks again. */
  spendAt: Schema.Int,
  server: remote(ServerSettings),
  catalog: remote(ModelCatalog),
  /** `roles.check` of every role in the table. */
  checks: remote(Schema.Array(RoleCheck)),
  /** The role whose new binding `settings.update` is carrying; one change at a time. */
  saving: Schema.Option(RoleName),
  /** A sentence for the user about a change that did not take. */
  notice: Schema.Option(Schema.String),
});

export type Model = typeof Model.Type;

/** The meters before the root said anything. */
export const initial: Model = {
  context: {
    epoch: 0,
    hasClient: false,
    page: "closed",
    usage: Option.none(),
    threads: [],
  },
  loadedEpoch: Option.none(),
  spend: AsyncData.Idle(),
  spendAt: 0,
  server: AsyncData.Idle(),
  catalog: AsyncData.Idle(),
  checks: AsyncData.Idle(),
  saving: Option.none(),
  notice: Option.none(),
};
