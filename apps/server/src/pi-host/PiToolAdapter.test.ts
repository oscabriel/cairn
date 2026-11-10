// Judges the mapping from a pi TUI extension's tool to a pi-durable tool (ADR 0039): the mapping
// table on hand-built definitions and on the fixture extension loaded through pi's own loader, the
// running output and result shapes, and that a tool calling what the host does not support fails
// with the API named while a tool that asks the user is told no. Fixture packages only: the user's
// real pi-web-access and pi-fff are loaded by `judges/pi-host.ts`, which reads the real install.

import path from "node:path";

import { ThreadId } from "@cairn/protocol/Ids";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Function, Option } from "effect";

import { PiHost, PI_TOOLS_SECTION } from "./PiHost.ts";
import {
  brainLayer,
  callTool,
  FIXTURE_FLAG,
  fixturePolicy,
  hostLayer,
  makeFixture,
} from "./PiHostTestKit.ts";
import {
  adaptTool,
  callersOf,
  partialOutput,
  piToolsSection,
  resultOf,
} from "./PiToolAdapter.ts";

const thread = (n: number) =>
  ThreadId.make(
    `0190f0c0-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`
  );

const textResult = (text: string): AgentToolResult<unknown> => ({
  content: [{ type: "text", text }],
  details: null,
});

/** A definition with every optional field the mapping reads, which a runner never runs. */
const definition = (fields: Partial<ToolDefinition>): ToolDefinition => ({
  name: "probe",
  label: "Probe",
  description: "A probe.",
  parameters: { type: "object", properties: {} },
  execute: async () => await Promise.resolve(textResult("unused")),
  ...fields,
});

const neverRun = async () => await Promise.resolve(textResult("unused"));

describe("the mapping table", () => {
  it("maps each exposure to its callers and drops a hidden tool", () => {
    assert.deepStrictEqual(
      callersOf(definition({}).exposure),
      Option.some(["model", "tools"])
    );
    assert.deepStrictEqual(
      callersOf("direct"),
      Option.some(["model", "tools"])
    );
    assert.deepStrictEqual(callersOf("model-only"), Option.some(["model"]));
    assert.deepStrictEqual(callersOf("codemode"), Option.some(["tools"]));
    assert.deepStrictEqual(callersOf("deferred"), Option.some(["tools"]));
    assert.isTrue(Option.isNone(callersOf("hidden")));
    assert.isTrue(
      Option.isNone(
        adaptTool(definition({ exposure: "hidden" }), "safe", neverRun)
      )
    );
  });

  it("carries the fields pi-durable shares and takes replay from the policy", () => {
    const schema = { type: "object", properties: { n: { type: "number" } } };

    const adapted = Option.getOrThrow(
      adaptTool(
        definition({
          prepareArguments: Function.identity,
          executionMode: "sequential",
          outputSchema: schema,
          promptSnippet: "ignored here",
          renderCall: () => {
            throw new Error("renderers are dropped");
          },
        }),
        "unsafe",
        neverRun
      )
    );

    assert.strictEqual(adapted.name, "probe");
    assert.strictEqual(adapted.description, "A probe.");
    assert.strictEqual(adapted.replay, "unsafe");
    assert.strictEqual(adapted.executionMode, "sequential");
    assert.strictEqual(adapted.structuredOutputSchema, schema);
    const args = { n: 1 };

    assert.strictEqual(adapted.prepareArguments?.(args), args);
    assert.deepStrictEqual(adapted.callers, ["model", "tools"]);
    assert.notProperty(adapted, "renderCall");
    assert.notProperty(adapted, "promptSnippet");

    const bare = Option.getOrThrow(adaptTool(definition({}), "safe", neverRun));

    assert.strictEqual(bare.replay, "safe");
    assert.notProperty(bare, "executionMode");
    assert.notProperty(bare, "structuredOutputSchema");
    assert.notProperty(bare, "prepareArguments");
  });

  it("turns cumulative partial results into running output chunks", () => {
    const chunks = partialOutput();

    assert.deepStrictEqual(chunks(textResult("look")), Option.some("look"));
    assert.deepStrictEqual(chunks(textResult("looking")), Option.some("ing"));
    assert.isTrue(Option.isNone(chunks(textResult("looking"))));
    assert.deepStrictEqual(chunks(textResult("other")), Option.some("\nother"));
  });

  it("keeps details as plain JSON and structured output only under a schema", () => {
    const result: AgentToolResult<unknown> = {
      content: [{ type: "text", text: "ok" }],
      details: { kept: 1, dropped: undefined, notJson: Number.NaN },
      structuredContent: { answer: 42 },
      isError: true,
    };

    const withSchema = resultOf(
      definition({ outputSchema: { type: "object" } }),
      result
    );

    assert.deepStrictEqual(withSchema, {
      output: [{ type: "text", text: "ok" }],
      details: { kept: 1, notJson: null },
      structuredOutput: { answer: 42 },
      isError: true,
    });

    const withoutSchema = resultOf(definition({}), {
      content: [],
      details: undefined,
    });

    assert.deepStrictEqual(withoutSchema, { output: [] });
  });

  it("renders snippets and guidelines into one section, or none", () => {
    assert.isTrue(Option.isNone(piToolsSection([definition({})])));
    assert.deepStrictEqual(
      piToolsSection([
        definition({ name: "a", promptSnippet: "Use a." }),
        definition({ name: "b", promptGuidelines: ["Prefer b.", "Then a."] }),
      ]),
      Option.some(
        [
          "Tools from the user's pi extensions:",
          "- a: Use a.",
          "",
          "Guidelines:",
          "- Prefer b.",
          "- Then a.",
        ].join("\n")
      )
    );
  });
});

const fixture = makeFixture(["pi-host-fixture"]);

layer(
  brainLayer(
    hostLayer(fixture, fixturePolicy(fixture, { scope: "folder" })),
    path.join(fixture.root, "brain")
  ),
  { timeout: 60_000, excludeTestServices: true }
)("the fixture extension through the host", (live) => {
  live.effect("installs each tool with its callers and replay", () =>
    Effect.gen(function* () {
      const host = yield* PiHost;
      const { extension } = host.extension;

      const tools = new Map(
        (extension.tools ?? []).map((tool) => [tool.name, tool])
      );

      assert.deepStrictEqual(
        [...tools.keys()].toSorted(),
        [
          "fixture_codemode",
          "fixture_confirm",
          "fixture_deferred",
          "fixture_model_only",
          "fixture_rename",
          "fixture_send",
          "fixture_where",
        ],
        "hidden and policy-dropped tools are absent"
      );

      assert.deepStrictEqual(tools.get("fixture_where")?.callers, [
        "model",
        "tools",
      ]);
      assert.deepStrictEqual(tools.get("fixture_model_only")?.callers, [
        "model",
      ]);
      assert.deepStrictEqual(tools.get("fixture_codemode")?.callers, ["tools"]);
      assert.deepStrictEqual(tools.get("fixture_deferred")?.callers, ["tools"]);
      assert.strictEqual(tools.get("fixture_where")?.replay, "safe");
      assert.strictEqual(tools.get("fixture_send")?.replay, "unsafe");
      assert.strictEqual(tools.get("fixture_where")?.executionMode, "parallel");
      assert.strictEqual(
        tools.get("fixture_codemode")?.executionMode,
        "sequential"
      );
      assert.isDefined(tools.get("fixture_codemode")?.structuredOutputSchema);
      assert.deepStrictEqual(
        (extension.sections ?? []).map((section) => section.key),
        [PI_TOOLS_SECTION]
      );
    })
  );

  live.effect("runs a tool in the thread's folder with the host's flags", () =>
    Effect.gen(function* () {
      const folder = fixture.folder("where");

      const [result = ""] = yield* callTool(
        [{ threadId: thread(1), cwd: folder }],
        "fixture_where",
        { delayMs: 0 }
      );

      assert.include(result, `started in ${folder}`);
      assert.include(result, `"flag":"${FIXTURE_FLAG}"`);
      assert.include(result, `"callCwd":"${folder}"`);
      assert.include(result, '"notJson":null');
      assert.notInclude(result, '"isError":true');
    })
  );

  live.effect("a tool that asks the user is told no", () =>
    Effect.gen(function* () {
      const [result = ""] = yield* callTool(
        [{ threadId: thread(2), cwd: fixture.folder("confirm") }],
        "fixture_confirm",
        {}
      );

      assert.include(result, "the user said no");
      assert.notInclude(result, '"isError":true');
    })
  );

  live.effect("unsupported calls fail the tool with the API named", () =>
    Effect.gen(function* () {
      const [sent = ""] = yield* callTool(
        [{ threadId: thread(3), cwd: fixture.folder("send") }],
        "fixture_send",
        {}
      );

      const [renamed = ""] = yield* callTool(
        [{ threadId: thread(4), cwd: fixture.folder("rename") }],
        "fixture_rename",
        {}
      );

      assert.include(sent, '"isError":true');
      assert.include(sent, "does not support sendMessage");
      assert.notInclude(sent, '"text":"sent"');
      assert.include(renamed, '"isError":true');
      assert.include(renamed, "does not support setSessionName");
    })
  );
});
