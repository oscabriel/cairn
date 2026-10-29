// Judge-only tools, installed through the Cairn extension seam by `judge-main.ts` (plan D50). They
// give the durability and shutdown judges effects they can count from outside the store:
//
// - `mark {label}`: appends one line to the effects log, at most once per call. The `started`
//   memo is committed before the effect, so a rerun after a crash reports "may have run" instead of
//   writing again (the pattern of spikes/3-workflows/brain.ts in this repo).
// - `slow {ms}`: waits, honouring its abort signal; replay-safe, so a rerun waits again.
// - `gate {summary}`: asks for an approval in `cairn.approvals` and waits for the answer
//   (spikes/4-approvals/brain.ts); replay-safe, so a restart finds the record and waits again.
// - `stubborn {ms}`: waits and ignores its abort signal, so a judge can watch close time out.
//
// The effects log is `CAIRN_JUDGE_EFFECTS_LOG`, else `effects.log` in the thread's directory.

import { appendFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Option, Predicate } from "effect";

import { approvalLedger } from "../../apps/server/src/brain/CairnDocs.ts";
import { ExtensionOrder } from "../../apps/server/src/brain/Extensions.ts";
import type { CairnExtension } from "../../apps/server/src/brain/Extensions.ts";

/** A day: judge approvals never expire on their own. */
const APPROVAL_TTL_MILLIS = 86_400_000;

const text = (value: string) => [{ type: "text" as const, text: value }];

const effectsLog = (cwd: string | undefined) => {
  const configured = process.env.CAIRN_JUDGE_EFFECTS_LOG;

  return Predicate.isString(configured) && configured !== ""
    ? configured
    : path.join(cwd ?? ".", "effects.log");
};

const mark = defineTool({
  name: "mark",
  description: "Records one effect, outside the store, at most once.",
  parameters: Type.Object({ label: Type.String() }),
  replay: "safe",
  execute: async ({ label }, api, context) => {
    if ((await api.memo<boolean>("cairn.judge.started", context)) === true) {
      return {
        output: text(
          "Interrupted after it started, so it may have run. Not retried."
        ),
        isError: true,
      };
    }

    await api.memo("cairn.judge.started", true, context);

    const agent = await api.agent(context);

    await appendFile(
      effectsLog(agent.cwd),
      `${JSON.stringify({ label, taskId: api.taskId, at: api.now() })}\n`
    );

    return { output: text(`marked ${label}`) };
  },
});

const slow = defineTool({
  name: "slow",
  description: "Waits for the given milliseconds; stops when aborted.",
  parameters: Type.Object({ ms: Type.Number() }),
  replay: "safe",
  execute: async ({ ms }, _api, context) => {
    await wait(ms, undefined, { signal: context.abortSignal });

    return { output: text(`slept ${ms} ms`) };
  },
});

const gate = defineTool({
  name: "gate",
  description: "Waits for the user's approval and reports the decision.",
  parameters: Type.Object({ summary: Type.Optional(Type.String()) }),
  replay: "safe",
  execute: async ({ summary }, api, context) => {
    const ledger = approvalLedger(api);

    const status = await Effect.runPromise(
      Effect.gen(function* () {
        yield* ledger.ask({
          tool: "gate",
          kind: "tool-call",
          summary: summary ?? "Open the gate",
          ttlMillis: APPROVAL_TTL_MILLIS,
          payload: Option.none(),
          acceptedBy: Option.none(),
        });

        return yield* ledger.awaitAnswer;
      }),
      { signal: context.abortSignal }
    );

    return { output: text(status), isError: status !== "accepted" };
  },
});

const stubborn = defineTool({
  name: "stubborn",
  description: "Waits for the given milliseconds and ignores aborts.",
  parameters: Type.Object({ ms: Type.Number() }),
  execute: async ({ ms }) => {
    await wait(ms);

    return { output: text(`ignored aborts for ${ms} ms`) };
  },
});

/** The judge tools, for `ExtensionSet.withExtra` in `judge-main.ts`. */
export const JudgeTools: CairnExtension = {
  order: ExtensionOrder.judge,
  extension: defineExtension({
    name: "judge-tools",
    tools: [mark, slow, gate, stubborn],
  }),
};
