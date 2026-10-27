// `pnpm check`: the outer gate, quiet on success. Runs format, lint, typecheck and test in order,
// buffers each step's output, and stops at the first failure.
//
//   node tools/check.ts            one line when every step passes; the failing step's whole output
//                                  and a non-zero exit when one does not
//   VERBOSE=1 node tools/check.ts  streams every step's output as the steps run
//
// A passing run costs an agent one line of context instead of a few hundred; a failing run still
// shows everything the step printed, in the order it printed it. The shape follows HumanLayer's
// scripts/run-silent.ts (humanlayer/humanlayer at f16f286), rewritten for Node.

import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = path.join(import.meta.dirname, "..");

const bin = path.join(root, "node_modules", ".bin");

const verbose = process.env.VERBOSE === "1";

interface Step {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

// oxfmt and oxlint resolve from node_modules/.bin, as they do in the package scripts.
const steps: ReadonlyArray<Step> = [
  { name: "fmt", command: "oxfmt", args: ["--check"] },
  { name: "lint", command: "oxlint", args: [] },
  { name: "typecheck", command: "pnpm", args: ["typecheck"] },
  { name: "test", command: "pnpm", args: ["test"] },
];

interface StepResult {
  readonly code: number;
  /** Stdout and stderr interleaved as they arrived; empty when the output was streamed. */
  readonly output: string;
}

const runStep = async (step: Step): Promise<StepResult> => {
  const child = spawn(step.command, step.args, {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    },
    stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  const chunks: Array<Buffer> = [];

  const collect = (chunk: Buffer) => {
    chunks.push(chunk);
  };

  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  try {
    await once(child, "close");

    return {
      code: child.exitCode ?? 1,
      output: Buffer.concat(chunks).toString(),
    };
  } catch (error) {
    // `once` rejects when the process could not start (a missing binary).
    return {
      code: 1,
      output: `${step.command}: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
};

/** Vitest's summary line, "Tests  1292 passed (1292)", as a count; absent when it is not there. */
const testCount = (output: string): string | undefined => {
  const match = /^\s*Tests\s.*?(?<passed>\d+) passed/mu.exec(
    stripVTControlCharacters(output)
  );

  return match?.groups?.passed === undefined
    ? undefined
    : Number(match.groups.passed).toLocaleString("en-US");
};

const seconds = (since: number) =>
  Math.round((performance.now() - since) / 1000);

const started = performance.now();

/** Runs `steps` from `index` on, stopping at the first failure; resolves with what each ran as. */
const runFrom = async (
  index: number,
  ran: ReadonlyArray<string>
): Promise<ReadonlyArray<string>> => {
  const step = steps[index];

  if (step === undefined) {
    return ran;
  }

  const result = await runStep(step);

  if (result.code !== 0) {
    process.stderr.write(result.output);
    process.stderr.write(
      `check: ${step.name} failed with exit ${result.code} after ${seconds(started)} s\n`
    );
    process.exit(result.code);
  }

  const count = step.name === "test" ? testCount(result.output) : undefined;

  return await runFrom(index + 1, [
    ...ran,
    count === undefined ? step.name : `${count} tests`,
  ]);
};

const ran = await runFrom(0, []);

console.log(`check: ok in ${seconds(started)} s (${ran.join(", ")})`);
