// What a workflow's launch card says (plan wave 6, 6F; surfaces note S8; workflows note "What the
// user sees"; ADR 0032): the numbers first (how many nodes, the estimate labelled as one, the
// budget and what Go covers), then the roles each call site runs as, then what it does. Pure, so
// the card's view only draws what this module decides and its tests judge the words.
//
// - The estimate is a range with its basis. A cost that is not known reads "unknown", never
//   "$0.00": no estimate yet, no tokens in it, or a model with no list price (ADR 0036).
// - A call site reads "@scout · reads only · up to 4" or "depends on the data" when the dry run
//   could not count it; its phase leads when it has one.
// - What Go covers is the envelope: the node cap, how many run at once, and the roles granted with
//   whether they may write. A node outside it asks again with its own card.

import type {
  CallSite,
  Envelope,
  WorkflowEstimate,
  WorkflowLaunch,
} from "@cairn/protocol/Policy";
import { Option, Predicate } from "effect";

import { dollarsText, tokensShort } from "./Meters.ts";
import { budgetText } from "./PendingCard.ts";
import type { CardLine } from "./PendingCard.ts";

/** How many nodes the plan runs: "5", or "At least 12" when the dry run reached its cap. */
export const nodesText = (nodes: WorkflowLaunch["nodes"]): string =>
  nodes.unbounded ? `At least ${String(nodes.count)}` : String(nodes.count);

/** What a range of token counts reads as: "1.2M" when both ends agree, else "800k to 1.2M". */
const tokenRange = (low: number, high: number): string =>
  tokensShort(low) === tokensShort(high)
    ? tokensShort(high)
    : `${tokensShort(low)} to ${tokensShort(high)}`;

/** What a range of list-price dollars reads as. */
const dollarRange = (low: number, high: number): string =>
  dollarsText(low) === dollarsText(high)
    ? dollarsText(high)
    : `${dollarsText(low)} to ${dollarsText(high)}`;

/**
 * The estimate's tokens in words: "about 800k to 1.2M tokens", or "Tokens unknown" without an
 * estimate or with nothing in it.
 */
export const estimateTokensText = (
  estimate: Option.Option<WorkflowEstimate>
): string =>
  Option.match(
    Option.filter(estimate, (found) => found.tokensHigh > 0),
    {
      onNone: () => "Tokens unknown",
      onSome: (found) =>
        `about ${tokenRange(found.tokensLow, found.tokensHigh)} tokens`,
    }
  );

/**
 * The estimate's cost in words: "$0.40 to $0.90 at API list price", or "Cost unknown" when there is
 * no estimate, it holds no tokens, or a model it runs on has no list price: never "$0.00" for an
 * unknown (ADR 0036).
 */
export const estimateCostText = (
  estimate: Option.Option<WorkflowEstimate>
): string =>
  Option.match(
    Option.filter(estimate, (found) => found.tokensHigh > 0),
    {
      onNone: () => "Cost unknown",
      onSome: (found) =>
        found.listMicrosLow === null || found.listMicrosHigh === null
          ? "Cost unknown (a model it runs on has no list price)"
          : `${dollarRange(found.listMicrosLow, found.listMicrosHigh)} at API list price`,
    }
  );

/** The estimate as one line, cost first: "Cost unknown; about 800k to 1.2M tokens". */
export const estimateText = (
  estimate: Option.Option<WorkflowEstimate>
): string =>
  Option.isNone(Option.filter(estimate, (found) => found.tokensHigh > 0))
    ? "No estimate yet: cost unknown"
    : `${estimateCostText(estimate)}; ${estimateTokensText(estimate)}`;

/** What Go covers, the envelope in words: "Up to 5 nodes, 2 at once". */
export const coversText = (envelope: Envelope): string =>
  `Up to ${String(envelope.maxNodes)} node${envelope.maxNodes === 1 ? "" : "s"}, ${String(envelope.maxConcurrent)} at once`;

/** A role's grant in words: "@scout, reads only". */
const grantText = (role: Envelope["roles"][number]): string =>
  `${role.spec}, ${role.readonly ? "reads only" : "may write"}`;

/** The roles the envelope grants, in words; "No roles" for an envelope that grants none. */
export const grantsText = (envelope: Envelope): string =>
  envelope.roles.length === 0
    ? "No roles"
    : envelope.roles.map(grantText).join("; ");

/**
 * The launch's numbers in reading order, as the card's first lines: nodes, the estimate, the
 * budget, what Go covers and the roles it grants, and the phases when it has them.
 */
export const launchNumbers = (
  launch: WorkflowLaunch
): ReadonlyArray<CardLine> => {
  const lines: Array<CardLine> = [
    ["Nodes", nodesText(launch.nodes)],
    ["Estimate", estimateText(Option.fromNullOr(launch.estimate))],
    ["Budget", budgetText(launch.envelope.budget)],
    ["Go covers", coversText(launch.envelope)],
    ["Roles", grantsText(launch.envelope)],
  ];

  if (launch.phases.length > 0) {
    lines.push([
      "Phases",
      launch.phases.map((phase) => phase.title).join(", "),
    ]);
  }

  return lines;
};

/** One call site of the plan as the card's roles list draws it. */
export interface CallSiteRow {
  readonly label: string;
  readonly spec: string;
  /** "Review · @scout · reads only · up to 4". */
  readonly detail: string;
}

/** How many times a call site runs: "up to 4", "once", or "depends on the data". */
const countText = (maxCount: CallSite["maxCount"]): string => {
  if (maxCount === null) {
    return "depends on the data";
  }

  return maxCount === 1 ? "once" : `up to ${String(maxCount)}`;
};

/** The plan's call sites as rows, in the order the dry run reached them. */
export const callSiteRows = (
  launch: WorkflowLaunch
): ReadonlyArray<CallSiteRow> =>
  launch.callSites.map((site) => {
    const parts = [
      site.spec,
      site.readonly ? "reads only" : "writes",
      countText(site.maxCount),
    ];

    if (site.phase !== null) {
      parts.unshift(site.phase);
    }

    return {
      label: site.label.trim() === "" ? "Node" : site.label,
      spec: site.spec,
      detail: parts.join(" · "),
    };
  });

/** The launch arguments as the card's folded block shows them; none for no arguments. */
export const argsText = (
  args: WorkflowLaunch["args"]
): Option.Option<string> => {
  if (
    args === null ||
    (Predicate.isObject(args) &&
      !Array.isArray(args) &&
      Object.keys(args).length === 0)
  ) {
    return Option.none();
  }

  return Option.some(JSON.stringify(args, null, 2));
};
