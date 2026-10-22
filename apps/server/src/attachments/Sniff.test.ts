// What an upload is comes from its bytes: magic numbers win over the name and the claimed type,
// HEIC and video are refused with a message that says what to attach, Office files are told apart
// by their ZIP directory, and text must be strict UTF-8 with no NUL.
import { assert, describe, it } from "@effect/vitest";

import { makeDocx, makeZip, PNG_1X1, makePdf } from "./AttachmentsTestKit.ts";
import { DOCX_MIME_TYPE, sniff } from "./Sniff.ts";
import type { Sniffed } from "./Sniff.ts";

type ImageMime = Extract<Sniffed, { readonly kind: "image" }>["mimeType"];

const bytes = (...values: ReadonlyArray<number>) => new Uint8Array(values);

const ascii = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));

const concat = (...parts: ReadonlyArray<Uint8Array>) =>
  new Uint8Array(Buffer.concat(parts));

/** An ISO base media file's first box: size, `ftyp`, then the brand. */
const ftyp = (brand: string) =>
  concat(bytes(0, 0, 0, 0x18), ascii(`ftyp${brand}`), new Uint8Array(12));

describe(sniff, () => {
  it("knows each image by its magic bytes", () => {
    const cases: ReadonlyArray<readonly [Uint8Array, ImageMime]> = [
      [PNG_1X1, "image/png"],
      [bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10), "image/jpeg"],
      [ascii("GIF89a\u0001\u0000\u0001\u0000"), "image/gif"],
      [ascii("GIF87a\u0001\u0000\u0001\u0000"), "image/gif"],
      [
        concat(ascii("RIFF"), bytes(0, 0, 0, 0), ascii("WEBPVP8 ")),
        "image/webp",
      ],
    ];

    for (const [data, mimeType] of cases) {
      assert.deepStrictEqual(sniff(data, "application/octet-stream"), {
        kind: "image",
        mimeType,
      });
    }
  });

  it("believes the bytes, not a lying name or type", () => {
    assert.deepStrictEqual(sniff(PNG_1X1, "text/plain"), {
      kind: "image",
      mimeType: "image/png",
    });
    assert.deepStrictEqual(sniff(ascii("just words\n"), "image/png"), {
      kind: "text",
      mimeType: "text/plain",
    });
    assert.deepStrictEqual(
      sniff(makePdf([[{ x: 72, y: 700, text: "hi" }]]), "image/jpeg"),
      { kind: "pdf", mimeType: "application/pdf" }
    );
    assert.deepStrictEqual(sniff(makeDocx(["hi"]), "application/pdf"), {
      kind: "docx",
      mimeType: DOCX_MIME_TYPE,
    });
  });

  it("refuses HEIC and video with a message naming what to attach", () => {
    for (const brand of ["heic", "heix", "mif1", "isom", "qt  "]) {
      const sniffed = sniff(ftyp(brand), "image/jpeg");

      assert.strictEqual(sniffed.kind, "refused", brand);
      assert.include(
        sniffed.kind === "refused" ? sniffed.message : "",
        "JPEG or PNG"
      );
    }
  });

  it("tells Office files apart by their ZIP directory", () => {
    const sheet = makeZip([
      { name: "[Content_Types].xml", data: ascii("<Types/>") },
      { name: "xl/workbook.xml", data: ascii("<workbook/>") },
    ]);

    const slides = makeZip([
      { name: "ppt/presentation.xml", data: ascii("<presentation/>") },
    ]);

    const archive = makeZip([{ name: "notes.txt", data: ascii("hi") }]);

    assert.deepStrictEqual(sniff(sheet, "application/zip"), {
      kind: "file",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.strictEqual(sniff(slides, "application/zip").kind, "file");
    assert.strictEqual(sniff(archive, "application/zip").kind, "refused");
  });

  it("takes text only as strict UTF-8 with no NUL", () => {
    assert.deepStrictEqual(sniff(ascii("# Title\n"), "text/markdown"), {
      kind: "text",
      mimeType: "text/markdown",
    });
    assert.deepStrictEqual(
      sniff(new TextEncoder().encode('{"ünï": "cødé"}'), "application/json"),
      { kind: "text", mimeType: "application/json" }
    );
    assert.deepStrictEqual(sniff(ascii("a,b\n"), "application/x-msdownload"), {
      kind: "text",
      mimeType: "text/plain",
    });
    assert.strictEqual(
      sniff(bytes(0x61, 0, 0x62), "text/plain").kind,
      "refused"
    );
    assert.strictEqual(sniff(bytes(0xc3, 0x28), "text/plain").kind, "refused");
    assert.strictEqual(
      sniff(bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0), "text/plain").kind,
      "refused"
    );
  });
});
