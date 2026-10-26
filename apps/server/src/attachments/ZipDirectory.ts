// The central directory of a ZIP archive, read without inflating anything: the entry names and the
// sizes each entry claims. Sniffing uses the names to tell a DOCX from another Office file, and text
// extraction refuses a DOCX whose claimed uncompressed size is past the cap before `mammoth` opens
// it. Archives that need ZIP64 records are not read (none of the formats Cairn accepts needs them
// below 50 MiB), so they count as unreadable. Pure.

import { Option } from "effect";

/** One entry as the central directory describes it. */
export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  /** What the archive claims the entry inflates to; a hostile archive can lie, so callers also cap memory. */
  readonly uncompressedSize: number;
}

const END_OF_DIRECTORY = 0x06_05_4b_50;

const DIRECTORY_ENTRY = 0x02_01_4b_50;

/** The end-of-directory record is 22 bytes plus a comment of at most 65,535. */
const MAX_END_SEARCH = 22 + 0xff_ff;

const ZIP64_MARKER_32 = 0xff_ff_ff_ff;

const ZIP64_MARKER_16 = 0xff_ff;

const names = new TextDecoder("utf-8");

/** True when `bytes` start like a ZIP archive (a local file header). */
export const looksLikeZip = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  bytes[2] === 0x03 &&
  bytes[3] === 0x04;

const findEndOfDirectory = (view: DataView): Option.Option<number> => {
  const lowest = Math.max(0, view.byteLength - MAX_END_SEARCH);

  for (let offset = view.byteLength - 22; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_DIRECTORY) {
      return Option.some(offset);
    }
  }

  return Option.none();
};

/**
 * The archive's entries from its central directory; none when `bytes` are not a ZIP archive Cairn
 * can read (no end record, a truncated directory, or ZIP64 records).
 */
export const readZipDirectory = (
  bytes: Uint8Array
): Option.Option<ReadonlyArray<ZipEntry>> => {
  if (!looksLikeZip(bytes) || bytes.length < 22) {
    return Option.none();
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEndOfDirectory(view);

  if (Option.isNone(end)) {
    return Option.none();
  }

  const count = view.getUint16(end.value + 10, true);
  const directorySize = view.getUint32(end.value + 12, true);
  const directoryOffset = view.getUint32(end.value + 16, true);

  if (
    count === ZIP64_MARKER_16 ||
    directorySize === ZIP64_MARKER_32 ||
    directoryOffset === ZIP64_MARKER_32 ||
    directoryOffset + directorySize > end.value
  ) {
    return Option.none();
  }

  const entries: Array<ZipEntry> = [];
  let offset = directoryOffset;

  for (let index = 0; index < count; index += 1) {
    if (
      offset + 46 > end.value ||
      view.getUint32(offset, true) !== DIRECTORY_ENTRY
    ) {
      return Option.none();
    }

    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;

    if (
      compressedSize === ZIP64_MARKER_32 ||
      uncompressedSize === ZIP64_MARKER_32 ||
      nameStart + nameLength > end.value
    ) {
      return Option.none();
    }

    entries.push({
      name: names.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      compressedSize,
      uncompressedSize,
    });

    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return Option.some(entries);
};
