// Thread states judge: every status the protocol defines has a row in the status table and in the
// label map of docs/golden/thread-states.md. The statuses come from the schemas themselves: every
// literal union reachable from a schema `@cairn/protocol` exports, named by the export holding
// the union (`ThreadActivity`, or `ExecutorStatus.state` for a union declared inline). A union that names
// something other than a state (a kind, a mode, a setting, an error reason) is listed in
// `NOT_STATUSES` with the reason, so a new union fails here until someone files it.
//
// The doc must also not lie about what ships (review C-5):
// - A label map cell may say "Not shown yet" only while no client module (`packages/client-logic`,
//   `apps/web`) imports the union's type or an export that holds it directly (`ProviderUsage` for
//   `UsageReading`): a module that reads it is where its words live.
// - For a union whose words a client module computes (`LIVE_WORDS`, read from the live label tables
//   by import: the settled-record lines, the budget and criterion words, the steps panel's node
//   words and a child's settled label), each value's cell quotes those words.
// - Every path the doc cites exists, without a line range (ranges rot unseen), and every symbol it
//   names beside a path, as `path` (`symbol`), is in that file.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { criterionStateLabel } from "@cairn/client-logic/GoalProgress";
import { budgetWordOf } from "@cairn/client-logic/Meters";
import { settledLineOf } from "@cairn/client-logic/PendingRequests";
import { shellRow } from "@cairn/client-logic/ShellRowTestKit";
import { CHILD_LABELS, childStatusOf } from "@cairn/client-logic/ThreadLineage";
import { workflowGroupsOf } from "@cairn/client-logic/WorkflowSteps";
import * as Attachments from "@cairn/protocol/Attachments";
import * as Checkpoints from "@cairn/protocol/Checkpoints";
import * as Errors from "@cairn/protocol/Errors";
import * as Executor from "@cairn/protocol/Executor";
import * as Ids from "@cairn/protocol/Ids";
import * as JsonSchema from "@cairn/protocol/JsonSchema";
import * as Launch from "@cairn/protocol/Launch";
import * as Models from "@cairn/protocol/Models";
import * as ModelSpecs from "@cairn/protocol/ModelSpecs";
import * as Policy from "@cairn/protocol/Policy";
import * as Projects from "@cairn/protocol/Projects";
import * as Push from "@cairn/protocol/Push";
import * as Reach from "@cairn/protocol/Reach";
import * as Rpc from "@cairn/protocol/Rpc";
import * as Settings from "@cairn/protocol/Settings";
import * as Shell from "@cairn/protocol/Shell";
import * as ShellCommands from "@cairn/protocol/ShellCommands";
import * as Skills from "@cairn/protocol/Skills";
import * as Spend from "@cairn/protocol/Spend";
import * as Subagents from "@cairn/protocol/Subagents";
import * as Thread from "@cairn/protocol/Thread";
import * as Usage from "@cairn/protocol/Usage";
import * as Workflows from "@cairn/protocol/Workflows";
import { assert, describe, it } from "@effect/vitest";
import { Option, Schema, SchemaAST } from "effect";

const root = path.join(import.meta.dirname, "..");

const protocolDir = path.join(root, "packages", "protocol", "src");

const docPath = path.join(root, "docs", "golden", "thread-states.md");

/** Every protocol module, by file name; the first case proves the list is whole. */
const MODULES = {
  Attachments,
  Checkpoints,
  Errors,
  Executor,
  Ids,
  JsonSchema,
  Launch,
  Models,
  ModelSpecs,
  Policy,
  Projects,
  Push,
  Reach,
  Rpc,
  Settings,
  Shell,
  ShellCommands,
  Skills,
  Spend,
  Subagents,
  Thread,
  Usage,
  Workflows,
} as const;

/** Literal unions that are not states, and why. */
const NOT_STATUSES = {
  AttachmentKind: "what an attachment is, fixed at upload",
  ApprovalDecision: "the user's answer, an input to `ApprovalStatus`",
  QuestionSource: "where a question came from, fixed when it is asked",
  RuntimeMode: "the permission mode, a thread setting",
  ThinkingLevel: "a model setting",
  WhenBusy: "a send option",
  "LatestVisibleMessage.role": "who wrote the preview line",
  "NoticeEntryData.reason": "why a notice was written, a transcript entry",
  "ProjectShell.kind": "folder or scratch, fixed when the project is made",
  "ProviderStatus.credential": "how a provider is reached, not whether",
  "NotFound.resource": "an error's subject",
  "Conflict.reason": "an error reason",
  "AttachmentRejected.reason": "an error reason",
  "SearchEntry.kind": "file or directory, a search result",
  "SkillSummary.source": "where a skill was found",
  ApprovalRoute: "who a question goes to first, a routing setting",
  BriefWorkspace: "where a child works, chosen in its brief",
  WakeMode: "whether a result wakes the parent, chosen in the brief",
  NodeArms: "where a node runs, a placement",
  ArtifactKind: "file or folder, fixed at publish",
  PortalArms: "where a portal's process runs, a placement",
  PortalStopReason: "why a portal stopped, a reason beside `PortalState`",
  ModelUnready: "why a named model cannot take a child now, a reason",
  ModelCheckFailure: "why a model spec did not resolve, a reason",
  PriceBasis: "how a dollar figure relates to a bill, a label",
  RelationshipToParent: "how a row relates to its parent, a kind",
  SubagentStopPolicy: "a stop option",
  WorkflowPartialReason: "why a workflow ended partial, a reason",
  NodeStage: "where a rerun resumes a dispatch; the panel shows `NodeState`",
  NodeRefusal: "why a node was refused, a reason beside `NodeState` `refused`",
  EventName: "the kind of a durable event",
  "LoginProgress.reason": "why a login failed, a reason",
  "Decider.why": "why the system decided a record, a reason",
  "ApprovalRecord.run": "the effect sandwich's mark, read by the boot repair",
  "RecipeSummary.source": "where a recipe was found",
} as const;

const isLiteralUnion = (
  ast: SchemaAST.AST
): ast is SchemaAST.Union<SchemaAST.Literal> =>
  SchemaAST.isUnion(ast) &&
  ast.types.length > 0 &&
  ast.types.every((member) => SchemaAST.isLiteral(member));

const literalsOf = (ast: SchemaAST.Union<SchemaAST.Literal>) =>
  ast.types.map((member) => String(member.literal));

const unnamed = (asts: ReadonlyArray<SchemaAST.AST>) =>
  asts.map((child) => [undefined, child] as const);

/** An AST's children, each with the property name it sits under (none for a union member). */
const childrenOf = (
  ast: SchemaAST.AST
): ReadonlyArray<readonly [string | undefined, SchemaAST.AST]> => {
  const encoded = unnamed((ast.encoding ?? []).map((link) => link.to));

  if (SchemaAST.isObjects(ast)) {
    return [
      ...ast.propertySignatures.map(
        (signature) => [String(signature.name), signature.type] as const
      ),
      ...unnamed(ast.indexSignatures.map((signature) => signature.type)),
      ...encoded,
    ];
  }

  if (SchemaAST.isArrays(ast)) {
    return [...unnamed([...ast.elements, ...ast.rest]), ...encoded];
  }

  if (SchemaAST.isUnion(ast)) {
    return [...unnamed(ast.types), ...encoded];
  }

  if (SchemaAST.isDeclaration(ast)) {
    return [...unnamed(ast.typeParameters), ...encoded];
  }

  if (SchemaAST.isSuspend(ast)) {
    return [...unnamed([ast.thunk()]), ...encoded];
  }

  return encoded;
};

/** Every schema the protocol exports, by export name. */
const schemas = Object.values(MODULES).flatMap((module) =>
  Object.entries<unknown>(module).filter(
    (entry): entry is [string, Schema.Top] => Schema.isSchema(entry[1])
  )
);

/**
 * Every literal union the protocol's exported schemas reach, by name: an exported union by its
 * export name, an inline one by the first export and property path that reach it.
 */
const protocolUnions = (): ReadonlyMap<string, ReadonlyArray<string>> => {
  const names = new Map<SchemaAST.Union<SchemaAST.Literal>, string>();

  for (const [name, schema] of schemas) {
    if (isLiteralUnion(schema.ast) && !names.has(schema.ast)) {
      names.set(schema.ast, name);
    }
  }

  const visited = new Set<SchemaAST.AST>();

  const visit = (ast: SchemaAST.AST, at: string) => {
    if (visited.has(ast)) {
      return;
    }

    visited.add(ast);

    // A schema wrapped in a transformation can reach the same union as a copy; the copy is the
    // same vocabulary under a second name, so it is skipped.
    if (
      isLiteralUnion(ast) &&
      !names.has(ast) &&
      ![...names.keys()].some(
        (named) => literalsOf(named).join("|") === literalsOf(ast).join("|")
      )
    ) {
      names.set(ast, at);
    }

    for (const [key, child] of childrenOf(ast)) {
      visit(child, key === undefined ? at : `${at}.${key}`);
    }
  };

  for (const [name, schema] of schemas) {
    visit(schema.ast, name);
  }

  return new Map(
    [...names].map(([ast, name]) => [name, literalsOf(ast)] as const)
  );
};

/** The `schema value` keys of one section's table rows: a row starts with two code cells. */
const rowsOf = (doc: string, heading: string): ReadonlySet<string> => {
  const start = doc.indexOf(`\n## ${heading}\n`);

  if (start === -1) {
    return new Set();
  }

  const end = doc.indexOf("\n## ", start + 1);
  const section = doc.slice(start, end === -1 ? doc.length : end);

  return new Set(
    section
      .split("\n")
      .flatMap((line) =>
        Option.toArray(
          Option.fromNullishOr(
            /^\|\s*`(?<schema>[^`]+)`\s*\|\s*`(?<value>[^`]+)`\s*\|/u.exec(line)
              ?.groups
          )
        )
      )
      .map(({ schema, value }) => `${schema} ${value}`)
  );
};

const unions = protocolUnions();

/** A literal union's values as one key, so a copy of a union finds the union's name. */
const literalKey = (ast: SchemaAST.Union<SchemaAST.Literal>) =>
  literalsOf(ast).join("|");

/**
 * The exports that hold each union directly, by union name: a struct whose fields reach the union
 * through no other export (`ProviderUsage` holds `UsageReading`). A client reading the holder reads
 * the union, as the settings page reads `UsageReading` through `ProviderUsage`.
 */
const directHolders = (): ReadonlyMap<string, ReadonlySet<string>> => {
  const byLiterals = new Map(
    [...unions].map(([name, values]) => [values.join("|"), name] as const)
  );

  const exported = new Set(schemas.map(([, schema]) => schema.ast));
  const holders = new Map<string, Set<string>>();

  for (const [holder, schema] of schemas) {
    const visited = new Set<SchemaAST.AST>();

    const visit = (ast: SchemaAST.AST) => {
      if (visited.has(ast)) {
        return;
      }

      visited.add(ast);

      const union = isLiteralUnion(ast)
        ? byLiterals.get(literalKey(ast))
        : undefined;

      if (union !== undefined && union !== holder) {
        const held = holders.get(union) ?? new Set<string>();

        held.add(holder);
        holders.set(union, held);
      }

      for (const [, child] of childrenOf(ast)) {
        if (!exported.has(child) || isLiteralUnion(child)) {
          visit(child);
        }
      }
    };

    for (const [, child] of childrenOf(schema.ast)) {
      if (!exported.has(child) || isLiteralUnion(child)) {
        visit(child);
      }
    }
  }

  return holders;
};

const HOLDERS = directHolders();

const statuses = [...unions].filter(
  ([name]) => !Object.hasOwn(NOT_STATUSES, name)
);

const doc = readFileSync(docPath, "utf-8");

const missingFrom = (heading: string) => {
  const rows = rowsOf(doc, heading);

  return statuses.flatMap(([name, values]) =>
    values.map((value) => `${name} ${value}`).filter((key) => !rows.has(key))
  );
};

/** A settled approval record as the brain writes one: a tool call the user decided, no reason. */
const approvalRecord = (status: string) =>
  Schema.decodeUnknownSync(Policy.ApprovalRecord)({
    id: "apr_1",
    toolTaskId: 1,
    tool: "gate",
    kind: "tool-call",
    summary: "Open the gate",
    status,
    askedAt: 1000,
    expiresAt: 9000,
    answeredAt: status === "pending" ? null : 2000,
    run: null,
    executorRequestId: null,
    payload: null,
    answer: null,
    decidedBy: status === "pending" ? null : { kind: "user" },
    reason: null,
    route: "user",
    escalatedAt: null,
    supersedes: null,
    started: null,
    briefHash: null,
    mirrorOf: null,
  });

const WORKFLOW_START = Date.UTC(2026, 7, 1, 10, 0, 0);

/** A `cairn.workflows` document holding one workflow in `workflowState` with one node in `nodeState`. */
const ledgerOf = (workflowState: string, nodeState: string) => ({
  items: {
    "wf-1": {
      id: "wf-1",
      name: "probe-wf",
      description: "Run the alpha workflow",
      phases: [],
      scriptHash: "hash",
      scriptRef: "script-wf-1",
      args: {},
      state: workflowState,
      outcome: null,
      approvalId: "launch-wf-1",
      decidedBy: { kind: "user" },
      decidedAt: WORKFLOW_START - 1000,
      sample: null,
      budget: {
        maxListMicros: null,
        maxTokens: null,
        maxTurns: null,
        maxMinutes: null,
        planGuard: null,
        warnAt: 0.8,
      },
      estimate: null,
      codemodeTaskId: 7,
      startedAt: WORKFLOW_START,
      endedAt: null,
      result: null,
      nodes: {
        "n-1": {
          id: "n-1",
          workflowId: "wf-1",
          key: null,
          label: "alpha:1",
          phase: "Alpha",
          index: 1,
          requestId: "wf-wf-1-n-1",
          briefId: "launch-wf-1",
          model: "faux/scripted",
          provider: "faux",
          modelId: "kit",
          effort: null,
          readonly: false,
          arms: "host",
          state: nodeState,
          stage: "submitted",
          childThreadId: null,
          conversationId: null,
          submissionId: null,
          nestedTaskId: 101,
          attempt: 1,
          schemaAttempts: 0,
          receipt: null,
          result: null,
          resultSummary: null,
          refusal: null,
          held: null,
          startedAt: null,
          endedAt: null,
          error: null,
        },
      },
      log: {},
      spent: { tokens: 0, listMicros: 0, unpricedTokens: 0 },
      softAt: null,
      spentAt: null,
    },
  },
});

/** The steps panel's word for the one node of `ledgerOf(workflowState, nodeState)`. */
const nodeWord = (workflowState: string, nodeState: string) => {
  const members = workflowGroupsOf(ledgerOf(workflowState, nodeState)).flatMap(
    (group) => [
      ...group.phases.flatMap((phase) => phase.members),
      ...group.unphasedNodes,
    ]
  );

  assert.strictEqual(
    members.length,
    1,
    `the probe ledger (${workflowState}, ${nodeState}) no longer decodes`
  );

  return members.map((member) => member.status);
};

/**
 * The words the UI shows for each value of a union whose words a client module computes, read from
 * the live tables by import. The thread row's own words (`threadState`) are
 * `thread-state-rows.test.ts`'s to check.
 */
const LIVE_WORDS = new Map<string, (value: string) => ReadonlyArray<string>>([
  // A settled record's transcript line, decided by the user.
  [
    "ApprovalStatus",
    (status) =>
      Option.toArray(settledLineOf(approvalRecord(status))).map(
        (line) => line.text
      ),
  ],
  [
    "BudgetState",
    (state) =>
      Option.toArray(
        budgetWordOf(Schema.decodeUnknownSync(Spend.BudgetState)(state))
      ).map((found) => found.word),
  ],
  [
    "CriterionState",
    (state) => [
      criterionStateLabel(
        Schema.decodeUnknownSync(Policy.CriterionState)(state)
      ).word,
    ],
  ],
  // A node's word in the steps panel while its workflow runs.
  ["NodeState", (state) => nodeWord("running", state)],
  // What a node still running reads once its workflow is in this state: none while it may run.
  [
    "WorkflowState",
    (state) => nodeWord(state, "running").filter((word) => word !== "running"),
  ],
  // A child at rest whose latest settlement ended so, as its row in the work panel reads.
  [
    "SettlementOutcome",
    (outcome) => [
      CHILD_LABELS[
        childStatusOf(
          shellRow(2),
          Option.none(),
          Option.some(
            Schema.decodeUnknownSync(Subagents.SettlementOutcome)(outcome)
          )
        )
      ].word,
    ],
  ],
]);

/** The label map's "The UI shows" cell, by `Schema value`. */
const labelCells = (text: string): ReadonlyMap<string, string> => {
  const start = text.indexOf("\n## Label map\n");
  const end = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, end === -1 ? text.length : end);
  const cells = new Map<string, string>();

  for (const line of section.split("\n")) {
    const found =
      /^\|\s*`(?<schema>[^`]+)`\s*\|\s*`(?<value>[^`]+)`\s*\|(?<shows>[^|]*)\|/u.exec(
        line
      )?.groups;

    if (found !== undefined) {
      cells.set(`${found.schema} ${found.value}`, found.shows?.trim() ?? "");
    }
  }

  return cells;
};

/** The non-test modules of a client folder, with their source. */
const clientModules = (
  directory: string
): ReadonlyArray<readonly [string, string]> =>
  readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);

    if (statSync(full).isDirectory()) {
      return clientModules(full);
    }

    return name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !/(?:Fixtures|Specimens|TestKit)\.ts$/u.test(name)
      ? [[path.relative(root, full), readFileSync(full, "utf-8")] as const]
      : [];
  });

const CLIENT_MODULES = [
  ...clientModules(path.join(root, "packages", "client-logic", "src")),
  ...clientModules(path.join(root, "apps", "web", "src")),
];

/**
 * The client modules that import, from the protocol, the union's own type (an inline union's
 * export) or an export that holds it directly.
 */
const readersOf = (union: string): ReadonlyArray<string> => {
  const own = union.split(".")[0] ?? union;
  const holders = HOLDERS.get(union) ?? new Set<string>();
  const types = [own, ...holders].join("|");

  const imports = new RegExp(
    String.raw`import(?:\s+type)?\s*\{[^}]*\b(?:${types})\b[^}]*\}\s*from\s*"@cairn/protocol/`,
    "u"
  );

  return CLIENT_MODULES.flatMap(([name, source]) =>
    imports.test(source) ? [name] : []
  );
};

/** Where the label map lies: "Not shown yet" for a union a client reads, or the wrong words. */
const labelLies = (text: string): ReadonlyArray<string> => {
  const cells = labelCells(text);

  return statuses.flatMap(([name, values]) => {
    const readers = readersOf(name);
    const live = Option.fromUndefinedOr(LIVE_WORDS.get(name));

    return values.flatMap((value) => {
      const key = `${name} ${value}`;
      const cell = cells.get(key) ?? "";
      const lies: Array<string> = [];

      if (cell.includes("Not shown yet") && readers.length > 0) {
        lies.push(
          `${key} says "Not shown yet", but ${readers.join(", ")} reads ${name}`
        );
      }

      for (const word of Option.match(live, {
        onNone: () => [],
        onSome: (wordsOf) => wordsOf(value),
      })) {
        if (!cell.includes(`"${word}"`)) {
          lies.push(
            `${key}: the UI shows "${word}", which the label map does not quote`
          );
        }
      }

      return lies;
    });
  });
};

/** A path the doc cites, and the symbols it names beside it. */
interface Citation {
  readonly path: string;
  readonly symbols: ReadonlyArray<string>;
}

const citationsOf = (text: string): ReadonlyArray<Citation> =>
  [
    ...text.matchAll(
      /`(?<path>(?:apps|packages|judges|docs|ops)\/[^`\s]+)`(?:\s*\((?<symbols>`[^`]+`(?:(?:,\s*|,?\s+and\s+)`[^`]+`)*)\))?/gu
    ),
  ].map((match) => ({
    path: match.groups?.path ?? "",
    symbols: [
      ...(match.groups?.symbols ?? "").matchAll(/`(?<name>[^`]+)`/gu),
    ].map((symbol) => symbol.groups?.name ?? ""),
  }));

/** Where the doc's citations are wrong: a missing path, a line range, a symbol not in its file. */
const citationLies = (text: string): ReadonlyArray<string> =>
  citationsOf(text).flatMap(({ path: cited, symbols }) => {
    const [file = cited] = cited.split(":");

    if (cited.includes(":")) {
      return [`${cited}: cite the symbol, not a line range`];
    }

    if (!existsSync(path.join(root, file))) {
      return [`${cited}: no such file`];
    }

    const source = readFileSync(path.join(root, file), "utf-8");

    return symbols.flatMap((symbol) => {
      const name = symbol.split(".").at(-1) ?? symbol;

      return new RegExp(
        String.raw`\b${name.replaceAll("$", String.raw`\$`)}\b`,
        "u"
      ).test(source)
        ? []
        : [`${cited}: names \`${symbol}\`, which it does not hold`];
    });
  });

describe("thread states doc", () => {
  it("reads every protocol module", () => {
    const files = readdirSync(protocolDir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => file.slice(0, -".ts".length))
      .toSorted();

    assert.deepStrictEqual(files, Object.keys(MODULES).toSorted());
  });

  it("names only unions the protocol still has as not statuses", () => {
    const stale = Object.keys(NOT_STATUSES).filter((name) => !unions.has(name));

    assert.deepStrictEqual(stale, []);
  });

  it("finds exported and inline statuses", () => {
    for (const name of [
      "ThreadActivity",
      "ApprovalStatus",
      "ExecutorStatus.state",
    ]) {
      assert.isTrue(unions.has(name), `${name} was not found`);
    }
  });

  it("has a status table row for every protocol status", () => {
    assert.deepStrictEqual(missingFrom("Statuses"), []);
  });

  it("has a label for every protocol status", () => {
    assert.deepStrictEqual(missingFrom("Label map"), []);
  });

  it("says what the UI shows once a client reads a status, in the live words", () => {
    assert.deepStrictEqual(labelLies(doc), []);
  });

  it("cites only files and symbols that exist", () => {
    assert.isAbove(citationsOf(doc).length, 30);
    assert.deepStrictEqual(citationLies(doc), []);
  });

  it("fails on a label map or a citation that lies (control)", () => {
    const notShown = doc.replace(
      '| `NodeState` | `held` | "held", with Stop. |',
      "| `NodeState` | `held` | Not shown yet; the steps panel (6F). |"
    );

    const deletedPath = `${doc}\n- Gone: \`apps/web/src/sidebar/Row.ts\`.\n`;

    const ranged = `${doc}\n- Ranged: \`apps/server/src/shell/ShellProjector.ts:154-175\`.\n`;

    const wrongSymbol = `${doc}\n- Wrong: \`apps/server/src/shell/ShellProjector.ts\` (\`noSuchProjection\`).\n`;

    // No client imports `UsageReading` itself: the settings page reads it through `ProviderUsage`.
    const heldNotShown = doc.replace(
      '| `UsageReading` | `unsupported` | "This plan publishes no windows Cairn can read." |',
      "| `UsageReading` | `unsupported` | Not shown yet; the meters (6G). |"
    );

    assert.notStrictEqual(notShown, doc);
    assert.deepStrictEqual(labelLies(notShown), [
      'NodeState held says "Not shown yet", but packages/client-logic/src/WorkflowSteps.ts reads NodeState',
      'NodeState held: the UI shows "held", which the label map does not quote',
    ]);
    assert.notStrictEqual(heldNotShown, doc);
    assert.deepStrictEqual(labelLies(heldNotShown), [
      'UsageReading unsupported says "Not shown yet", but apps/web/src/settings/View.ts reads UsageReading',
    ]);
    assert.deepStrictEqual(citationLies(deletedPath), [
      "apps/web/src/sidebar/Row.ts: no such file",
    ]);
    assert.deepStrictEqual(citationLies(ranged), [
      "apps/server/src/shell/ShellProjector.ts:154-175: cite the symbol, not a line range",
    ]);
    assert.deepStrictEqual(citationLies(wrongSymbol), [
      "apps/server/src/shell/ShellProjector.ts: names `noSuchProjection`, which it does not hold",
    ]);
  });
});
