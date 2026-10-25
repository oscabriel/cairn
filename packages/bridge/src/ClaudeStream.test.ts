// ClaudeStream on its own: when a turn of Claude Code events ends, and what pi receives. The
// conversation tests drive the same paths end to end; these pin the stream's rules directly.
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import type { ClaudeEvent } from "./ClaudeEvents.ts";
import { PLAN_QUOTA_PREFIX } from "./ClaudeGuards.ts";
import { toolDeclaration } from "./ClaudeMcp.ts";
import { claudeModels, DEFAULT_LONG_CONTEXT } from "./ClaudeModels.ts";
import type { ToolBlock } from "./ClaudeScriptKit.ts";
import {
  failedTurn,
  fallbackToolBlocks,
  messageStart,
  textTurn,
  toolBlock,
  toolBlockOpening,
  toolMessageStop,
} from "./ClaudeScriptKit.ts";
import type { EventEffect } from "./ClaudeStream.ts";
import { ClaudeStream } from "./ClaudeStream.ts";

const model = Option.getOrThrow(
  Option.fromNullishOr(
    claudeModels(DEFAULT_LONG_CONTEXT).find((m) => m.id === "claude-sonnet-5-5")
  )
);

const tools = Option.toArray(
  toolDeclaration({
    name: "mark",
    description: "Append a line.",
    parameters: Type.Object({ line: Type.Optional(Type.String()) }),
  })
);

const blockA: ToolBlock = {
  toolUseId: "toolu_a",
  tool: "mark",
  args: { line: "first" },
  uuid: "u1a",
};

const blockB: ToolBlock = {
  toolUseId: "toolu_b",
  tool: "mark",
  args: { line: "second" },
  uuid: "u1b",
};

const kindOf = (effect: EventEffect): string =>
  effect.kind === "ended" ? `ended:${effect.end.kind}` : effect.kind;

/** A stream with an open turn, and the effects of the events fed to it. */
const opened = () => {
  const stream = new ClaudeStream(model, tools, () => {});
  const sink = createAssistantMessageEventStream();

  stream.begin(sink, 0);

  const feed = (events: ReadonlyArray<ClaudeEvent>): ReadonlyArray<string> =>
    events.map((event) => stream.handle(event)).map(kindOf);

  return { stream, sink, feed };
};

const callIds = (stream: ClaudeStream): ReadonlyArray<string> =>
  stream.output.content.flatMap((block) =>
    block.type === "toolCall" ? [block.id] : []
  );

describe("streamed tool-use turns", () => {
  it("keep a turn open when a call lands between blocks, and end it on message_stop with both", () => {
    const { stream, feed } = opened();

    feed([messageStart("m1"), ...toolBlock("m1", 0, blockA)]);

    expect([
      kindOf(stream.toolCallArrived("toolu_a")),
      stream.open,
    ]).toStrictEqual(["none", true]);

    const ends = feed([...toolBlock("m1", 1, blockB), ...toolMessageStop]);

    expect([ends.at(-1), callIds(stream), stream.lastUuid]).toStrictEqual([
      "ended:tool-use",
      ["toolu_a", "toolu_b"],
      Option.some("u1b"),
    ]);
  });

  it("drop a block still open at message_stop rather than hand pi its partial arguments", () => {
    const { stream, feed } = opened();

    feed([
      messageStart("m1"),
      ...toolBlock("m1", 0, blockA),
      ...toolBlockOpening(1, blockB, 4),
      ...toolMessageStop,
    ]);

    expect([stream.open, callIds(stream)]).toStrictEqual([false, ["toolu_a"]]);
  });
});

describe("fallback tool-use turns", () => {
  it("gather a message's per-block events and end when Claude Code calls one of its tools", () => {
    const { stream, feed } = opened();

    const effects = feed(fallbackToolBlocks("m1", [blockA, blockB]));

    expect([effects, stream.open]).toStrictEqual([["none", "none"], true]);
    expect([
      kindOf(stream.toolCallArrived("toolu_a")),
      callIds(stream),
    ]).toStrictEqual(["ended:tool-use", ["toolu_a", "toolu_b"]]);
  });

  it("end on the event that delivers a block whose call already landed", () => {
    const { stream, feed } = opened();

    expect(kindOf(stream.toolCallArrived("toolu_a"))).toBe("none");
    expect(feed(fallbackToolBlocks("m1", [blockA]))).toStrictEqual([
      "ended:tool-use",
    ]);
  });
});

describe("results", () => {
  it("report a successful result that arrives with no provider call open", () => {
    const { feed } = opened();

    feed([
      messageStart("m1"),
      ...toolBlock("m1", 0, blockA),
      ...toolMessageStop,
    ]);

    expect(feed(textTurn("m2", "u2", "answered alone")).at(-1)).toBe(
      "unattached-result"
    );
  });
});

describe("a plan window rejection", () => {
  it("labels only the turn it arrived in", () => {
    const { stream, feed } = opened();

    const rejected: ClaudeEvent = {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
    };

    // The rejection came, but the turn still answered.
    feed([rejected, ...textTurn("m1", "u1", "fine")]);

    const sink = createAssistantMessageEventStream();

    stream.begin(sink, 1);
    feed(failedTurn("Overloaded."));

    expect(stream.output.errorMessage).not.toContain(PLAN_QUOTA_PREFIX);

    // A rejection fed to the stream between turns is dropped when the next one begins.
    stream.handle(rejected);
    stream.begin(createAssistantMessageEventStream(), 2);
    feed(failedTurn("Overloaded."));

    expect(stream.output.errorMessage).not.toContain(PLAN_QUOTA_PREFIX);
  });
});

describe("a large tool argument", () => {
  it("streams in time linear in its size, and decodes once whole", () => {
    const { stream, feed } = opened();
    const big: ToolBlock = { ...blockA, args: { line: "x".repeat(60_000) } };
    const json = JSON.stringify(big.args);
    const deltas: Array<ClaudeEvent> = [];

    for (let at = 0; at < json.length; at += 50) {
      deltas.push({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: json.slice(at, at + 50),
          },
        },
      });
    }

    feed([messageStart("m1"), ...toolBlockOpening(0, big)]);

    const started = performance.now();

    feed(deltas);

    const elapsed = performance.now() - started;

    feed([
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    ]);

    expect(elapsed).toBeLessThan(20);
    expect(stream.output.content[0]).toMatchObject({
      type: "toolCall",
      arguments: big.args,
    });
  });
});
