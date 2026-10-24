import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  attachmentPathLine,
  attachmentText,
  isAddedUserPart,
  parseAttachmentPathLine,
  parseAttachmentText,
} from "./Attachments.ts";

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

describe(attachmentPathLine, () => {
  const image = {
    kind: "image" as const,
    name: "IMG_0606.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 87_384,
    path: "/home/me/.local/share/cairn/attachments/EIyYlN6GUR-MCvmobE_-Rg/original",
    note: "",
  };

  it("writes the line the model reads, as t3code does", () => {
    assert.strictEqual(
      attachmentPathLine(image),
      '[Attached image "IMG_0606.jpg" (image/jpeg, 85 KB) is saved at: /home/me/.local/share/cairn/attachments/EIyYlN6GUR-MCvmobE_-Rg/original]'
    );
  });

  it("parses its own lines, the file kind's note and rows already stored", () => {
    assert.deepStrictEqual(
      parseAttachmentPathLine(attachmentPathLine(image)),
      Option.some({ kind: "image", name: "IMG_0606.jpg" })
    );

    assert.deepStrictEqual(
      parseAttachmentPathLine(
        attachmentPathLine({
          ...image,
          kind: "file",
          name: 'budget "2026".xlsx',
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          note: ". Its contents are not shown inline; open it with a tool",
        })
      ),
      Option.some({ kind: "file", name: 'budget "2026".xlsx' })
    );

    // Entry 1563 of the live store: the path ends at the attachment's folder.
    assert.deepStrictEqual(
      parseAttachmentPathLine(
        '[Attached image "IMG_0606.jpg" (image/jpeg, 85 KB) is saved at: /home/oscargabriel/.local/share/cairn/attachments/EIyYlN6GUR-MCvmobE_-Rg]'
      ),
      Option.some({ kind: "image", name: "IMG_0606.jpg" })
    );
  });

  it("leaves the user's own words alone", () => {
    for (const text of [
      "what word does this show?",
      '[Attached image "x.png" is a thing I typed',
      'see [Attached image "x.png" (image/png, 1 KB) is saved at: /tmp/x]',
    ]) {
      assert.isTrue(Option.isNone(parseAttachmentPathLine(text)), text);
      assert.isFalse(isAddedUserPart(text), text);
    }
  });

  it("counts attachment blocks and path lines as parts the brain added", () => {
    assert.isTrue(isAddedUserPart(attachmentPathLine(image)));
    assert.isTrue(
      isAddedUserPart(
        attachmentText({
          name: "a.md",
          mimeType: "text/markdown",
          path: "/tmp/a",
          text: "hi",
        })
      )
    );
  });
});
