// Brain text reaches a protocol error cut to fit (T19): a 10,000-character harness failure still
// encodes as the protocol's error, and a missing thread is named by its thread id.

import { Internal, NotFound } from "@cairn/protocol/Errors";
import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { HarnessError } from "../brain/HarnessSeam.ts";
import { publicText } from "./PublicText.ts";
import { fromHarnessError } from "./ThreadCommandHandlers.ts";

const failure = (reason: HarnessError["reason"], message: string) =>
  new HarnessError({
    message,
    reason,
    retryable: false,
    threadId: Option.none(),
  });

describe("errors bound for the protocol", () => {
  it("fold to one line and fit DisplayText", () => {
    expect(publicText("first\n  second")).toBe("first second");
    expect(publicText("x".repeat(10_000))).toHaveLength(4096);
  });

  it("encode a 10,000-character brain failure", () => {
    const error = fromHarnessError(
      failure("internal", `boom\n${"x".repeat(10_000)}`),
      "t_1",
      Option.none()
    );

    expect(error).toBeInstanceOf(Internal);
    expect(() => Schema.encodeUnknownSync(Internal)(error)).not.toThrow();
  });

  it("name a missing thread by its thread id, whatever the call's own target", () => {
    const error = fromHarnessError(
      failure("thread_not_found", "No such thread."),
      "submission-7",
      Option.none(),
      "thread-3"
    );

    expect(error).toBeInstanceOf(NotFound);
    expect(error).toMatchObject({ resource: "thread", id: "thread-3" });
  });
});
