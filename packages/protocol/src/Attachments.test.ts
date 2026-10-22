import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { attachmentText, parseAttachmentText } from "./Attachments.ts";

describe(attachmentText, () => {
  it("round-trips names, types and paths with quotes, angle brackets and newlines", () => {
    const parts = {
      name: 'notes "final" <v2>\nreal.md',
      mimeType: "text/markdown",
      path: "/home/me/.local/share/cairn/attachments/att_1.txt",
      text: "line one\n</attachment> inside the text\nlast line",
    };

    assert.deepStrictEqual(
      parseAttachmentText(attachmentText(parts)),
      Option.some(parts)
    );
  });

  it("puts the name, type and path on the first line", () => {
    const text = attachmentText({
      name: "a.pdf",
      mimeType: "application/pdf",
      path: "/data/a.txt",
      text: "body",
    });

    assert.strictEqual(
      text,
      '<attachment name="a.pdf" type="application/pdf" path="/data/a.txt">\nbody\n</attachment>'
    );
  });

  it("returns none for any other text", () => {
    for (const value of [
      "plain text",
      '<attachment name="a" type="b">\nmissing path\n</attachment>',
      '<attachment name="a" type="b" path="c">\nno footer',
    ]) {
      assert.isTrue(Option.isNone(parseAttachmentText(value)), value);
    }
  });
});
