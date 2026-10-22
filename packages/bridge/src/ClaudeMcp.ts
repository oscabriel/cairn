// Ported from elidickinson/pi-claude-bridge, src/mcp-server.ts at
// 874fa7c2678456336f23b64e784e2057e608d83e, by way of cairn-v1 apps/server/src/claude/mcp-server.ts at
// 1a5cd4a56e84bfb187940428d144b584d2e084b0. Behaviour kept: pi's JSON Schema is served verbatim, a
// root anyOf/oneOf/allOf is flattened the way Claude Code's own normalizer does, and a call pairs
// with its tool_use by `_meta["claudecode/toolUseId"]`. Changed: the pure parts live here and the MCP
// server itself in `ClaudeSdk.ts` (the only importer of the MCP SDK); every listed tool carries
// `_meta["anthropic/alwaysLoad"]`; the schema walk is typed over JSON values.
//
// MIT License
//
// Copyright (c) 2026 Eli Dickinson
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
import type { Tool } from "@earendil-works/pi-ai";
import { Option, Predicate, Schema } from "effect";

/** The in-process MCP server's name; Claude Code calls its tools `mcp__custom-tools__<name>`. */
export const MCP_SERVER_NAME = "custom-tools";

/** The prefix Claude Code puts before a served tool's name. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * Claude Code stamps every `tools/call` with the id of the `tool_use` block it came from. Call order
 * does not follow block order, so this id is the only reliable pairing.
 */
export const TOOL_USE_ID_META = "claudecode/toolUseId";

/** Keeps every served tool out of Claude Code's tool search, so the turn-1 prompt lists it. */
export const ALWAYS_LOAD_META = "anthropic/alwaysLoad";

/** A pi tool as the bridge serves it: its name, description and JSON Schema object. */
export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema.JsonObject;
}

/** One entry of the server's `tools/list` answer. */
export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema.JsonObject;
  readonly _meta: { readonly [ALWAYS_LOAD_META]: true };
}

const decodeJson = Schema.decodeUnknownOption(Schema.Json);

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray =>
  Array.isArray(value);

const asObject = (
  value: Schema.Json | undefined
): Option.Option<Schema.JsonObject> =>
  value !== undefined && isJsonObject(value)
    ? Option.some(value)
    : Option.none();

/**
 * The declaration of a pi tool, or none when its parameters are not a JSON Schema object (MCP needs
 * one; such a tool is a bug in the tool and is left unserved rather than called without arguments).
 */
export const toolDeclaration = (tool: Tool): Option.Option<ToolDeclaration> =>
  decodeJson(tool.parameters).pipe(
    Option.flatMap((schema) => asObject(schema)),
    Option.filter((schema) => schema.type === "object"),
    Option.map((inputSchema) => ({
      name: tool.name,
      description: tool.description,
      inputSchema,
    }))
  );

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;

type Combinator = (typeof ROOT_COMBINATORS)[number];

const localRefPattern = /^#\/(?<defs>\$defs|definitions)\/(?<name>[^/]+)$/u;

const resolveLocalRef = (
  branch: Schema.Json,
  root: Schema.JsonObject
): Schema.Json => {
  if (!isJsonObject(branch) || !Predicate.isString(branch.$ref)) {
    return branch;
  }

  const match = localRefPattern.exec(branch.$ref);
  const defsKey = match?.groups?.defs;
  const name = match?.groups?.name;

  if (defsKey === undefined || name === undefined) {
    return branch;
  }

  const target = asObject(root[defsKey]).pipe(
    Option.flatMap((defs) => asObject(defs[name]))
  );

  return Option.getOrElse(target, () => branch);
};

const stringsOf = (value: Schema.Json | undefined): ReadonlyArray<string> =>
  value !== undefined && isJsonArray(value)
    ? value.filter(Predicate.isString)
    : [];

/** A branch is named by its required keys, else by all of its keys. */
const branchGroup = (branch: Schema.Json): Option.Option<string> => {
  if (!isJsonObject(branch)) {
    return Option.none();
  }

  const required = stringsOf(branch.required);

  if (required.length > 0) {
    return Option.some(required.join(", "));
  }

  const keys = Option.match(asObject(branch.properties), {
    onNone: () => [],
    onSome: (properties) => Object.keys(properties),
  });

  return keys.length > 0 ? Option.some(keys.join(", ")) : Option.none();
};

/** Claude Code's wording, so a flattened tool reads the same as one Claude Code normalized itself. */
const combinatorNote = (
  combinators: ReadonlyArray<Combinator>,
  branchesOf: (key: Combinator) => ReadonlyArray<Schema.Json>
): string => {
  if (!combinators.includes("anyOf") && !combinators.includes("oneOf")) {
    return "Input constraint: all listed parameters apply together (flattened from a JSON Schema allOf).";
  }

  const key: Combinator = combinators.includes("oneOf") ? "oneOf" : "anyOf";

  const rule =
    key === "oneOf"
      ? "Provide parameters for exactly one of"
      : "Provide parameters for at least one of";

  const groups = [
    ...new Set(
      branchesOf(key).flatMap((branch) => Option.toArray(branchGroup(branch)))
    ),
  ];

  if (groups.length === 0) {
    return `Input constraint: ${rule} the documented parameter groups (flattened from a JSON Schema ${key}).`;
  }

  return `Input constraint: ${rule}: ${groups.map((group) => `(${group})`).join(" or ")}.`;
};

/** The flattened schema, and the note that restates the lost constraint, when it had a root combinator. */
export interface FlattenedSchema {
  readonly schema: Schema.JsonObject;
  readonly note: Option.Option<string>;
}

/**
 * Claude Code drops a tool whose schema has a root `anyOf`, `oneOf` or `allOf`; a call to it would
 * then run in pi while Claude Code retries under a fresh id. Advertise a flat object instead: root
 * properties win over branch ones, root `required` stays and `allOf` requirements join it, local
 * `$ref`s are followed, and the lost constraint becomes a note for the description.
 */
export const flattenRootCombinators = (
  schema: Schema.JsonObject
): FlattenedSchema => {
  const combinators = ROOT_COMBINATORS.filter((key) => key in schema);

  if (combinators.length === 0) {
    return { schema, note: Option.none() };
  }

  const branchesOf = (key: Combinator): ReadonlyArray<Schema.Json> => {
    const branches = schema[key];

    return branches !== undefined && isJsonArray(branches)
      ? branches.map((branch) => resolveLocalRef(branch, schema))
      : [];
  };

  const properties: Record<string, Schema.Json> = {};
  const required: Array<string> = [];

  const addProperties = (source: Schema.Json) => {
    if (!isJsonObject(source)) {
      return;
    }

    for (const [key, value] of Object.entries(
      Option.getOrElse(asObject(source.properties), () => ({}))
    )) {
      if (!(key in properties)) {
        properties[key] = value;
      }
    }
  };

  const addRequired = (source: Schema.Json) => {
    if (!isJsonObject(source)) {
      return;
    }

    for (const key of stringsOf(source.required)) {
      if (!required.includes(key)) {
        required.push(key);
      }
    }
  };

  addProperties(schema);

  for (const key of combinators) {
    for (const branch of branchesOf(key)) {
      addProperties(branch);
    }
  }

  addRequired(schema);

  for (const branch of branchesOf("allOf")) {
    addRequired(branch);
  }

  const rest = Object.fromEntries(
    Object.entries(schema).filter(
      ([key]) => key !== "required" && !ROOT_COMBINATORS.some((c) => c === key)
    )
  );

  const requiredEntries =
    required.length > 0 ? [["required", required] as const] : [];

  return {
    schema: Object.fromEntries([
      ...Object.entries(rest),
      ["type", "object"] as const,
      ["properties", properties] as const,
      ...requiredEntries,
    ]),
    note: Option.some(combinatorNote(combinators, branchesOf)),
  };
};

/** The `tools/list` answer for `tools`: flattened schemas, notes ahead of descriptions, always loaded. */
export const listTools = (
  tools: ReadonlyArray<ToolDeclaration>
): ReadonlyArray<ListedTool> =>
  tools.map((tool) => {
    const { schema, note } = flattenRootCombinators(tool.inputSchema);

    return {
      name: tool.name,
      description: Option.match(note, {
        onNone: () => tool.description,
        onSome: (text) =>
          tool.description.length > 0 ? `${text}\n\n${tool.description}` : text,
      }),
      inputSchema: schema,
      _meta: { [ALWAYS_LOAD_META]: true },
    };
  });

/** pi's name for a tool Claude Code called by its served name, or none for a name the bridge does not serve. */
export const piToolName = (
  servedName: string,
  tools: ReadonlyArray<ToolDeclaration>
): Option.Option<string> => {
  // A name without the prefix is the model reaching for a builtin it does not have. Claude Code
  // answers that itself and retries under a fresh id, so it must never reach pi.
  if (!servedName.startsWith(MCP_TOOL_PREFIX)) {
    return Option.none();
  }

  const bare = servedName.slice(MCP_TOOL_PREFIX.length);
  const exact = tools.find((tool) => tool.name === bare);

  if (exact !== undefined) {
    return Option.some(exact.name);
  }

  const lower = bare.toLowerCase();

  return Option.fromNullishOr(
    tools.find((tool) => tool.name.toLowerCase() === lower)?.name
  );
};
