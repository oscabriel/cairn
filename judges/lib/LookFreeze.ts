// Frozen look rounds (plan look track L5, ADR 0040): what `judges/look.ts freeze <n>` records when
// the user approves round <n>, and how `judges/look.ts check` judges today's client against it.
//
// A frozen round is one checked-in manifest, `judges/look/frozen/round-<n>.json`: the hash of
// `apps/web/src/next/tokens.css` as the round drew it, and for each shot (a state at a width in a
// theme) the SHA-256 of its PNG and a fingerprint, the mean colour of each cell of the screenshot.
// The screenshots themselves stay on the round's page, out of the repository; the fingerprint is
// what lets a drift be measured instead of only noticed.
//
// The check, against the newest frozen round only (an approved round supersedes the ones before):
// - tokens: today's tokens.css must hash as the round's did, byte for byte. A token is a decision
//   the user approved, so any change to the file needs a new round;
// - pixels: a shot whose PNG hashes as frozen passes. Otherwise its fingerprint is compared with
//   the frozen one, cell by cell, and the shot drifts when a cell's mean, rounded to a whole
//   level of 255, moved by more than `ALLOWANCE.cellLevels` in any channel, or when its size
//   changed.
// The allowance, and why. A cell is 16 by 16 CSS px (32 by 32 device px at scale 2) and the
// allowance is 0 levels: a change passes only when it moves no cell's rounded mean at all, such
// as a few antialiased glyph-edge pixels shifting by a few levels. Measured on 2026-10-29: the
// rendering noise is nil (three full captures, 18 of 18 shots byte-identical; Playwright, and so
// its Chromium, is pinned at 1.64.1), while the smallest real changes moved some cell by 1 or 2
// levels and no more: the whole main column 1 px lower (thread at 390 px: 15 cells, at most 1
// level; at 1,440 px: 19 cells, at most 2) and the faint ink 7 levels lighter (thread at 390 px:
// 30 cells, at most 2). Any allowance of 1 level or more would let those through. A Playwright
// upgrade that rasterizes text differently is reported as drift: republish the round and ask.
// Pure: no browser and no files, so judges/look.test.ts can judge it with fixtures.

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

import { Schema } from "effect";

/** The side of a fingerprint cell, in CSS px. */
export const CELL_CSS_PX = 16;

/**
 * How far a frozen shot may move before it drifts: a cell's mean may move by this many levels
 * (of 255) in any channel. The header gives the measured numbers behind 0.
 */
export const ALLOWANCE = { cellLevels: 0 } as const;

/** The hash every frozen record uses: SHA-256, lowercase hex. */
export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------------------------
// PNG decoding: the 8-bit, non-interlaced RGB and RGBA files Chromium's screenshots are.

/** A decoded image: `width * height` pixels of RGBA, row by row. */
export interface Image {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const paeth = (left: number, up: number, upLeft: number): number => {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);

  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left;
  }

  return toUp <= toUpLeft ? up : upLeft;
};

/** PNG's row filters by type (none, sub, up, average, Paeth): what each byte was predicted as. */
const PREDICTORS: ReadonlyArray<
  (left: number, up: number, upLeft: number) => number
> = [
  () => 0,
  (left) => left,
  (_left, up) => up,
  (left, up) => Math.floor((left + up) / 2),
  paeth,
];

/** A PNG's header and its compressed pixel data, read from its chunks. */
interface PngChunks {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly data: Buffer;
}

/** Reads the chunks of an 8-bit RGB or RGBA PNG without interlacing; throws on anything else. */
const readChunks = (bytes: Buffer): PngChunks => {
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw new Error("not a PNG");
  }

  let header: Buffer | undefined;
  const data: Array<Buffer> = [];

  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      header = body;
    } else if (type === "IDAT") {
      data.push(body);
    }

    offset = type === "IEND" ? bytes.length : offset + 12 + length;
  }

  if (header === undefined) {
    throw new Error("a PNG without a header");
  }

  const depth = header.readUInt8(8);
  const colour = header.readUInt8(9);
  const interlace = header.readUInt8(12);

  if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
    throw new Error(
      `unsupported PNG: depth ${String(depth)}, colour type ${String(colour)}, interlace ${String(interlace)}`
    );
  }

  return {
    width: header.readUInt32BE(0),
    height: header.readUInt32BE(4),
    channels: colour === 6 ? 4 : 3,
    data: Buffer.concat(data),
  };
};

/** Undoes each row's filter: `height` rows of `stride` bytes. */
const unfilter = (
  raw: Buffer,
  height: number,
  stride: number,
  channels: number
): Uint8Array => {
  const rows = new Uint8Array(height * stride);

  for (let y = 0; y < height; y += 1) {
    const predict = PREDICTORS[raw[y * (stride + 1)] ?? 0];
    const from = y * (stride + 1) + 1;

    for (let x = 0; x < stride; x += 1) {
      const at = y * stride + x;
      const left = x >= channels ? (rows[at - channels] ?? 0) : 0;
      const up = y > 0 ? (rows[at - stride] ?? 0) : 0;

      const upLeft =
        y > 0 && x >= channels ? (rows[at - stride - channels] ?? 0) : 0;

      rows[at] =
        ((raw[from + x] ?? 0) + (predict?.(left, up, upLeft) ?? 0)) % 256;
    }
  }

  return rows;
};

/** Decodes a PNG of 8-bit RGB or RGBA without interlacing; throws on anything else. */
export const decodePng = (png: Uint8Array): Image => {
  const { width, height, channels, data } = readChunks(Buffer.from(png));
  const rows = unfilter(inflateSync(data), height, width * channels, channels);

  if (channels === 4) {
    return { width, height, rgba: rows };
  }

  const rgba = new Uint8Array(width * height * 4);

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba[pixel * 4] = rows[pixel * 3] ?? 0;
    rgba[pixel * 4 + 1] = rows[pixel * 3 + 1] ?? 0;
    rgba[pixel * 4 + 2] = rows[pixel * 3 + 2] ?? 0;
    rgba[pixel * 4 + 3] = 255;
  }

  return { width, height, rgba };
};

// ---------------------------------------------------------------------------------------------
// Fingerprints

/** A shot's fingerprint: the mean RGB of each cell, row by row, deflated and in base64. */
export const Fingerprint = Schema.Struct({
  /** The cell's side in device px (CSS px times the shot's device scale). */
  cellPx: Schema.Int,
  columns: Schema.Int,
  rows: Schema.Int,
  means: Schema.String,
});

export type Fingerprint = typeof Fingerprint.Type;

/** The mean RGB of each `cellPx` square of `image`; the last row and column may be partial. */
export const fingerprintOf = (image: Image, cellPx: number): Fingerprint => {
  const columns = Math.ceil(image.width / cellPx);
  const rows = Math.ceil(image.height / cellPx);
  const sums = new Float64Array(columns * rows * 3);
  const counts = new Float64Array(columns * rows);

  for (let y = 0; y < image.height; y += 1) {
    const row = Math.floor(y / cellPx) * columns;

    for (let x = 0; x < image.width; x += 1) {
      const cell = row + Math.floor(x / cellPx);
      const pixel = (y * image.width + x) * 4;

      sums[cell * 3] = (sums[cell * 3] ?? 0) + (image.rgba[pixel] ?? 0);
      sums[cell * 3 + 1] =
        (sums[cell * 3 + 1] ?? 0) + (image.rgba[pixel + 1] ?? 0);
      sums[cell * 3 + 2] =
        (sums[cell * 3 + 2] ?? 0) + (image.rgba[pixel + 2] ?? 0);
      counts[cell] = (counts[cell] ?? 0) + 1;
    }
  }

  const means = new Uint8Array(columns * rows * 3);

  for (let cell = 0; cell < columns * rows; cell += 1) {
    const count = counts[cell] ?? 1;

    for (let channel = 0; channel < 3; channel += 1) {
      means[cell * 3 + channel] = Math.round(
        (sums[cell * 3 + channel] ?? 0) / count
      );
    }
  }

  return {
    cellPx,
    columns,
    rows,
    means: deflateSync(means).toString("base64"),
  };
};

const meansOf = (fingerprint: Fingerprint): Uint8Array =>
  new Uint8Array(inflateSync(Buffer.from(fingerprint.means, "base64")));

/** How a shot compares with its frozen fingerprint. */
export interface Drift {
  /** False when the grids differ in size: the shot changed shape, so every cell counts. */
  readonly sameSize: boolean;
  /** Cells whose mean moved by more than the allowance in some channel. */
  readonly cells: number;
  /** The most any cell's mean moved in one channel, in levels. */
  readonly maxLevels: number;
  /** The drifted cells' bounding box in CSS px, when some drifted. */
  readonly box: { x: number; y: number; width: number; height: number } | null;
}

/** Compares `today` with `frozen` under `allowance` levels per cell and channel. */
export const driftOf = (
  frozen: Fingerprint,
  today: Fingerprint,
  scale: number,
  allowance: number = ALLOWANCE.cellLevels
): Drift => {
  if (
    frozen.cellPx !== today.cellPx ||
    frozen.columns !== today.columns ||
    frozen.rows !== today.rows
  ) {
    return {
      sameSize: false,
      cells: Math.max(frozen.columns * frozen.rows, today.columns * today.rows),
      maxLevels: 255,
      box: null,
    };
  }

  const before = meansOf(frozen);
  const after = meansOf(today);
  let cells = 0;
  let maxLevels = 0;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (let cell = 0; cell < frozen.columns * frozen.rows; cell += 1) {
    let moved = 0;

    for (let channel = 0; channel < 3; channel += 1) {
      moved = Math.max(
        moved,
        Math.abs(
          (before[cell * 3 + channel] ?? 0) - (after[cell * 3 + channel] ?? 0)
        )
      );
    }

    maxLevels = Math.max(maxLevels, moved);

    if (moved > allowance) {
      const column = cell % frozen.columns;
      const row = Math.floor(cell / frozen.columns);

      cells += 1;
      left = Math.min(left, column);
      right = Math.max(right, column + 1);
      top = Math.min(top, row);
      bottom = Math.max(bottom, row + 1);
    }
  }

  const css = frozen.cellPx / scale;

  return {
    sameSize: true,
    cells,
    maxLevels,
    box:
      cells === 0
        ? null
        : {
            x: left * css,
            y: top * css,
            width: (right - left) * css,
            height: (bottom - top) * css,
          },
  };
};

// ---------------------------------------------------------------------------------------------
// Manifests

/** The two widths every state is drawn at: a phone and a desktop window. */
export const LookWidth = Schema.Literals([390, 1440]);

export type LookWidth = typeof LookWidth.Type;

export const LookTheme = Schema.Literals(["dark", "light"]);

export type LookTheme = typeof LookTheme.Type;

/** One frozen shot: a named state at a width in a theme. */
export const FrozenShot = Schema.Struct({
  state: Schema.String,
  width: LookWidth,
  theme: LookTheme,
  /** The device scale the shot was taken at, so cells map back to CSS px. */
  scale: Schema.Int,
  sha256: Schema.String,
  fingerprint: Fingerprint,
});

export type FrozenShot = typeof FrozenShot.Type;

/** A frozen round: `judges/look/frozen/round-<n>.json`. */
export const FrozenRound = Schema.Struct({
  round: Schema.Int,
  /** Where the round's page was published, for whoever reads the manifest. */
  page: Schema.String,
  /** The commit the round was captured at. */
  commit: Schema.String,
  tokens: Schema.Struct({ path: Schema.String, sha256: Schema.String }),
  allowance: Schema.Struct({ cellLevels: Schema.Finite }),
  shots: Schema.Array(FrozenShot),
});

export type FrozenRound = typeof FrozenRound.Type;

const decodeFrozenRound = Schema.decodeUnknownSync(
  Schema.fromJsonString(FrozenRound)
);

/** Parses a frozen round's manifest text; throws with the schema's message when it is not one. */
export const parseFrozenRound = (text: string): FrozenRound =>
  decodeFrozenRound(text);

const encodeFrozenRound = Schema.encodeSync(FrozenRound);

/** A frozen round as its checked-in file holds it. */
export const formatFrozenRound = (round: FrozenRound): string =>
  `${JSON.stringify(encodeFrozenRound(round), null, 2)}\n`;

/** The newest of `rounds` by number, the one `check` judges, when there is one. */
export const newestRound = (
  rounds: ReadonlyArray<FrozenRound>
): FrozenRound | undefined => {
  let newest: FrozenRound | undefined;

  for (const round of rounds) {
    if (newest === undefined || round.round > newest.round) {
      newest = round;
    }
  }

  return newest;
};

/** The name a shot goes by in files and reports: `<state>-<width>-<theme>`. */
export const shotName = (shot: {
  readonly state: string;
  readonly width: number;
  readonly theme: string;
}): string => `${shot.state}-${String(shot.width)}-${shot.theme}`;

/** Why the tokens fail a frozen round, or nothing when they hash as it recorded. */
export const tokensFinding = (
  round: FrozenRound,
  tokensText: string
): string | undefined => {
  const today = sha256(tokensText);

  return today === round.tokens.sha256
    ? undefined
    : `${round.tokens.path} hashes ${today.slice(0, 12)}, round ${String(round.round)} froze ${round.tokens.sha256.slice(0, 12)}: a token changed after the user approved the round, so it needs a new round`;
};

/** How one shot of today's client compares with its frozen record. */
export interface ShotVerdict {
  readonly name: string;
  readonly pass: boolean;
  readonly exact: boolean;
  readonly drift: Drift | null;
  readonly detail: string;
}

/** Judges a shot taken today (its PNG) against its frozen record. */
export const shotVerdict = (
  frozen: FrozenShot,
  png: Uint8Array,
  allowance: number = ALLOWANCE.cellLevels
): ShotVerdict => {
  const name = shotName(frozen);

  if (sha256(png) === frozen.sha256) {
    return { name, pass: true, exact: true, drift: null, detail: "identical" };
  }

  const drift = driftOf(
    frozen.fingerprint,
    fingerprintOf(decodePng(png), frozen.fingerprint.cellPx),
    frozen.scale,
    allowance
  );

  if (!drift.sameSize) {
    return {
      name,
      pass: false,
      exact: false,
      drift,
      detail: "the shot changed size",
    };
  }

  const pass = drift.cells === 0;

  return {
    name,
    pass,
    exact: false,
    drift,
    detail: pass
      ? `within the allowance: no cell moved more than ${String(allowance)} levels (most ${String(drift.maxLevels)})`
      : `${String(drift.cells)} cell(s) moved more than ${String(allowance)} levels (most ${String(drift.maxLevels)}), within x ${String(drift.box?.x)} y ${String(drift.box?.y)} ${String(drift.box?.width)} by ${String(drift.box?.height)} CSS px`,
  };
};
