// What pi-durable calls back runs on the app's context (coding standard S43): a line logged inside a
// production tool handler reaches the app's events log, the JSON file `Observability.ts` appends to
// when `CAIRN_EVENTS_LOG` is set, with the thread's conversation as its annotation. The probe is
// `ask_user`, built as the installed set builds it (`askUserSource`), whose approval ledger writes
// `approval_asked` inside the tool's `execute`; run on Effect's default runtime, that line printed
// in Effect's pretty format and never reached the file. Every pi-durable call also opens a span
// named by its operation (`durable`). Kept under `brain/`, where pi-durable may be imported by
// tests (S42).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  Tracer,
} from "effect";

import { askUserSource } from "../approvals/AskUserTool.ts";
import { eventually, testLimit } from "../EventuallyTestKit.ts";
import { observabilityLayer } from "../Observability.ts";
import { durable } from "./Durable.ts";
import { Extensions } from "./Extensions.ts";

const context = BACKGROUND_CONTEXT;

const PROVIDER = "faux";

const MODEL = { provider: PROVIDER, modelId: "small" };

/** The annotations of one events log line, or none for a line that is not one. */
const decodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ annotations: Schema.Record(Schema.String, Schema.Json) })
  )
);

/** The annotations of every line in `file` whose `event` is `event`. */
const linesOf = (file: string, event: string) =>
  readFileSync(file, { encoding: "utf-8", flag: "a+" })
    .split("\n")
    .flatMap((line) => Option.toArray(decodeLine(line)))
    .flatMap((decoded) =>
      decoded.annotations.event === event ? [decoded.annotations] : []
    );

/** The `event` lines of `file`, once there is one (`eventually`'s deadline, scaled by the slack). */
const awaitLines = (file: string, event: string) =>
  eventually(
    Effect.sync(() => linesOf(file, event)),
    (found) => found.length > 0,
    `a ${event} line in the events log`
  );

/** The installed `ask_user` over the app's logging, which appends to `events`. */
const askUserIn = (events: string) =>
  Extensions.fromSources([askUserSource]).pipe(
    Layer.provide(observabilityLayer("json")),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({ CAIRN_EVENTS_LOG: events })
      )
    )
  );

/** Opens a Harness with `built`'s extensions over a faux model that calls `ask_user` once. */
const openAsking = (built: Context.Context<Extensions>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const registry = createRegistry();

      for (const extension of Context.get(built, Extensions).installed) {
        registry.install(extension);
      }

      const faux = fauxProvider({
        provider: PROVIDER,
        models: [{ id: "small" }],
      });

      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("ask_user", {
            questions: [{ header: "Name", question: "What is it called?" }],
          }),
          { stopReason: "toolUse" }
        ),
      ]);

      const models = createModels();

      models.setProvider(faux.provider);

      return await Harness.open(
        new MemoryStorage(),
        { models, registry },
        context
      );
    }),
    (open) =>
      Effect.promise(async () => {
        await open.close(context);
      })
  );

describe("the runner pi-durable callbacks run on", () => {
  it.live(
    "carries a line logged inside a tool handler to the app's events log, with the thread's conversation",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-runner-"))),
        (dir) =>
          Effect.gen(function* () {
            const events = path.join(dir, "events.jsonl");

            const harness = yield* openAsking(
              yield* Layer.build(askUserIn(events))
            );

            const conversation = yield* Effect.promise(async () => {
              const created = await harness.createConversation(
                { ownership: { kind: "ownerless" }, agent: { model: MODEL } },
                context
              );

              await created.submit(
                { type: "input", content: "Ask me.", requestId: "r-1" },
                context
              );

              return created;
            });

            // The tool waits for the user's answer; the line is written with its record.
            const asked = yield* awaitLines(events, "approval_asked");

            assert.lengthOf(
              asked,
              1,
              "ask_user's approval_asked line never reached the events log"
            );
            assert.strictEqual(asked[0]?.conversationId, conversation.id);
            assert.strictEqual(asked[0]?.tool, "ask_user");
          }).pipe(Effect.scoped),
        (dir) =>
          Effect.sync(() => {
            rmSync(dir, { recursive: true, force: true });
          })
      ),
    testLimit(30_000)
  );

  it.effect("opens a span named by each pi-durable call's operation", () =>
    Effect.gen(function* () {
      const names: Array<string> = [];

      const recording = Tracer.make({
        span: (options) => {
          names.push(options.name);

          return new Tracer.NativeSpan(options);
        },
      });

      yield* durable("probe.read", async () => {
        await Promise.resolve();
      }).pipe(Effect.provideService(Tracer.Tracer, recording));

      yield* durable("probe.write", async () => {
        await Promise.reject(new Error("refused"));
      }).pipe(Effect.ignore, Effect.provideService(Tracer.Tracer, recording));

      assert.deepStrictEqual(names, [
        "durable.probe.read",
        "durable.probe.write",
      ]);
    })
  );
});
