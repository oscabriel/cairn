// Code mode (ADR 0012, plan D19): one QuickJS sandbox for every thread, and pi-durable's `codemode`
// extension over it. Scripts call the thread's tools as `tools.x()`, each a nested durable tool task,
// so a script survives a restart. The sandbox has no deadline: an approval wait inside a script
// counts against any deadline, and a deadline a script sets for itself (`// @options:
// {"timeout_ms": N}`) is stored with it and makes its rerun after a crash fail, so a `beforeTool`
// hook refuses scripts that carry one. `models: false` keeps model calls out of scripts, which would
// spend on providers outside the thread's model choice. The section's declarations get half of
// pi's 3,000 token default; scripts find the rest with `searchTools()`.
//
// Ported from cairn-v1, apps/server/src/Registry.ts at 1a5cd4a (the `codemode` block), with the
// deadline moved from 30 minutes to none and the timeout guard added from spike 3's finding.
import {
  CodemodeSandbox,
  parseCodemodeSource,
} from "@earendil-works/pi-codemode";
import type { ToolHookCall } from "@earendil-works/pi-durable";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import {
  CODEMODE_TOOL_NAME,
  createCodemodeExtension,
} from "@earendil-works/pi-durable/codemode";
import { Context, Effect, Layer, Predicate } from "effect";

import { ExtensionOrder } from "./Extensions.ts";
import type { CairnExtension } from "./Extensions.ts";

/** Memory one script's VM may use. */
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

/** Worker threads running scripts at once, across every thread. */
const MAX_WORKERS = 4;

/** Tokens the `codemode` section's tool declarations may use (pi's default is 3,000). */
const INLINE_BUDGET = 1500;

/** What the model is told when a script asks for its own deadline. */
export const TIMEOUT_REFUSAL =
  "Scripts here run without a deadline, and a script that sets `timeout_ms` cannot resume after a restart. Remove the `// @options` timeout and run it again.";

/** True when a code mode call's source sets its own deadline. Unparseable sources are left to code mode. */
export const setsOwnDeadline = (call: ToolHookCall): boolean => {
  if (call.name !== CODEMODE_TOOL_NAME) {
    return false;
  }

  const { code } = call.arguments;

  if (!Predicate.isString(code)) {
    return false;
  }

  try {
    return parseCodemodeSource(code).options.timeoutMs !== undefined;
  } catch {
    return false;
  }
};

/** Refuses code mode scripts that set `timeout_ms`. */
const deadlineGuard = hook(ToolTask, {
  beforeTool: (call) =>
    setsOwnDeadline(call) ? { block: TIMEOUT_REFUSAL } : undefined,
});

/** The code mode extension and the sandbox behind it. */
export class CodeMode extends Context.Service<
  CodeMode,
  { readonly extension: CairnExtension }
>()("cairn/server/brain/CodeMode") {
  static readonly layer = Layer.effect(
    CodeMode,
    Effect.gen(function* () {
      let running = 0;

      const sandbox = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new CodemodeSandbox({
              memoryLimitBytes: MEMORY_LIMIT_BYTES,
              timeoutMs: Number.POSITIVE_INFINITY,
              acquireWorker: () => {
                if (running >= MAX_WORKERS) {
                  throw new Error(
                    `Code mode is running ${MAX_WORKERS} scripts already. Wait for one to finish, then run this again.`
                  );
                }

                running += 1;

                return () => {
                  running -= 1;
                };
              },
            })
        ),
        (opened) =>
          Effect.promise(async () => {
            await opened.close();
          })
      );

      const codemode = createCodemodeExtension({
        sandbox,
        models: false,
        inlineBudget: INLINE_BUDGET,
        namespaces: [
          {
            name: "executor",
            prefix: "executor_",
            description:
              "The user's connected apps and services through Executor: search them, read their docs, call them.",
          },
        ],
      });

      return CodeMode.of({
        extension: {
          order: ExtensionOrder.codemode,
          extension: defineExtension({
            ...codemode,
            hooks: [...(codemode.hooks ?? []), deadlineGuard],
          }),
        },
      });
    })
  );
}
