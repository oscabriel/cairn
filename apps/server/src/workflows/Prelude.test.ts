import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { CodemodeResult, CodemodeTool } from "@earendil-works/pi-codemode";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Predicate, Schema } from "effect";

import {
  BAKE_CLOSING,
  BAKE_OPENING,
  isRewrittenWorkflow,
  NODE_TOOLS,
  PRELUDE_OPENING,
  PRELUDE_SOURCE,
  PRELUDE_VERSION,
  rewriteScript,
  TOO_MANY_ITEMS,
} from "./Prelude.ts";
import type { PreludeBake } from "./Prelude.ts";
import { isWorkflowSource, parseWorkflowScript } from "./WorkflowScript.ts";

const META = `export const meta = {
  name: "prelude-test",
  description: "Exercises the prelude",
};`;

const BAKE: PreludeBake = {
  workflowId: "wf-7",
  sample: Option.none(),
  budgetTokens: Option.some(500_000),
  args: { files: ["a.ts", "b.ts", "c.ts"] },
};

interface Call {
  readonly name: string;
  readonly args: Schema.Json;
}

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));

/**
 * Fake node tools: `agent` answers its prompt upper-cased, rejects a prompt containing "fail" as a
 * failed node and one containing "stop" as a stopped node does ("Tool node was aborted").
 */
const fakeTools = (calls: Array<Call>) => {
  let nodes = 0;

  return NODE_TOOLS.map((name): CodemodeTool => ({
    name,
    execute: (args) => {
      const json = decodeJson(args);

      calls.push({ name, args: json });

      const prompt =
        isRecord(json) && Predicate.isString(json.prompt) ? json.prompt : "";

      if (name === "agent" || name === "verify") {
        if (
          prompt.includes("fail") ||
          (name === "verify" && isRecord(json) && json.claim === "fail")
        ) {
          throw new Error("the node failed");
        }

        if (prompt.includes("stop")) {
          throw new Error("Tool node was aborted");
        }

        nodes += 1;

        return {
          status: "ok",
          value:
            name === "verify" ? { verdict: "verified" } : prompt.toUpperCase(),
          reason: null,
          nodeId: `n-${nodes}`,
        };
      }

      if (name === "budget") {
        return { spent: 1200, remaining: null };
      }

      return null;
    },
  }));
};

/** Runs `body` behind the prelude with fake node tools; answers the result and every tool call. */
const runScript = (body: string, bake: PreludeBake = BAKE) =>
  Effect.gen(function* () {
    const script = yield* parseWorkflowScript(`${META}\n${body}`);
    const calls: Array<Call> = [];
    const code = rewriteScript(script, bake);

    const result: CodemodeResult = yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          new CodemodeSandbox({ tools: fakeTools(calls), timeoutMs: 10_000 })
      ),
      (sandbox) => Effect.promise(async () => await sandbox.execute(code)),
      (sandbox) =>
        Effect.promise(async () => {
          await sandbox.close();
        })
    );

    return { result, calls, script, code };
  });

const valueOf = (result: CodemodeResult) => {
  if (!result.ok) {
    assert.fail(
      `the script failed: ${result.error.message}\n${result.error.stack ?? ""}`
    );
  }

  return result.value;
};

const named = (calls: ReadonlyArray<Call>, name: string) =>
  calls.flatMap((call) => (call.name === name ? [call.args] : []));

describe(rewriteScript, () => {
  it.effect("keeps every line of the script on its line", () =>
    Effect.gen(function* () {
      const source = readFileSync(
        new URL("fixtures/review.workflow", import.meta.url),
        "utf-8"
      );

      const script = yield* parseWorkflowScript(source);
      const rewritten = rewriteScript(script, BAKE).split("\n");
      const original = source.split("\n");

      const exportLine =
        source.slice(0, script.exportAt).split("\n").length - 1;

      for (const [index, line] of original.entries()) {
        if (index === exportLine) {
          assert.isTrue(
            rewritten[index]?.endsWith(line.replace(/^export/u, ""))
          );
        } else {
          assert.strictEqual(rewritten[index], line, `line ${index + 1}`);
        }
      }
    })
  );

  it.effect("is deterministic, so a stored call replays the same text", () =>
    Effect.gen(function* () {
      const script = yield* parseWorkflowScript(`${META}\nreturn 1;`);

      assert.strictEqual(
        rewriteScript(script, BAKE),
        rewriteScript(script, BAKE)
      );
      assert.notStrictEqual(
        rewriteScript(script, BAKE),
        rewriteScript(script, { ...BAKE, sample: Option.some(1) })
      );
    })
  );

  it.effect(
    "opens with the same text for every bake, so a call on the meta's line keeps its column",
    () =>
      Effect.gen(function* () {
        const script = yield* parseWorkflowScript(
          `${META} await agent("on the meta line");\nreturn 1;`
        );

        const sites = (bake: PreludeBake) =>
          rewriteScript(script, bake).split("\n").slice(0, 4).join("\n");

        assert.strictEqual(
          sites(BAKE),
          sites({
            workflowId: "dry-run",
            sample: Option.some(3),
            budgetTokens: Option.none(),
            args: { other: "args, longer than the first" },
          })
        );
        assert.include(sites(BAKE), PRELUDE_OPENING);
      })
  );

  it.effect(
    "marks rewritten scripts apart from the source they came from",
    () =>
      Effect.gen(function* () {
        const source = `${META}\nreturn 1;`;
        const script = yield* parseWorkflowScript(source);
        const rewritten = rewriteScript(script, BAKE);

        assert.isTrue(isWorkflowSource(source));
        assert.isFalse(isRewrittenWorkflow(source));
        assert.isTrue(isRewrittenWorkflow(rewritten));
      })
  );

  it("pins the prelude's text to its version", () => {
    // Changing the opening or the prelude changes what a stored run replays: bump PRELUDE_VERSION,
    // then update this pair.
    const hash = createHash("sha256")
      .update(
        `${PRELUDE_OPENING}\n${PRELUDE_SOURCE}\n${BAKE_OPENING}\n${BAKE_CLOSING}`,
        "utf-8"
      )
      .digest("hex")
      .slice(0, 16);

    assert.deepStrictEqual(
      { version: PRELUDE_VERSION, hash },
      {
        version: 2,
        hash: "c1eecb76450d137b",
      }
    );
  });

  it.effect(
    "begins every run with workflow_begin naming the script's hash",
    () =>
      Effect.gen(function* () {
        const { result, calls, script } = yield* runScript("return meta.name;");

        assert.strictEqual(valueOf(result), "prelude-test");
        assert.deepStrictEqual(calls[0], {
          name: "workflow_begin",
          args: {
            workflowId: "wf-7",
            scriptHash: script.hash,
            preludeVersion: PRELUDE_VERSION,
          },
        });
      })
  );
});

describe("the prelude", () => {
  it.effect(
    "records each agent call's site as the script's own line and column",
    () =>
      Effect.gen(function* () {
        // META is lines 1 to 4; the body starts on line 5.
        const { result, calls } = yield* runScript(
          [
            'const one = await agent("first");',
            "const many = await pipeline(args.files,",
            '  (file) => agent("read " + file));',
            "return [one, many];",
          ].join("\n")
        );

        valueOf(result);

        const sites = named(calls, "agent").map((args) =>
          isRecord(args) && Predicate.isString(args.site) ? args.site : ""
        );

        // The column is where QuickJS places the call expression; only the line is the reader's.
        assert.deepStrictEqual(
          sites.map((site) => site.split(":")[0]),
          ["5", "7", "7", "7"]
        );
        assert.strictEqual(new Set(sites).size, 2);
      })
  );

  it.effect(
    "turns a failed or stopped node into null, and agent.full tells them apart",
    () =>
      Effect.gen(function* () {
        const { result } = yield* runScript(`
const plain = await agent("this will fail");
const stopped = await agent.full("please stop");
const failed = await agent.full("fail now");
const ok = await agent.full("fine");
return { plain, stopped: stopped.status, failed: failed.status, ok };`);

        assert.deepStrictEqual(valueOf(result), {
          plain: null,
          stopped: "stopped",
          failed: "failed",
          ok: { status: "ok", value: "FINE", reason: null, nodeId: "n-1" },
        });
      })
  );

  it.effect("parallel is a barrier whose failed thunks become null", () =>
    Effect.gen(function* () {
      const { result } = yield* runScript(`
return await parallel([
  () => agent("a"),
  () => agent("fail b"),
  () => { throw new Error("thrown"); },
  "not a function",
  () => agent("c"),
]);`);

      assert.deepStrictEqual(valueOf(result), ["A", null, null, null, "C"]);
    })
  );

  it.effect(
    "pipeline passes (previous, item, index) and drops an item whose stage throws",
    () =>
      Effect.gen(function* () {
        const { result } = yield* runScript(`
return await pipeline(
  ["x", "fail-y", "z"],
  (item, item2, index) => agent(item + ":" + item2 + ":" + index),
  (previous, item, index) => {
    if (item === "z") throw new Error("drop z");
    return previous + "|" + item + "|" + index;
  }
);`);

        // A failed node is null and passes on; a stage that throws drops its item.
        assert.deepStrictEqual(valueOf(result), [
          "X:X:0|x|0",
          "null|fail-y|1",
          null,
        ]);
      })
  );

  it.effect("run on 1 first takes one item and logs what it left", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runScript(
        'return await pipeline(args.files, (file) => agent("read " + file));',
        { ...BAKE, sample: Option.some(1) }
      );

      assert.deepStrictEqual(valueOf(result), ["READ A.TS"]);
      assert.strictEqual(named(calls, "agent").length, 1);
      assert.deepStrictEqual(named(calls, "log"), [
        {
          workflowId: "wf-7",
          text: "Run on 1 first: pipeline() took 1 of 3 items and left the rest.",
        },
      ]);
    })
  );

  it.effect(
    "phase() sets the phase of later nodes, and unawaited phase and log calls finish",
    () =>
      Effect.gen(function* () {
        const { result, calls } = yield* runScript(`
phase("Read");
await agent("one");
await agent("two", { phase: "Elsewhere" });
log("done");
return "returned without awaiting";`);

        valueOf(result);

        const phases = named(calls, "agent").map((args) =>
          isRecord(args) ? args.phase : null
        );

        assert.deepStrictEqual(phases, ["Read", "Elsewhere"]);
        assert.deepStrictEqual(named(calls, "phase"), [
          { workflowId: "wf-7", title: "Read" },
        ]);
        assert.deepStrictEqual(named(calls, "log"), [
          { workflowId: "wf-7", text: "done" },
        ]);
      })
  );

  it.effect(
    "passes agent options through and reports keys it does not know",
    () =>
      Effect.gen(function* () {
        const { calls } = yield* runScript(`
await agent("x", { role: "@scout", schema: { type: "object" }, readonly: true, key: "k", effort: "low", model: "opus", isolation: "worktree" });`);

        const [call] = named(calls, "agent");

        assert.deepInclude(call, {
          role: "@scout",
          schema: { type: "object" },
          readonly: true,
          key: "k",
          effort: "low",
          resume: null,
          unknownOptions: ["model", "isolation"],
        });
      })
  );

  it.effect(
    "budget reads through the node tool and has no ceiling without a token limit",
    () =>
      Effect.gen(function* () {
        const { result, calls } = yield* runScript(
          "return [budget.total, await budget.spent(), await budget.remaining()];"
        );

        assert.deepStrictEqual(valueOf(result), [500_000, 1200, null]);
        // Infinity does not survive the JSON round trip out of the VM; it is null here and Infinity inside.
        assert.strictEqual(named(calls, "budget").length, 2);
      })
  );

  it.effect("args are frozen", () =>
    Effect.gen(function* () {
      const { result } = yield* runScript(`
try {
  args.files.push("d.ts");
  return "changed";
} catch (error) {
  return [Object.isFrozen(args), args.files.length];
}`);

      assert.deepStrictEqual(valueOf(result), [true, 3]);
    })
  );

  it.effect(
    "reads a __proto__ key in args as a key, as the card shows it",
    () =>
      Effect.gen(function* () {
        const { result } = yield* runScript(
          "return [Object.keys(args), args.polluted === undefined, Object.getPrototypeOf(args) === Object.prototype];",
          {
            ...BAKE,
            args: decodeJson(JSON.parse('{"__proto__":{"polluted":"yes"}}')),
          }
        );

        assert.deepStrictEqual(valueOf(result), [["__proto__"], true, true]);
      })
  );

  it.effect("refuses more than 4,096 items rather than cutting the list", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runScript(
        'return await parallel(Array.from({ length: 4097 }, () => () => agent("x")));'
      );

      assert.isFalse(result.ok);

      if (!result.ok) {
        assert.include(result.error.message, TOO_MANY_ITEMS);
      }

      assert.strictEqual(named(calls, "agent").length, 0);
    })
  );

  it.effect("verify answers unverified, never null, when its node fails", () =>
    Effect.gen(function* () {
      const { result } = yield* runScript(`
return [await verify({ a: 1 }, { claim: "holds" }), await verify({ a: 1 }, { claim: "fail" })];`);

      assert.deepStrictEqual(valueOf(result), [
        { verdict: "verified" },
        { verdict: "unverified", reason: "the node failed" },
      ]);
    })
  );
});
