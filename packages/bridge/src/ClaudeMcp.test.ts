import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import {
  ALWAYS_LOAD_META,
  flattenRootCombinators,
  listTools,
  piToolName,
  toolDeclaration,
} from "./ClaudeMcp.ts";

const edit = toolDeclaration({
  name: "edit",
  description: "Edit a file.",
  parameters: Type.Object({
    path: Type.String(),
    edits: Type.Array(
      Type.Object({ oldText: Type.String(), newText: Type.String() })
    ),
  }),
});

describe("tool declarations", () => {
  it("serves pi's JSON Schema verbatim, nested objects included", () => {
    expect(Option.map(edit, (tool) => tool.inputSchema)).toStrictEqual(
      Option.some({
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                oldText: { type: "string" },
                newText: { type: "string" },
              },
              required: ["oldText", "newText"],
            },
          },
        },
        required: ["path", "edits"],
      })
    );
  });

  it("leaves a tool whose parameters are not an object schema unserved", () => {
    expect(
      Option.isNone(
        toolDeclaration({
          name: "bad",
          description: "",
          parameters: Type.String(),
        })
      )
    ).toBeTruthy();
  });

  it("marks every listed tool always loaded", () => {
    const listed = listTools(Option.toArray(edit));

    expect(listed.map((tool) => tool._meta[ALWAYS_LOAD_META])).toStrictEqual([
      true,
    ]);
  });
});

describe("root combinators", () => {
  it("flattens a root anyOf the way Claude Code would, and says so in the description", () => {
    const flat = flattenRootCombinators({
      type: "object",
      properties: { mode: { type: "string" } },
      required: ["mode"],
      anyOf: [
        { required: ["path"], properties: { path: { type: "string" } } },
        { $ref: "#/$defs/byId" },
      ],
      $defs: {
        byId: { required: ["id"], properties: { id: { type: "number" } } },
      },
    });

    expect(flat.schema).toStrictEqual({
      type: "object",
      properties: {
        mode: { type: "string" },
        path: { type: "string" },
        id: { type: "number" },
      },
      required: ["mode"],
      $defs: {
        byId: { required: ["id"], properties: { id: { type: "number" } } },
      },
    });
    expect(flat.note).toStrictEqual(
      Option.some(
        "Input constraint: Provide parameters for at least one of: (path) or (id)."
      )
    );
  });

  it("joins allOf requirements and leaves a plain schema alone", () => {
    const plain = { type: "object", properties: {} };

    expect(flattenRootCombinators(plain)).toStrictEqual({
      schema: plain,
      note: Option.none(),
    });
    expect(
      flattenRootCombinators({
        type: "object",
        allOf: [{ required: ["a"], properties: { a: { type: "string" } } }],
      }).schema.required
    ).toStrictEqual(["a"]);
  });
});

describe("served names", () => {
  it("maps only prefixed names back to pi's tools, never a builtin the model invented", () => {
    const tools = Option.toArray(edit);

    expect(piToolName("mcp__custom-tools__edit", tools)).toStrictEqual(
      Option.some("edit")
    );
    expect(piToolName("mcp__custom-tools__Edit", tools)).toStrictEqual(
      Option.some("edit")
    );
    expect(Option.isNone(piToolName("edit", tools))).toBeTruthy();
    expect(Option.isNone(piToolName("Bash", tools))).toBeTruthy();
    expect(
      Option.isNone(piToolName("mcp__custom-tools__bash", tools))
    ).toBeTruthy();
  });
});
