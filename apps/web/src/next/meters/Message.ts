// The meters' Messages: what the brain answered for each section.

import { ServerSettings } from "@cairn/protocol/Settings";
import { Spend } from "@cairn/protocol/Spend";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { BudgetTarget } from "./Model.ts";

/** The sections the meters ask the brain for. */
export const MetersSection = Schema.Literals(["spend", "server"]);

export type MetersSection = typeof MetersSection.Type;

/** Everything the meters react to. */
export const Message = defineMessageUnion({
  ReceivedSpend: { epoch: Schema.Int, spend: Spend },
  ReceivedServerSettings: { epoch: Schema.Int, settings: ServerSettings },
  /** A section's question failed; `section` names which. */
  FailedLoad: {
    epoch: Schema.Int,
    section: MetersSection,
    message: Schema.String,
  },
  /** Asks every section again after a failure. */
  ClickedRetry: {},
  /** Opens the budget form for the default or a thread (ADR 0047). */
  ClickedEditBudget: { target: BudgetTarget },
  ChangedBudgetDollars: { value: Schema.String },
  ChangedBudgetTokens: { value: Schema.String },
  ClickedSaveBudget: {},
  ClickedCancelBudget: {},
  /** The brain took the form's budget; for the default, with the settings it now holds. */
  SavedBudget: {
    target: BudgetTarget,
    settings: Schema.Option(ServerSettings),
  },
  FailedSaveBudget: { message: Schema.String },
});

/** A meters Message. */
export type Message = typeof Message.Type;
