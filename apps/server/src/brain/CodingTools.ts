// The `coding-tools` extension (plan D18): pi-durable's four coding tools plus `grep`, `find` and
// `ls`, the search tools the user's pi TUI offers, so a model never shells out through `bash` to
// search. Replay policy is the point of this module:
//
// - `read`, `grep`, `find` and `ls` only read, so a rerun after a crash is harmless: `safe`.
// - `write`, `edit` and `bash` change the world. They are `safe` wrappers gated by the thread's
//   permission mode (ADR 0031, Permissions.ts): where the mode asks, the call records an approval
//   and waits for it (a crash during the wait waits again), then commits an effect mark before its
//   effect, so a crash after the mark comes back "may have run" to the model instead of running
//   twice. This replaced phase 1's `unsafe` policy (D18), because a hook cannot hold a wait.
//
// `bash` gets the brain's environment without `CAIRN_*`: pi-durable's default execution inherits
// `process.env` whole, so `prepare` turns inheritance off and passes the filtered copy instead.
// A `bash` call without a timeout stops after 120 seconds, and a model may ask for at most 600
// (T16), so a hung command cannot hold its thread's turn forever.
// The search tools run `rg` and `fd` as argv arrays, with no shell between the model and the process.

import type { Context as ChordContext } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type {
  ToolExecutionApi,
  ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { Array as Arr, Context, Effect, Layer } from "effect";

import { threadProcessEnv } from "./Arms.ts";
import { ExtensionOrder } from "./Extensions.ts";
import type { CairnExtension } from "./Extensions.ts";
import { gatedTool } from "./Permissions.ts";

/** The name of the extension, as pi-durable selects it. */
export const CODING_TOOLS = "coding-tools";

/** Runs one search command in the call's env, streaming its output to the model's result. */
const runSearch = async (
  api: ToolExecutionApi,
  argv: ReadonlyArray<string>,
  context: ChordContext,
  empty: string
): Promise<ToolExecutionResult> => {
  const { env } = api;

  if (env === undefined) {
    throw new Error(
      `${argv[0] ?? "search"} has no working directory for this thread; it cannot run.`
    );
  }

  const options = {
    env: threadProcessEnv(process.env),
    inheritEnv: false,
    onOutput: (text: string) => {
      api.output(text);
    },
  };

  const result = await env.exec(argv, options, context);

  if (!result.ok) {
    throw new Error(
      `${argv[0] ?? "search"} could not start: ${result.error.message}`
    );
  }

  // rg and fd exit 1 when nothing matched; that is an answer, not an error.
  if (result.value.exitCode === 1 && api.retainedOutput().text === "") {
    return { output: [{ type: "text", text: empty }] };
  }

  if (result.value.exitCode !== 0) {
    return { isError: true };
  }

  return api.retainedOutput().text === ""
    ? { output: [{ type: "text", text: empty }] }
    : {};
};

const optionalPath = Type.Optional(
  Type.String({
    description:
      "File or directory to search, relative to the working directory. Default: the working directory.",
  })
);

const grep = defineTool({
  name: "grep",
  description:
    "Search file contents with ripgrep. Returns matching lines as path:line:text. Respects .gitignore.",
  parameters: Type.Object({
    pattern: Type.String({ description: "A Rust regular expression." }),
    path: optionalPath,
    glob: Type.Optional(
      Type.String({
        description: "Only search files matching this glob, such as *.ts.",
      })
    ),
    ignoreCase: Type.Optional(Type.Boolean()),
  }),
  replay: "safe",
  execute: async (args, api, context) => {
    const caseFlags = args.ignoreCase === true ? ["--ignore-case"] : [];

    return await runSearch(
      api,
      [
        "rg",
        "--line-number",
        "--no-heading",
        "--color=never",
        ...caseFlags,
        ...Arr.fromNullishOr(args.glob).flatMap((glob) => ["--glob", glob]),
        "--",
        args.pattern,
        args.path ?? ".",
      ],
      context,
      "No matches."
    );
  },
});

const find = defineTool({
  name: "find",
  description:
    "Find files and directories by name with fd. Returns one path per line. Respects .gitignore.",
  parameters: Type.Object({
    pattern: Type.Optional(
      Type.String({
        description:
          "A regular expression matched against names. Default: every entry.",
      })
    ),
    path: optionalPath,
    type: Type.Optional(
      Type.Union([Type.Literal("file"), Type.Literal("directory")])
    ),
  }),
  replay: "safe",
  execute: async (args, api, context) =>
    await runSearch(
      api,
      [
        "fd",
        "--color=never",
        ...Arr.fromNullishOr(args.type).flatMap((type) => [
          "--type",
          type === "file" ? "f" : "d",
        ]),
        "--",
        args.pattern ?? ".",
        args.path ?? ".",
      ],
      context,
      "Nothing found."
    ),
});

const ls = defineTool({
  name: "ls",
  description:
    "List a directory, hidden entries included, with sizes and kinds.",
  parameters: Type.Object({ path: optionalPath }),
  replay: "safe",
  execute: async (args, api, context) =>
    await runSearch(
      api,
      ["ls", "-lA", "--", args.path ?? "."],
      context,
      "The directory is empty."
    ),
});

/** A `bash` command's limit when the model names none, in seconds (T16). */
export const BASH_DEFAULT_TIMEOUT_SECONDS = 120;

/** The longest limit a model may ask `bash` for, in seconds. */
export const BASH_MAX_TIMEOUT_SECONDS = 600;

/** The limit a `bash` call runs under: the model's, at most the maximum, else the default. */
export const bashTimeoutSeconds = (asked?: number): number =>
  asked === undefined
    ? BASH_DEFAULT_TIMEOUT_SECONDS
    : Math.min(asked, BASH_MAX_TIMEOUT_SECONDS);

const BASH_TIMEOUT_NOTE = `Without a timeout a command stops after ${BASH_DEFAULT_TIMEOUT_SECONDS} seconds; pass up to ${BASH_MAX_TIMEOUT_SECONDS} for a longer one.`;

/** pi-durable's `bash` with a default and a maximum timeout, said in its description. */
const boundedBash = (bash: ReturnType<typeof createBashTool>) => ({
  ...bash,
  description: `${bash.description} ${BASH_TIMEOUT_NOTE}`,
  parameters: {
    ...bash.parameters,
    properties: {
      ...bash.parameters.properties,
      timeout: {
        ...bash.parameters.properties.timeout,
        description: `Timeout in seconds. ${BASH_TIMEOUT_NOTE}`,
      },
    },
  },
  execute: async (...[args, ...rest]: Parameters<typeof bash.execute>) =>
    await bash.execute(
      { ...args, timeout: bashTimeoutSeconds(args.timeout) },
      ...rest
    ),
});

/** `bash` as the brain runs it: bounded, with a Cairn-free environment, gated by the mode. */
export const gatedBash = () =>
  gatedTool(
    boundedBash(
      createBashTool({
        prepare: (execution) => {
          execution.env = {
            ...threadProcessEnv(process.env),
            ...execution.env,
          };
          execution.inheritEnv = false;
        },
      })
    ),
    "command",
    (args) => `bash: ${args.command}`
  );

/** The coding tools, with `read` replay-safe and the writers gated by the thread's mode. */
const codingTools = (images: ImageProcessor) => {
  const read = createReadTool({ images });

  return defineExtension({
    name: CODING_TOOLS,
    tools: [
      { ...read, replay: "safe" as const },
      gatedTool(createWriteTool(), "edit", (args) => `write ${args.path}`),
      gatedTool(
        createEditTool(),
        "edit",
        (args) =>
          `edit ${args.path} (${args.edits.length} ${args.edits.length === 1 ? "change" : "changes"})`
      ),
      gatedBash(),
      grep,
      find,
      ls,
    ],
  });
};

/** The coding tools extension, with the Photon image processor `read` uses for pictures. */
export class CodingTools extends Context.Service<
  CodingTools,
  { readonly extension: CairnExtension }
>()("cairn/server/brain/CodingTools") {
  static readonly layer = Layer.effect(
    CodingTools,
    Effect.gen(function* () {
      const images = yield* Effect.promise(
        async () => await createNodePhotonImages()
      );

      return CodingTools.of({
        extension: {
          order: ExtensionOrder.codingTools,
          extension: codingTools(images),
        },
      });
    })
  );
}
