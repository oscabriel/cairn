// What the brief card says about Go (plan wave 6, 6B; briefs note section 4; models note, "Check
// at Go"; ADR 0035): the role specs a subagent's brief or a workflow's launch names, what each
// resolves to now by `roles.check`, whether Go is blocked and why in plain words, and which of Send
// back and Run on 1 first a request takes. Pure, so the card's view draws only what this decides
// and its tests judge the words.
//
// - A role that does not resolve blocks Go (and Run on 1 first): a role the table does not bind, a
//   spec that is neither a role nor a model, or a role whose models are all passed over. Go would
//   start nothing then (the brain resolves again at Go and tells the parent so), so the card says
//   why and where to fix it instead of offering it.
// - Send back is a subagent's brief's only: its parent writes a new brief from the notes. A
//   workflow's launch and a node's own brief have no one to revise them (the record refuses it).
// - Run on 1 first is a workflow's launch's only (ADR 0032), and only when there is more than one
//   node to run: with one node it is Go.

import type {
  ApprovalRecord,
  Brief,
  WorkflowLaunch,
} from "@cairn/protocol/Policy";
import { RoleCheck } from "@cairn/protocol/Roles";
import type { RoleOverrides } from "@cairn/protocol/Roles";
import { Match, Option, Schema } from "effect";

import { modelText, skippedText } from "./Meters.ts";
import { RequestBody } from "./PendingRequests.ts";

/** The tool whose briefs start a subagent at Go, and so take Send back. */
export const SPAWN_TOOL = "subagent_spawn";

/** What the card asks `roles.check` about one request. */
export interface RoleQuestion {
  /** The specs, each once, in the order the request names them. */
  readonly specs: ReadonlyArray<string>;
  /** A launch's proposed per-launch bindings, which apply before the table. */
  readonly overrides: Option.Option<RoleOverrides>;
}

const unique = (specs: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(specs),
];

/** The spec a brief's child runs on: its role, else its literal model; none for the parent's. */
const briefSpec = (brief: Brief): Option.Option<string> => {
  if (brief.role !== null) {
    return Option.some(brief.role);
  }

  return brief.model === null
    ? Option.none()
    : Option.some(modelText(brief.model));
};

const launchQuestion = (
  launch: WorkflowLaunch
): Option.Option<RoleQuestion> => {
  const specs = unique([
    ...launch.callSites.map((site) => site.spec),
    ...launch.envelope.roles.map((role) => role.spec),
  ]);

  return specs.length === 0
    ? Option.none()
    : Option.some({
        specs,
        overrides:
          Object.keys(launch.roleOverrides).length === 0
            ? Option.none()
            : Option.some(launch.roleOverrides),
      });
};

/** What to ask `roles.check` for a request; none when it names no role or model. */
export const roleQuestionOf = (
  body: RequestBody
): Option.Option<RoleQuestion> =>
  RequestBody.$match(body, {
    Brief: ({ payload }) =>
      payload.type === "workflow"
        ? launchQuestion(payload)
        : Option.map(briefSpec(payload), (spec) => ({
            specs: [spec],
            overrides: Option.none(),
          })),
    Approval: () => Option.none(),
    Question: () => Option.none(),
    Criteria: () => Option.none(),
  });

/** Whether a request takes Send back: a subagent's brief only. */
export const takesSendBack = (
  record: Pick<ApprovalRecord, "kind" | "tool">,
  body: RequestBody
): boolean =>
  record.kind === "brief" &&
  record.tool === SPAWN_TOOL &&
  RequestBody.$is("Brief")(body) &&
  body.payload.type === "brief";

/** Whether a request takes Run on 1 first: a workflow's launch with more than one node. */
export const takesRunOnOne = (body: RequestBody): boolean =>
  RequestBody.$is("Brief")(body) &&
  body.payload.type === "workflow" &&
  (body.payload.nodes.unbounded || body.payload.nodes.count > 1);

/** Why Go is blocked, in the card's words. */
export interface GoBlock {
  /** The spec that blocks it. */
  readonly spec: string;
  readonly title: string;
  readonly detail: string;
}

/** A check's resolution as a tagged union, to match on. */
export const Resolution = RoleCheck.fields.resolution.pipe(
  Schema.toTaggedUnion("_tag")
);

type Unresolved = Extract<
  RoleCheck["resolution"],
  { readonly _tag: "Unresolved" }
>;

const isRole = (spec: string): boolean => spec.startsWith("@");

/** The words for one spec that does not resolve. */
const blockOf = (spec: string, unresolved: Unresolved): GoBlock =>
  Match.value(unresolved.reason).pipe(
    Match.when("unbound_role", () => ({
      spec,
      title: `Go is blocked: no role named ${spec} is in the role table.`,
      detail:
        "Bind it in the role table, then check again, or send the brief back.",
    })),
    Match.when("invalid_spec", () => ({
      spec,
      title: `Go is blocked: ${spec} is neither a role nor a model.`,
      detail: "Send the brief back for one that names a role.",
    })),
    Match.when("no_ready_model", () => {
      const passed = unresolved.skipped.map(skippedText);

      const why = passed.length === 0 ? "" : ` (${passed.join("; ")})`;

      return {
        spec,
        title: `Go is blocked: no model is ready for ${spec}${why}.`,
        detail: isRole(spec)
          ? "Bind it to a ready model in the role table, then check again."
          : "Check again once the model is ready, or send the brief back.",
      };
    }),
    Match.exhaustive
  );

/** The first spec that blocks Go, with why; none when every spec resolves. */
export const goBlockOf = (
  checks: ReadonlyArray<RoleCheck>
): Option.Option<GoBlock> =>
  Option.fromUndefinedOr(
    checks.flatMap((check) =>
      Resolution.match(check.resolution, {
        Resolved: () => [],
        Unresolved: (unresolved) => [blockOf(check.spec, unresolved)],
      })
    )[0]
  );

const UNRESOLVED_WORDS: Readonly<Record<Unresolved["reason"], string>> = {
  unbound_role: "not bound",
  invalid_spec: "not a role or model",
  no_ready_model: "no ready model",
};

/**
 * What one spec runs on now, for the card's "Runs on" line: `@worker: claude-bridge/claude-opus-5-5
 * at medium`, with its fallback and a judge on the worker's family said.
 */
export const runsOnText = (check: RoleCheck): string =>
  Resolution.match(check.resolution, {
    Unresolved: ({ reason }) => `${check.spec}: ${UNRESOLVED_WORDS[reason]}`,
    Resolved: ({ resolved }) => {
      const level =
        resolved.thinkingLevel === null ? "" : ` at ${resolved.thinkingLevel}`;

      const notes: Array<string> = [];

      if (resolved.via === "fallback") {
        notes.push("its fallback");
      }

      if (check.sameFamilyAsWorker) {
        notes.push("same model family as @worker");
      }

      const said = notes.length === 0 ? "" : ` (${notes.join(", ")})`;

      return `${check.spec}: ${modelText(resolved.model)}${level}${said}`;
    },
  });

/** Every spec's "Runs on" text, one per line's worth, joined. */
export const runsOnLine = (checks: ReadonlyArray<RoleCheck>): string =>
  checks.map(runsOnText).join("; ");
