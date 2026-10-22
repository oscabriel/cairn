// Documents for the attachment tests, made in memory so every fixture is readable in the test that
// uses it: PDFs with text placed at given points on each page (one column, two columns, or none),
// ZIP archives (stored or deflated, with sizes that can be made to lie), DOCX files over them, and a
// real PNG.
import { crc32, deflateRawSync } from "node:zlib";

/** One run of text on a PDF page, at `x`, `y` points from the bottom left of a US Letter page. */
export interface PdfText {
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

/** 1 catalog, 2 pages, 3 font, then per page: the page object and its content stream. */
const pageObject = (index: number) => 4 + index * 2;

const pdfString = (text: string) =>
  `(${text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")})`;

/**
 * A PDF with one page per entry of `pages`, each drawing its texts in Helvetica 12. A page with no
 * texts has an empty content stream, like a scan's page without its image.
 */
export const makePdf = (
  pages: ReadonlyArray<ReadonlyArray<PdfText>>
): Uint8Array => {
  const objects: Array<string> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${String(pageObject(index))} 0 R`).join(" ")}] /Count ${String(pages.length)} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  for (const [index, texts] of pages.entries()) {
    const stream = texts
      .map(
        (run) =>
          `BT /F1 12 Tf ${String(run.x)} ${String(run.y)} Td ${pdfString(run.text)} Tj ET`
      )
      .join("\n");

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(pageObject(index) + 1)} 0 R >>`,
      `<< /Length ${String(Buffer.byteLength(stream))} >>\nstream\n${stream}\nendstream`
    );
  }

  let body = "%PDF-1.4\n";
  const offsets: Array<number> = [];

  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }

  const xref = Buffer.byteLength(body);

  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;

  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }

  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(body, "latin1"));
};

/** One file in a ZIP archive. */
export interface ZipFile {
  readonly name: string;
  readonly data: Uint8Array;
  /** Deflate the data (default stored). */
  readonly deflate?: boolean;
  /** Write this uncompressed size in the headers instead of the true one. */
  readonly claimedSize?: number;
}

/** A ZIP archive of `files`, with a central directory. */
export const makeZip = (files: ReadonlyArray<ZipFile>): Uint8Array => {
  const locals: Array<Buffer> = [];
  const centrals: Array<Buffer> = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf-8");

    const compressed =
      file.deflate === true
        ? deflateRawSync(file.data)
        : Buffer.from(file.data);

    const method = file.deflate === true ? 8 : 0;
    const size = file.claimedSize ?? file.data.length;

    const checksum = crc32(file.data);

    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);

    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...locals, directory, end]));
};

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf-8"));

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The package parts every DOCX carries besides its document. */
const docxParts = (documentXml: string): ReadonlyArray<ZipFile> => [
  {
    name: "[Content_Types].xml",
    data: utf8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    ),
  },
  {
    name: "_rels/.rels",
    data: utf8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    ),
  },
  { name: "word/document.xml", data: utf8(documentXml), deflate: true },
];

/** A DOCX whose body is one paragraph per entry of `paragraphs`. */
export const makeDocx = (paragraphs: ReadonlyArray<string>): Uint8Array =>
  makeZip(
    docxParts(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
        .map((text) => `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`)
        .join("")}</w:body></w:document>`
    )
  );

/**
 * A DOCX that also carries `media/padding.bin`: `bytes` zeros deflated to almost nothing, with
 * its true size in the headers, the shape of a ZIP bomb.
 */
export const makeDocxBomb = (bytes: number): Uint8Array =>
  makeZip([
    ...docxParts(
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>bomb</w:t></w:r></w:p></w:body></w:document>'
    ),
    {
      name: "word/media/padding.bin",
      data: new Uint8Array(bytes),
      deflate: true,
    },
  ]);

/** A 1x1 PNG. */
export const PNG_1X1 = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64"
  )
);
