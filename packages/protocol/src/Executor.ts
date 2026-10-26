// Executor's link health, for the settings page and the needs-sign-in banner.

import { Schema } from "effect";

import { DisplayText } from "./Ids.ts";

/** Where the brain's link to Executor stands. */
export const ExecutorStatus = Schema.Struct({
  state: Schema.Literals([
    "connected",
    "needs-sign-in",
    "unreachable",
    "disabled",
  ]),
  /** A sentence for the user when the state is not `connected`. */
  detail: Schema.OptionFromNullOr(DisplayText),
  checkedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
});

export type ExecutorStatus = typeof ExecutorStatus.Type;

/** `executor.signIn` result: where to send the browser to grant Cairn access again. */
export const ExecutorSignIn = Schema.Struct({
  authorizeUrl: Schema.String.check(Schema.isPattern(/^https?:\/\//u)),
});

export type ExecutorSignIn = typeof ExecutorSignIn.Type;
