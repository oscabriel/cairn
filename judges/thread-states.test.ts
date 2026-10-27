// Thread states judge: every status the protocol defines has a row in the status table and in the
// label map of docs/golden/thread-states.md. The statuses come from the schemas themselves: every
// literal union reachable from a schema `@cairn/protocol` exports, named by the export holding
// the union (`ThreadActivity`, or `ExecutorStatus.state` for a union declared inline). A union that names
// something other than a state (a kind, a mode, a setting, an error reason) is listed in
// `NOT_STATUSES` with the reason, so a new union fails here until someone files it.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import * as Attachments from "@cairn/protocol/Attachments";
import * as Checkpoints from "@cairn/protocol/Checkpoints";
import * as Errors from "@cairn/protocol/Errors";
import * as Executor from "@cairn/protocol/Executor";
import * as Ids from "@cairn/protocol/Ids";
import * as JsonSchema from "@cairn/protocol/JsonSchema";
import * as Launch from "@cairn/protocol/Launch";
import * as Models from "@cairn/protocol/Models";
import * as Policy from "@cairn/protocol/Policy";
import * as Projects from "@cairn/protocol/Projects";
import * as Push from "@cairn/protocol/Push";
import * as Rpc from "@cairn/protocol/Rpc";
import * as Settings from "@cairn/protocol/Settings";
import * as Shell from "@cairn/protocol/Shell";
import * as ShellCommands from "@cairn/protocol/ShellCommands";
import * as Skills from "@cairn/protocol/Skills";
import * as Thread from "@cairn/protocol/Thread";
import * as Usage from "@cairn/protocol/Usage";
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
  Policy,
  Projects,
  Push,
  Rpc,
  Settings,
  Shell,
  ShellCommands,
  Skills,
  Thread,
  Usage,
} as const;

/** Literal unions that are not states, and why. */
const NOT_STATUSES = {
  AttachmentKind: "what an attachment is, fixed at upload",
  ApprovalDecision: "the user's answer, an input to `ApprovalStatus`",
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

/**
 * Every literal union the protocol's exported schemas reach, by name: an exported union by its
 * export name, an inline one by the first export and property path that reach it.
 */
const protocolUnions = (): ReadonlyMap<string, ReadonlyArray<string>> => {
  const names = new Map<SchemaAST.Union<SchemaAST.Literal>, string>();

  const schemas = Object.values(MODULES).flatMap((module) =>
    Object.entries<unknown>(module).filter(
      (entry): entry is [string, Schema.Top] => Schema.isSchema(entry[1])
    )
  );

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
});
