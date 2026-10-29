// A pi extension for `judges/pi-host.ts`, loaded through the tools-only host and pi's own loader.
// Its two tools do the same thing: append one line to `<counter-dir>/<tool>.runs` (so every run of
// a call is counted, across brain lives), then wait while `<counter-dir>/hold` exists, then answer
// how many runs the file holds. The judge holds both calls, `kill -9`s the brain mid-call, removes
// the hold and reopens. The host's replay table, never this file, makes `counter_safe` safe and
// `counter_unsafe` unsafe.
//
// The pi API is typed structurally here, so the package loads anywhere without pi's types.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** The part of pi's `ExtensionAPI` this fixture uses. */
interface CounterApi {
  registerFlag(
    name: string,
    options: { readonly description: string; readonly type: "string" }
  ): void;
  getFlag(name: string): boolean | string | undefined;
  registerTool(tool: {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly parameters: object;
    execute(): Promise<{
      readonly content: ReadonlyArray<{
        readonly type: "text";
        readonly text: string;
      }>;
      readonly details: unknown;
    }>;
  }): void;
}

/** Lines in `file`, or 0 when it does not exist. */
const linesIn = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf-8")
        .split("\n")
        .filter((line) => line !== "").length
    : 0;

/** The fixture's factory, as pi's loader calls it. */
const counter = (pi: CounterApi) => {
  pi.registerFlag("counter-dir", {
    description:
      "Where the counter keeps its run files and looks for its hold.",
    type: "string",
  });

  const run = async (tool: string) => {
    const dir = String(pi.getFlag("counter-dir") ?? "");
    const runs = path.join(dir, `${tool}.runs`);

    appendFileSync(runs, `${String(process.pid)}\n`);

    while (existsSync(path.join(dir, "hold"))) {
      // oxlint-disable-next-line no-await-in-loop
      await sleep(20);
    }

    const count = linesIn(runs);

    return {
      content: [
        { type: "text" as const, text: `${tool} ran ${String(count)} times` },
      ],
      details: { count },
    };
  };

  for (const tool of ["counter_safe", "counter_unsafe"]) {
    pi.registerTool({
      name: tool,
      label: tool,
      description:
        "Counts its runs in a file, then waits while the judge holds it.",
      parameters: { type: "object", properties: {} },
      execute: async () => await run(tool),
    });
  }
};

export default counter;
