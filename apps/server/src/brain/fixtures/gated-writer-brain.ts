// A brain of one conversation for `GatedWriter.test.ts`, the briefs note's probe 2 kept as a test:
// pi-durable over a SQLite file, a faux model that calls `bash` once with `CAIRN_FIXTURE_COMMAND`,
// and the production gated `bash` (`gatedBash`, ADR 0031) in the mode the run names. The command
// may `kill -9` this process (its pid is in `<dir>/brain.pid`), and the test may kill it while the
// call waits for its approval; `resume` opens the same file and finishes the turn.
//
//   node gated-writer-brain.ts <dir> run <mode> [control]
//   node gated-writer-brain.ts <dir> resume [accept] [control]
//
// `accept` answers the call's pending approval (as the user) once it shows. `control` installs a
// broken `bash` instead: replay-safe, gated the same way, but with no effect mark, so a rerun runs
// the command again; the test requires it to fail where the real one passes.
//
// Prints JSON lines: `{"event":"pending"}` when the approval shows, then
// `{"event":"done","results":[...]}` with every tool result's text once the conversation is idle.

import { writeFileSync } from "node:fs";
import path from "node:path";

import { RuntimeMode } from "@cairn/protocol/Policy";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  Harness,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { Clock, Effect, Option, Predicate, Schema } from "effect";

import {
  answerApproval,
  approvalLedger,
  Approvals,
  writeMode,
} from "../CairnDocs.ts";
import { gatedBash } from "../CodingTools.ts";
import {
  callAsks,
  GATED_APPROVAL_TTL_MILLIS,
  readPermissions,
} from "../Permissions.ts";

const [dirArg = ".", command = "run", ...rest] = process.argv.slice(2);

const dir = path.resolve(dirArg);

const control = rest.includes("control");

const accept = rest.includes("accept");

const mode = Schema.decodeUnknownSync(RuntimeMode)(
  command === "run" ? rest[0] : "full-access"
);

const context = BACKGROUND_CONTEXT;

/** One line the fixture prints. */
type FixtureLine =
  | { readonly event: "pending" }
  | { readonly event: "done"; readonly results: ReadonlyArray<string> };

const print = (line: FixtureLine) => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

writeFileSync(path.join(dir, "brain.pid"), String(process.pid));

/** The broken control: gated like the real one, but with no effect mark before the effect. */
const unmarkedBash = (): ReturnType<typeof createBashTool> => {
  const bash = createBashTool();

  return {
    ...bash,
    replay: "safe",
    execute: async (args, api, toolContext) => {
      const permissions = await readPermissions(api, toolContext);

      if (callAsks(permissions, "bash", "command")) {
        const ledger = approvalLedger(api);

        const settlement = await Effect.runPromise(
          Effect.gen(function* () {
            yield* ledger.ask({
              tool: "bash",
              kind: "tool-call",
              summary: "bash",
              ttlMillis: GATED_APPROVAL_TTL_MILLIS,
              payload: Option.none(),
              acceptedBy: Option.none(),
            });

            return yield* ledger.awaitSettlement;
          }),
          { signal: toolContext.abortSignal }
        );

        if (settlement.status !== "accepted") {
          return { isError: true };
        }
      }

      return await bash.execute(args, api, toolContext);
    },
  };
};

const models = createModels();

const faux = fauxProvider({ tokensPerSecond: 0 });

models.setProvider(faux.provider);

faux.setResponses(
  Array.from({ length: 20 }, () => (request) => {
    const last = request.messages.findLast(
      (message) => message.role !== "system"
    );

    return last?.role === "toolResult"
      ? fauxAssistantMessage([fauxText("done")])
      : fauxAssistantMessage(
          [
            fauxToolCall("bash", {
              command: process.env.CAIRN_FIXTURE_COMMAND ?? "true",
            }),
          ],
          { stopReason: "toolUse" }
        );
  })
);

const registry = createRegistry();

registry.install(
  defineExtension({
    name: "gated-writer",
    tools: [control ? unmarkedBash() : gatedBash()],
  })
);

const harness = await Harness.open(
  await openNodeSqliteStorage(path.join(dir, "store.sqlite")),
  {
    models,
    registry,
    env: (target) =>
      target.cwd === undefined
        ? undefined
        : new NodeExecutionEnv({ cwd: target.cwd }),
  },
  context
);

const [model] = faux.models;

const root = await harness.root(context, {
  agent: {
    model: { provider: model?.provider ?? "faux", modelId: model?.id ?? "" },
    cwd: dir,
  },
});

/** The first pending approval's id, once one shows. */
const pendingApproval = async () => {
  for (;;) {
    // Polls the store, as a client's view would show the card.
    // oxlint-disable-next-line no-await-in-loop
    const approvals = await harness.snapshot(Approvals, root.id, context);

    const pending = Object.values(approvals?.items ?? {}).find(
      (record) => record.status === "pending"
    );

    if (pending !== undefined) {
      return pending.id;
    }

    // oxlint-disable-next-line no-await-in-loop
    await Effect.runPromise(Effect.sleep("20 millis"));
  }
};

if (command === "run") {
  await harness.commit(async (tx) => {
    await writeMode(tx, root.id, mode);
  }, context);
  await root.submit({ type: "input", content: "go" }, context);

  if (callAsks({ mode, allow: [] }, "bash", "command")) {
    await pendingApproval();
    print({ event: "pending" });
  }
} else {
  harness.resume();

  if (accept) {
    const approvalId = await pendingApproval();

    await Effect.runPromise(
      answerApproval(
        harness,
        root.id,
        approvalId,
        {
          decision: "accept",
          by: { kind: "user" },
          reason: Option.none(),
          answers: Option.none(),
          launch: Option.none(),
        },
        await Effect.runPromise(Clock.currentTimeMillis)
      )
    );
  }
}

await root.waitForIdle(context);

const entries = await harness.commit(
  async (tx) => await tx.scanEntries({ conversationId: root.id }, 50),
  context
);

const results = entries.items
  .filter((entry) => entry.kind === "pi.tool-result")
  .flatMap((entry) => entry.model ?? [])
  .flatMap((message) =>
    "content" in message && Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          Predicate.hasProperty(part, "text") && Predicate.isString(part.text)
            ? [part.text]
            : []
        )
      : []
  );

print({ event: "done", results });

await harness.close(context);
