// How long a brief stays answerable (ADR 0030): seven days, then it expires and its parent is told.
// Both harnesses read it when they are built, so the conformance suite's expiry scenario can give
// a brief a fraction of a second instead of a week; production and dev never change it.

import { BRIEF_EXPIRY_DAYS } from "@cairn/protocol/Subagents";
import { Context } from "effect";

/** A day, in milliseconds. */
const DAY_MILLIS = 24 * 60 * 60 * 1000;

/** The production lifetime of a pending brief, in milliseconds. */
export const BRIEF_TTL_MILLIS = BRIEF_EXPIRY_DAYS * DAY_MILLIS;

/** A pending brief's lifetime in milliseconds; a week unless a test provides less. */
export const BriefTtl = Context.Reference<number>(
  "cairn/server/brain/BriefTtl",
  { defaultValue: () => BRIEF_TTL_MILLIS }
);
