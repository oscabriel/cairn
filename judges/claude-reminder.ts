// J11, live: a section changed between turns reaches a running Claude Code session as one
// `<system-reminder>` naming it, at a small cache write; and after a restart the bridge resumes the
// stamped session natively and sends the next change the same way.
//   node judges/claude-reminder.ts [--model claude-haiku-5-5] [--max-write 4000]
//
// Runs the real bridge (`Claude` over the Agent SDK and the `claude` binary's own login) on a
// scratch directory, three turns: (1) a new session, (2) the same live child after the `skills`
// section changed, (3) a new bridge, as after a restart, after the `cairn` section changed. It
// records what the bridge writes to each child's input and how each child was opened, and prints
// one JSON line with the numbers. Exit 0 when every check holds. Costs a few cents of plan usage.

import { parseArgs } from "node:util";

import { Claude } from "@cairn/bridge/Claude";
import { ClaudeAccount } from "@cairn/bridge/ClaudeAccount";
import type { ChildSession } from "@cairn/bridge/ClaudeGuards";
import { claudeModel, DEFAULT_LONG_CONTEXT } from "@cairn/bridge/ClaudeModels";
import { ClaudeOneShot } from "@cairn/bridge/ClaudeOneShot";
import { blocksText } from "@cairn/bridge/ClaudePrompt";
import { providerContext } from "@cairn/bridge/ClaudeProvider";
import { ClaudeSdk } from "@cairn/bridge/ClaudeSdk";
import { ClaudeSlots } from "@cairn/bridge/ClaudeSlots";
import { stampOf } from "@cairn/bridge/ClaudeStamp";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { NodeRuntime } from "@effect/platform-node";
import { Duration, Effect, Layer, Option, Ref, Schema } from "effect";

import * as Scratch from "./lib/Scratch.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "claude-haiku-5-5" },
    "max-write": { type: "string", default: "4000" },
  },
});

const maxWrite = Number(values["max-write"]);

const sessionId = crypto.randomUUID();

/** A check of the judge did not hold. */
class ClaudeReminderFailed extends Schema.TaggedError<ClaudeReminderFailed>()(
  "ClaudeReminderFailed",
  { message: Schema.String }
) {}

interface Opened {
  readonly session: ChildSession;
  readonly prompts: Array<string>;
}

/** The real Agent SDK, recording how each child opens and what is written to its input. */
const recordingSdk = (log: Ref.Ref<ReadonlyArray<Opened>>) =>
  Layer.effect(
    ClaudeSdk,
    Effect.gen(function* () {
      const real = yield* ClaudeSdk;

      return ClaudeSdk.of({
        ...real,
        open: (options, onToolCall) =>
          Effect.gen(function* () {
            const query = yield* real.open(options, onToolCall);
            const opened: Opened = { session: options.session, prompts: [] };

            yield* Ref.update(log, (all) => [...all, opened]);

            return {
              ...query,
              input: {
                ...query.input,
                push: (message) =>
                  Effect.andThen(
                    Effect.sync(() =>
                      opened.prompts.push(blocksText(message.blocks))
                    ),
                    query.input.push(message)
                  ),
              },
            };
          }),
      });
    })
  ).pipe(Layer.provide(ClaudeSdk.layer));

const bridge = (log: Ref.Ref<ReadonlyArray<Opened>>) =>
  Claude.layerNoDeps.pipe(
    Layer.provide(
      Layer.mergeAll(
        recordingSdk(log),
        ClaudeSlots.layer,
        ClaudeAccount.layer,
        ClaudeOneShot.layer
      )
    )
  );

const model = Option.getOrThrow(
  claudeModel(values.model, DEFAULT_LONG_CONTEXT)
);

const system: Message = {
  role: "system",
  content: "You are a terse assistant in a test. Answer in one short sentence.",
  sections: {
    cairn:
      "<cairn>The thread runs in a scratch directory. Never call tools.</cairn>",
    skills: "<skills>No skills are installed.</skills>",
  },
  timestamp: 1,
};

const skillsChanged: Message = {
  role: "system",
  content: "",
  sections: {
    skills:
      "<skills>One skill is installed: pelican-drawing, which draws pelicans.</skills>",
  },
  timestamp: 4,
};

const cairnChanged: Message = {
  role: "system",
  content: "",
  sections: {
    cairn:
      "<cairn>The thread runs in a scratch directory named heron. Never call tools.</cairn>",
  },
  timestamp: 6,
};

const user = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: 2,
});

const turn = (cwd: string, messages: ReadonlyArray<Message>) =>
  Effect.gen(function* () {
    const claude = yield* Claude;

    yield* claude.noteConversation(sessionId, { cwd, threadId: Option.none() });

    const stream = claude.provider.streamSimple(
      model,
      providerContext(messages),
      { sessionId }
    );

    return yield* Effect.promise(async () => await stream.result());
  });

const replyText = (message: AssistantMessage) =>
  message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");

const reminders = (prompts: ReadonlyArray<string>) =>
  prompts.filter((prompt) => prompt.startsWith("<system-reminder>"));

const program = Effect.gen(function* () {
  const cwd = yield* Scratch.make("cairn-claude-reminder-");
  const live = yield* Ref.make<ReadonlyArray<Opened>>([]);
  const restarted = yield* Ref.make<ReadonlyArray<Opened>>([]);

  const first = [system, user("Say hello.")];

  const [one, two] = yield* Effect.gen(function* () {
    const reply1 = yield* turn(cwd, first);

    const second = [
      ...first,
      reply1,
      skillsChanged,
      user("Which skills are installed now?"),
    ];

    const reply2 = yield* turn(cwd, second);

    return [reply1, reply2] as const;
  }).pipe(Effect.scoped, Effect.provide(bridge(live)));

  const third = [
    ...first,
    one,
    skillsChanged,
    user("Which skills are installed now?"),
    two,
    cairnChanged,
    user("What is the scratch directory named?"),
  ];

  const three = yield* turn(cwd, third).pipe(
    Effect.scoped,
    Effect.provide(bridge(restarted))
  );

  const liveLog = yield* Ref.get(live);
  const restartLog = yield* Ref.get(restarted);
  const secondPrompts = liveLog[0]?.prompts.slice(1) ?? [];
  const thirdPrompts = restartLog[0]?.prompts ?? [];

  const checks = {
    oneChildForTwoTurns: liveLog.length === 1,
    oneReminderOnTurnTwo: reminders(secondPrompts).length === 1,
    turnTwoNamesSkillsOnly:
      (reminders(secondPrompts)[0] ?? "").includes('Section "skills"') &&
      !(reminders(secondPrompts)[0] ?? "").includes('Section "cairn"'),
    turnTwoUsesIt: /pelican/iu.test(replyText(two)),
    turnTwoSmallWrite:
      two.usage.cacheWrite <= maxWrite && two.usage.cacheRead > 0,
    restartResumes: restartLog[0]?.session.kind === "resume",
    restartResumesTheStamp:
      restartLog[0]?.session.kind === "resume" &&
      Option.contains(
        Option.map(stampOf(two), (stamp) => stamp.ccSessionId),
        restartLog[0].session.sessionId
      ),
    oneReminderAfterRestart:
      reminders(thirdPrompts).length === 1 &&
      (reminders(thirdPrompts)[0] ?? "").includes('Section "cairn"') &&
      !(reminders(thirdPrompts)[0] ?? "").includes('Section "skills"'),
    turnThreeUsesIt: /heron/iu.test(replyText(three)),
    restartCacheRatio:
      three.usage.cacheRead >= 10 * Math.max(1, three.usage.cacheWrite),
  };

  const passed = Object.values(checks).every(Boolean);

  yield* Effect.logInfo("claude-reminder").pipe(
    Effect.annotateLogs({
      passed,
      checks,
      model: values.model,
      usage: [one, two, three].map((reply) => ({
        stop: reply.stopReason,
        error: reply.errorMessage ?? "",
        input: reply.usage.input,
        cacheRead: reply.usage.cacheRead,
        cacheWrite: reply.usage.cacheWrite,
        output: reply.usage.output,
      })),
      replies: [one, two, three].map(replyText),
      reminderChars: [
        ...reminders(secondPrompts),
        ...reminders(thirdPrompts),
      ].map((text) => text.length),
      restartSession: restartLog[0]?.session ?? "none",
    })
  );

  if (!passed) {
    return yield* new ClaudeReminderFailed({
      message: "claude-reminder failed: see the checks in the log line above.",
    });
  }

  return checks;
});

// A turn that never ends fails the judge at the deadline instead of hanging it.
NodeRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: Duration.minutes(5),
      orElse: () =>
        Effect.fail(
          new ClaudeReminderFailed({
            message: "judge timed out after 5 minutes",
          })
        ),
    })
  )
);
