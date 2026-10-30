// The frozen-round judge (plan look track L5): judges/lib/LookFreeze.ts, which `look.ts freeze`
// and `look.ts check` are built on, held to fixtures, and the checked-in frozen rounds held to
// today's tokens.css.
//
// The fixture round is frozen from the real tokens.css and from PNGs made here; it must pass as
// frozen (so the judge is not failing everything) and must fail when one token's value changes,
// when its pixels drift by one level in one cell, and when its size changes. The PNGs are encoded
// here with every row filter PNG has, so the decoder is judged on what Chromium may write.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  ALLOWANCE,
  decodePng,
  driftOf,
  fingerprintOf,
  formatFrozenRound,
  newestRound,
  parseFrozenRound,
  sha256,
  shotVerdict,
  tokensFinding,
} from "./lib/LookFreeze.ts";
import type { FrozenRound, Image } from "./lib/LookFreeze.ts";

const root = path.join(import.meta.dirname, "..");

const TOKENS_PATH = "apps/web/src/next/tokens.css";

const tokens = readFileSync(path.join(root, TOKENS_PATH), "utf-8");

// ---------------------------------------------------------------------------------------------
// A small PNG encoder for the fixtures: 8-bit RGB or RGBA, each row with a chosen filter.

const chunk = (type: string, body: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  const named = Buffer.concat([Buffer.from(type, "latin1"), body]);

  length.writeUInt32BE(body.length);
  crc.writeUInt32BE(crc32(named));

  return Buffer.concat([length, named, crc]);
};

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

/** Encodes `image`, row y with filter `y % 5`, as RGBA or (alpha dropped) RGB. */
const encodePng = (image: Image, alpha: boolean): Buffer => {
  const channels = alpha ? 4 : 3;
  const stride = image.width * channels;
  const pixels = new Uint8Array(image.height * stride);

  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      pixels[pixel * channels + channel] = image.rgba[pixel * 4 + channel] ?? 0;
    }
  }

  const raw = Buffer.alloc(image.height * (stride + 1));

  for (let y = 0; y < image.height; y += 1) {
    const filter = y % 5;

    raw[y * (stride + 1)] = filter;

    for (let x = 0; x < stride; x += 1) {
      const value = pixels[y * stride + x] ?? 0;
      const left = x >= channels ? (pixels[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;

      const upLeft =
        y > 0 && x >= channels
          ? (pixels[(y - 1) * stride + x - channels] ?? 0)
          : 0;

      const predicted = [
        0,
        left,
        up,
        Math.floor((left + up) / 2),
        paeth(left, up, upLeft),
      ][filter];

      raw[y * (stride + 1) + 1 + x] = (value - (predicted ?? 0) + 256) % 256;
    }
  }

  const header = Buffer.alloc(13);

  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = alpha ? 6 : 2;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

type Colour = readonly [number, number, number];

const GROUND: Colour = [17, 17, 17];

const PANEL: Colour = [33, 33, 33];

const TEXT: Colour = [236, 236, 234];

/** The fixture's own colour at a point: a lighter panel on the ground, with a band of "text". */
const baseAt = (x: number, y: number): Colour => {
  const panel = x >= 32 && x < 96 && y >= 16 && y < 80;

  if (!panel) {
    return GROUND;
  }

  return y >= 40 && y < 44 && x % 3 !== 0 ? TEXT : PANEL;
};

/** A 128 by 96 device px picture: a dark ground, a lighter panel and a band of "text". */
const picture = (
  edit: (x: number, y: number) => Colour | null = () => null,
  width = 128,
  height = 96
): Image => {
  const rgba = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = edit(x, y) ?? baseAt(x, y);
      const at = (y * width + x) * 4;

      rgba[at] = red;
      rgba[at + 1] = green;
      rgba[at + 2] = blue;
      rgba[at + 3] = 255;
    }
  }

  return { width, height, rgba };
};

/** The fingerprint cell for scale 2 pictures: 16 CSS px. */
const CELL = 32;

const frozenRound = (png: Buffer, tokensText = tokens): FrozenRound => ({
  round: 7,
  page: "https://plans.gneiss.run/cairn/v2/look/round-7/",
  commit: "fixture",
  tokens: { path: TOKENS_PATH, sha256: sha256(tokensText) },
  allowance: ALLOWANCE,
  shots: [
    {
      state: "thread",
      width: 390,
      theme: "dark",
      scale: 2,
      sha256: sha256(png),
      fingerprint: fingerprintOf(decodePng(png), CELL),
    },
  ],
});

/** tokens.css with one token's first value replaced. */
const withToken = (name: string, value: string): string => {
  const pattern = new RegExp(`(${name}:\\s*)[^;]+;`, "u");

  expect(tokens).toMatch(pattern);

  return tokens.replace(pattern, `$1${value};`);
};

describe(decodePng, () => {
  it("reads RGBA and RGB with every row filter", () => {
    const image = picture((x, y) => [
      (x * 7 + y) % 256,
      (y * 5) % 256,
      (x * y) % 256,
    ]);

    for (const alpha of [true, false]) {
      const decoded = decodePng(encodePng(image, alpha));

      expect(decoded.width).toBe(image.width);
      expect(decoded.height).toBe(image.height);
      expect([...decoded.rgba]).toStrictEqual([...image.rgba]);
    }
  });

  it("refuses what is not a PNG", () => {
    expect(() => decodePng(Buffer.from("not a png at all"))).toThrow(
      "not a PNG"
    );
  });
});

describe("a frozen fixture round", () => {
  const png = encodePng(picture(), true);
  const round = frozenRound(png);

  it("passes as frozen, and round-trips through its file", () => {
    expect(tokensFinding(round, tokens)).toBeUndefined();

    const [shot] = round.shots;

    expect(
      shot === undefined ? undefined : shotVerdict(shot, png)
    ).toMatchObject({
      pass: true,
      exact: true,
    });
    expect(parseFrozenRound(formatFrozenRound(round))).toStrictEqual(round);
  });

  it("fails when a token changes", () => {
    const changed = withToken("--ink-1", "#fefefe");

    expect(changed).not.toBe(tokens);
    expect(tokensFinding(round, changed)).toMatch(
      /^apps\/web\/src\/next\/tokens\.css hashes [0-9a-f]{12}, round 7 froze [0-9a-f]{12}: a token changed/u
    );
    expect(
      tokensFinding(round, withToken("--radius-small", "7px"))
    ).toBeDefined();
  });

  it("fails when one cell's mean moves by one level", () => {
    // The ground one level lighter across the top left 32 px cell, and nowhere else.
    const drifted = encodePng(
      picture((x, y) => (x < 32 && y < 32 ? [18, 18, 18] : null)),
      true
    );

    const [shot] = round.shots;
    const verdict = shot === undefined ? undefined : shotVerdict(shot, drifted);

    expect(verdict).toMatchObject({ pass: false, exact: false });
    expect(verdict?.drift).toMatchObject({
      sameSize: true,
      cells: 1,
      maxLevels: 1,
      box: { x: 0, y: 0, width: 16, height: 16 },
    });
  });

  it("passes a change that moves no cell's mean, within the allowance", () => {
    // One pixel moved by 3 levels: 3 / 1,024 of a level in its cell's mean.
    const nudged = encodePng(
      picture((x, y) => (x === 5 && y === 5 ? [20, 20, 20] : null)),
      true
    );

    const [shot] = round.shots;
    const verdict = shot === undefined ? undefined : shotVerdict(shot, nudged);

    expect(verdict).toMatchObject({ pass: true, exact: false });
    expect(verdict?.drift?.maxLevels).toBe(0);
  });

  it("fails when the shot changes size", () => {
    const [shot] = round.shots;

    const taller = encodePng(
      picture(() => null, 128, 128),
      true
    );

    expect(
      shot === undefined ? undefined : shotVerdict(shot, taller)
    ).toMatchObject({ pass: false, detail: "the shot changed size" });
  });

  it("measures drift in CSS px at the shot's scale", () => {
    const before = fingerprintOf(picture(), CELL);

    const after = fingerprintOf(
      picture((x) => (x >= 96 ? [200, 0, 0] : null)),
      CELL
    );

    expect(driftOf(before, after, 2).box).toStrictEqual({
      x: 48,
      y: 0,
      width: 16,
      height: 48,
    });
  });

  it("judges only the newest of several rounds", () => {
    expect(
      newestRound([
        { ...round, round: 2 },
        { ...round, round: 4 },
        { ...round, round: 3 },
      ])?.round
    ).toBe(4);
    expect(newestRound([])).toBeUndefined();
  });
});

describe("the checked-in frozen rounds", () => {
  const dir = path.join(root, "judges/look/frozen");

  const rounds = existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => /^round-\d+\.json$/u.test(file))
        .map((file) =>
          parseFrozenRound(readFileSync(path.join(dir, file), "utf-8"))
        )
    : [];

  // Nothing is frozen until the user approves a round; then a token changed without a new round
  // fails here, in `pnpm check`, as well as in `look.ts check`.
  it("hold today's tokens.css to the newest round", () => {
    const newest = newestRound(rounds);

    expect(
      newest === undefined ? undefined : tokensFinding(newest, tokens)
    ).toBeUndefined();
  });
});
