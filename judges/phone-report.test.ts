// The phone verdicts on log lines in the brain's own format (Effect's `Logger.formatJson`, as the
// events log and the unit's journal hold them): a pass, a fail, DERP runs excluded and re-asked, a
// desktop load ignored, and the paste sum with the user's pause before send left out.

import { describe, expect, it } from "@effect/vitest";

import * as Events from "./lib/Events.ts";
import { loadVerdict, pasteVerdict, PHONE_AGENT } from "./phone-report.ts";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const line = (
  timestamp: string,
  message: string,
  annotations: Readonly<Record<string, string | number | boolean>>
) =>
  JSON.stringify({
    message,
    level: "INFO",
    timestamp,
    cause: "",
    annotations,
    spans: {},
    fiberId: "#412",
  });

const load = (
  timestamp: string,
  interactiveMs: number,
  options: { readonly derp?: boolean; readonly agent?: string } = {}
) =>
  line(timestamp, "load report", {
    event: "load.report",
    interactiveMs,
    requestsBeforeInteractive: 5,
    derp: options.derp ?? false,
    path: options.derp === true ? "derp" : "direct",
    userAgent: options.agent ?? IPHONE,
    standalone: true,
    at: timestamp,
  });

const judgeLoads = (lines: ReadonlyArray<string>) =>
  loadVerdict(Events.parseLines(lines.join("\n")), {
    agent: PHONE_AGENT,
    runs: 3,
  });

describe("the phone load verdict", () => {
  it("passes three direct phone loads under 1,000 ms", () => {
    const verdict = judgeLoads([
      load("2026-10-22T18:00:01.000Z", 612),
      load("2026-10-22T18:00:21.000Z", 455),
      load("2026-10-22T18:00:41.000Z", 498),
      load("2026-10-22T18:00:50.000Z", 2400, { agent: MAC }),
    ]);

    expect(verdict.verdict).toBe("pass");
    expect(verdict.runs.map((run) => run.interactiveMs)).toStrictEqual([
      612, 455, 498,
    ]);
  });

  it("fails when one of the last three is 1,000 ms or more", () => {
    const verdict = judgeLoads([
      load("2026-10-22T18:00:01.000Z", 612),
      load("2026-10-22T18:00:21.000Z", 1000),
      load("2026-10-22T18:00:41.000Z", 498),
    ]);

    expect(verdict.verdict).toBe("fail");
  });

  it("excludes DERP runs and asks for more", () => {
    const short = judgeLoads([
      load("2026-10-22T18:00:01.000Z", 612),
      load("2026-10-22T18:00:21.000Z", 1840, { derp: true }),
      load("2026-10-22T18:00:41.000Z", 498),
    ]);

    expect(short.verdict).toBe("incomplete");
    expect(short.excludedDerp).toBe(1);
    expect(short.askFor).toBe(1);

    const reasked = judgeLoads([
      load("2026-10-22T18:00:01.000Z", 612),
      load("2026-10-22T18:00:21.000Z", 1840, { derp: true }),
      load("2026-10-22T18:00:41.000Z", 498),
      load("2026-10-22T18:01:05.000Z", 530),
    ]);

    expect(reasked.verdict).toBe("pass");
    expect(reasked.excludedDerp).toBe(1);
  });
});

const PASTE = [
  line("2026-10-22T18:10:00.120Z", "attachment upload URL issued", {
    event: "attachment.url_issued",
    attachmentId: "att_phone1",
    mimeType: "image/png",
    sizeBytes: 912_331,
    pasteToRequestMs: 240,
  }),
  line("2026-10-22T18:10:00.300Z", "attachment stored", {
    event: "attachment.stored",
    attachmentId: "att_phone1",
  }),
  line("2026-10-22T18:10:00.710Z", "attachment prepared", {
    event: "attachment.prepared",
    attachmentId: "att_phone1",
    mimeType: "image/png",
    bytes: 401_220,
    sha256: "9f".repeat(32),
  }),
  // The user looked at the chip for eight seconds before pressing send: not counted.
  line("2026-10-22T18:10:08.900Z", "turn submitted", {
    event: "turn.submitted",
    threadId: "019a0000-0000-7000-8000-000000000001",
    requestId: "req_1",
    attachments: 1,
    images: 1,
  }),
  line("2026-10-22T18:10:09.010Z", "provider request with images", {
    event: "provider.request",
    conversationId: "conv_1",
    taskId: "task_1",
  }),
];

describe("the phone paste verdict", () => {
  it("sums paste work and send to model, leaving out the pause before send", () => {
    const verdict = pasteVerdict(Events.parseLines(PASTE.join("\n")));

    expect(verdict.verdict).toBe("pass");
    expect(verdict.runs).toStrictEqual([
      {
        attachmentId: "att_phone1",
        pasteToRequestMs: 240,
        uploadAndPrepareMs: 590,
        sendToProviderMs: 110,
        totalMs: 940,
      },
    ]);
  });

  it("fails a paste whose work takes 2,000 ms or more", () => {
    const slow = PASTE.map((text) =>
      text.replace('"pasteToRequestMs":240', '"pasteToRequestMs":1400')
    );

    expect(pasteVerdict(Events.parseLines(slow.join("\n"))).verdict).toBe(
      "fail"
    );
  });

  it("is incomplete with no paste that reached the model", () => {
    expect(
      pasteVerdict(Events.parseLines(PASTE.slice(0, 3).join("\n"))).verdict
    ).toBe("incomplete");
  });
});
