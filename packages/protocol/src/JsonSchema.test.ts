import { readFileSync, writeFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";

import { rpcJsonSchemas } from "./JsonSchema.ts";

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
      ["shell.subscribe", "thread.subscribe", "usage.subscribe"]
    );

    for (const rpc of streams) {
      assert.notDeepEqual(rpc.success.schema, {}, `${rpc.tag} success`);
      assert.notDeepEqual(rpc.error.schema, {}, `${rpc.tag} error`);
    }
  });

  it("covers every Phase 1 RPC once", () => {
    const tags = rpcJsonSchemas().map((rpc) => rpc.tag);

    assert.strictEqual(new Set(tags).size, tags.length);
    assert.deepStrictEqual(tags.toSorted(), [
      "attachments.createUploadUrl",
      "attachments.discard",
      "diff.full",
      "diff.turn",
      "executor.signIn",
      "executor.status",
      "git.branches",
      "models.list",
      "presence.report",
      "projects.browse",
      "projects.ensureScratch",
      "projects.searchEntries",
      "providers.status",
      "push.subscribe",
      "push.unsubscribe",
      "session.hello",
      "settings.get",
      "settings.update",
      "shell.dispatch",
      "shell.subscribe",
      "skills.list",
      "skills.reload",
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
    ]);
  });

  it("lists the viewer middleware's error on every RPC", () => {
    for (const rpc of rpcJsonSchemas()) {
      assert.include(JSON.stringify(rpc.error), "UnauthorizedEncoded", rpc.tag);
    }
  });
});
