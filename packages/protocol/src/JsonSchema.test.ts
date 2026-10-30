import { readFileSync, writeFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import { Schema, SchemaAST } from "effect";

import {
  DOCUMENT_SCHEMAS,
  documentJsonSchemas,
  rpcJsonSchemas,
} from "./JsonSchema.ts";
import { VISIBLE_DOCUMENTS } from "./Thread.ts";

const goldenPath = new URL("../schema/cairn-rpcs.json", import.meta.url);

// Regenerate with `CAIRN_UPDATE_GOLDENS=1 pnpm vitest run packages/protocol`, then review the diff:
// every change here is a wire change some client must follow. The comparison is on parsed JSON, so
// the formatter may lay the file out as it likes.
describe(rpcJsonSchemas, () => {
  it("matches the committed golden file", () => {
    const rendered = `${JSON.stringify(rpcJsonSchemas(), null, 2)}\n`;

    if (process.env.CAIRN_UPDATE_GOLDENS === "1") {
      writeFileSync(goldenPath, rendered);
    }

    const current: unknown = JSON.parse(rendered);
    const golden: unknown = JSON.parse(readFileSync(goldenPath, "utf-8"));

    assert.deepStrictEqual(
      current,
      golden,
      "The RPC group's JSON Schema changed. If the change is intended, regenerate the golden with CAIRN_UPDATE_GOLDENS=1 and review it."
    );
  });

  it("describes every stream's chunk, never an empty schema", () => {
    const streams = rpcJsonSchemas().filter((rpc) => rpc.stream);

    assert.deepStrictEqual(
      streams.map((rpc) => rpc.tag),
      [
        "shell.subscribe",
        "thread.subscribe",
        "usage.subscribe",
        "providers.login.start",
      ]
    );

    for (const rpc of streams) {
      assert.notDeepEqual(rpc.success.schema, {}, `${rpc.tag} success`);
      assert.notDeepEqual(rpc.error.schema, {}, `${rpc.tag} error`);
    }
  });

  it("covers every RPC of phases 1 and 2 once", () => {
    const tags = rpcJsonSchemas().map((rpc) => rpc.tag);

    assert.strictEqual(new Set(tags).size, tags.length);
    assert.deepStrictEqual(tags.toSorted(), [
      "artifact.revoke",
      "attachments.createUploadUrl",
      "attachments.discard",
      "diff.full",
      "diff.turn",
      "executor.signIn",
      "executor.status",
      "git.branches",
      "goal.mark",
      "goal.setCriteria",
      "models.list",
      "portal.close",
      "portal.start",
      "presence.report",
      "projects.browse",
      "projects.ensureScratch",
      "projects.searchEntries",
      "providers.login.cancel",
      "providers.login.start",
      "providers.logout",
      "providers.status",
      "push.subscribe",
      "push.unsubscribe",
      "reach.list",
      "roles.check",
      "session.hello",
      "settings.get",
      "settings.update",
      "shell.dispatch",
      "shell.subscribe",
      "skills.list",
      "skills.reload",
      "spend.get",
      "thread.configure",
      "thread.entry",
      "thread.history",
      "thread.launch",
      "thread.respond",
      "thread.retryTask",
      "thread.send",
      "thread.stop",
      "thread.subscribe",
      "thread.withdraw",
      "usage.subscribe",
      "workflow.eventStatus",
      "workflow.list",
      "workflow.stop",
      "workflow.stopNode",
    ]);
  });

  it("lists the viewer middleware's error on every RPC", () => {
    for (const rpc of rpcJsonSchemas()) {
      assert.include(JSON.stringify(rpc.error), "UnauthorizedEncoded", rpc.tag);
    }
  });
});

/** Whether any node of a schema decodes through a transformation (an Option, a date, ...). */
const transforms = (ast: SchemaAST.AST): boolean => {
  if (ast.encoding !== undefined) {
    return true;
  }

  if (SchemaAST.isObjects(ast)) {
    return [
      ...ast.propertySignatures.map((signature) => signature.type),
      ...ast.indexSignatures.map((signature) => signature.type),
    ].some(transforms);
  }

  if (SchemaAST.isArrays(ast)) {
    return [...ast.elements, ...ast.rest].some(transforms);
  }

  if (SchemaAST.isUnion(ast)) {
    return ast.types.some(transforms);
  }

  return false;
};

const documentsGoldenPath = new URL(
  "../schema/cairn-documents.json",
  import.meta.url
);

describe(documentJsonSchemas, () => {
  it("matches the committed golden file", () => {
    const rendered = `${JSON.stringify(documentJsonSchemas(), null, 2)}\n`;

    if (process.env.CAIRN_UPDATE_GOLDENS === "1") {
      writeFileSync(documentsGoldenPath, rendered);
    }

    assert.deepStrictEqual(
      JSON.parse(rendered),
      JSON.parse(readFileSync(documentsGoldenPath, "utf-8")),
      "A document's JSON Schema changed. Documents are wire too: regenerate the golden with CAIRN_UPDATE_GOLDENS=1 and review it."
    );
  });

  it("covers every document the thread stream shows", () => {
    const kinds = new Set(documentJsonSchemas().map((entry) => entry.kind));

    for (const kind of VISIBLE_DOCUMENTS.filter((name) =>
      name.startsWith("cairn.")
    )) {
      assert.isTrue(kinds.has(kind), kind);
    }
  });

  it("keeps documents plain JSON: no transformation, so no Option inside", () => {
    // Ops address a document's JSON by path on both sides, so an optional field is `null`.
    assert.isTrue(
      transforms(Schema.Struct({ at: Schema.OptionFromNullOr(Schema.Int) }).ast)
    );

    for (const [kind, schema] of DOCUMENT_SCHEMAS) {
      assert.isFalse(transforms(schema.ast), kind);
    }
  });
});

describe("the RPC golden", () => {
  it("lists the viewer middleware's error on every RPC", () => {
    for (const rpc of rpcJsonSchemas()) {
      assert.include(JSON.stringify(rpc.error), "UnauthorizedEncoded", rpc.tag);
    }
  });
});
