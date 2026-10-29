// Contrast judge (plan look track L2, surfaces note "Tokens and where they live", ADR 0040): every
// text and background pair `apps/web/src/next/tokens.css` names meets WCAG AA in both themes for
// every candidate look, and the `next` views use no colour but the tokens.
//
// The pairs come from the token names (the families tokens.css's header lists), so a token added
// to a family joins its pairs without editing this file. Text is 4.5:1 (WCAG 1.4.3, AA for normal
// text); the focus ring and the accent fill are 3:1 (1.4.11, non-text). Each text token is read
// on every surface, alone and under each selection-ladder step; every ink is read on the accent
// wash and on each tone's wash, and each tone and --ink-1 on its wash under each ladder step too
// (a chip on a selected row); the focus ring on every surface, ladder step and wash.
// Translucent text and grounds are composited the way CSS draws them: `color-mix(in srgb, ...)`
// mixes with premultiplied alpha, a translucent ground sits on an opaque surface, and the text sits
// on the result. A planted 40 percent ink must fail, so the judge cannot pass by reading nothing.
//
// Both elements `data-ui="next"` marks, <html> and #root, must resolve the same values: the dark
// rules name `.dark[data-ui="next"]` for <html> and `.dark [data-ui="next"]` for #root.
//
// The second half is the class-string lint: no palette utility (`text-amber-500`, `bg-white`,
// `drop-shadow-blue-400`; the palettes are read from the installed Tailwind's theme.css), no
// arbitrary colour (`bg-[#fff]`, `bg-[red]`), no colour literal (hex, `rgb()`, `hsl()`,
// `oklch()`...) and no named colour in a colour property (`{ color: "white" }`, `fill: red`) in
// `next/` outside tokens.css. The token forms `text-(--ink-2)` and `text-[color:var(--ink-2)]`
// pass. Comments and tests are skipped.
//
// `CONTRAST_REPORT=1` prints each candidate's lowest text and non-text ratios.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

const root = path.join(import.meta.dirname, "..");

const nextDirectory = path.join(root, "apps/web/src/next");

const tokensPath = path.join(nextDirectory, "tokens.css");

const TEXT_RATIO = 4.5;

const NON_TEXT_RATIO = 3;

// ---------------------------------------------------------------------------------------------
// Reading tokens.css

/** One rule of the file: its selectors, its declarations, and whether an at-rule wraps it. */
interface Rule {
  readonly selectors: ReadonlyArray<string>;
  readonly declarations: ReadonlyArray<readonly [string, string]>;
  readonly wrapped: boolean;
}

const withoutCssComments = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//gu, "");

/** `text` split on `separator` where no parenthesis is open, without empty parts. */
const splitTopLevel = (
  text: string,
  separator: string
): ReadonlyArray<string> => {
  const parts: Array<string> = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    } else if (character === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(text.slice(start));

  return parts.flatMap((part) => {
    const trimmed = part.trim();

    return trimmed.length === 0 ? [] : [trimmed];
  });
};

/** A block's declarations, split on semicolons outside parentheses. */
const parseDeclarations = (
  block: string
): ReadonlyArray<readonly [string, string]> =>
  splitTopLevel(block, ";").flatMap((declaration) => {
    const colon = declaration.indexOf(":");

    return colon === -1
      ? []
      : [
          [
            declaration.slice(0, colon).trim(),
            declaration
              .slice(colon + 1)
              .replaceAll(/\s+/gu, " ")
              .trim(),
          ] as const,
        ];
  });

/** The rules of a stylesheet with no nesting beyond at-rules around style rules. */
const parseRules = (text: string): ReadonlyArray<Rule> => {
  const rules: Array<Rule> = [];
  const source = withoutCssComments(text);
  const atRuleDepths: Array<number> = [];
  let depth = 0;
  let start = 0;
  let selector = "";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (character === "{") {
      const prelude = source.slice(start, index).trim();

      if (prelude.startsWith("@")) {
        atRuleDepths.push(depth);
      } else {
        selector = prelude;
      }

      depth += 1;
      start = index + 1;
    } else if (character === "}") {
      depth -= 1;

      if (atRuleDepths.at(-1) === depth) {
        atRuleDepths.pop();
      } else {
        rules.push({
          selectors: selector.split(",").map((part) => part.trim()),
          declarations: parseDeclarations(source.slice(start, index)),
          wrapped: atRuleDepths.length > 0,
        });
      }

      start = index + 1;
    }
  }

  return rules;
};

type Theme = "light" | "dark";

/** The two elements `data-ui="next"` marks: <html>, which carries the `dark` class, and #root. */
type Element = "html" | "root";

const ELEMENTS: ReadonlyArray<Element> = ["html", "root"];

/** What a selector applies to: a candidate (`default` when no `data-look`) and a theme. */
interface Scope {
  readonly look: string;
  readonly theme: Theme;
}

/** A selector's scope and the elements it matches. */
interface Target {
  readonly scope: Scope;
  readonly elements: ReadonlyArray<Element>;
}

const SELECTOR =
  /^(?:(?<dark>\.dark)(?<descendant>\s+)?)?\[data-ui="next"\](?:\[data-look="(?<look>[a-z-]+)"\])?$/u;

/** The scope a selector names and what it matches, or undefined when tokens.css should not hold it. */
const targetOf = (selector: string): Target | undefined => {
  const match = SELECTOR.exec(selector);

  if (match === null) {
    return undefined;
  }

  const look = match.groups?.look ?? "default";

  if (match.groups?.dark === undefined) {
    return { scope: { look, theme: "light" }, elements: ELEMENTS };
  }

  // `.dark[data-ui]` is <html> itself; `.dark [data-ui]` is a descendant, so #root only.
  return {
    scope: { look, theme: "dark" },
    elements: match.groups.descendant === undefined ? ["html"] : ["root"],
  };
};

/** Colour tokens: the families the pairs are drawn from. */
// (`--accent` and `--accent-foreground` are classic names the bridge sets, not tokens.)
const COLOUR_TOKEN =
  /^--(?:surface-|ink-|stroke-|select-|tone-|accent-(?:fill|ink|text|wash)$|scrim$|shadow-color$)/u;

/** The parsed file: candidates in source order, and the declarations each scope resolves to. */
interface Tokens {
  readonly looks: ReadonlyArray<string>;
  readonly unscoped: ReadonlyArray<string>;
  readonly wrappedColours: ReadonlyArray<string>;
  readonly declared: (
    scope: Scope,
    element?: Element
  ) => ReadonlyMap<string, string>;
  readonly resolved: (
    scope: Scope,
    element?: Element
  ) => ReadonlyMap<string, string>;
}

const readTokens = (text: string): Tokens => {
  const rules = parseRules(text);

  const scoped = rules
    .filter((rule) => !rule.wrapped)
    .flatMap((rule) =>
      rule.selectors.flatMap((selector) => {
        const target = targetOf(selector);

        return target === undefined ? [] : [{ ...target, rule }];
      })
    );

  const looks = [
    ...new Set(
      scoped.map(({ scope }) => scope.look).filter((look) => look !== "default")
    ),
  ];

  const unscoped = rules.flatMap((rule) =>
    rule.selectors.filter((selector) => targetOf(selector) === undefined)
  );

  const wrappedColours = rules
    .filter((rule) => rule.wrapped)
    .flatMap((rule) =>
      rule.declarations
        .map(([name]) => name)
        .filter((name) => COLOUR_TOKEN.test(name))
    );

  // The declarations one exact scope's rules hold on one element, later rules winning.
  const declared = (
    scope: Scope,
    element: Element = "root"
  ): ReadonlyMap<string, string> =>
    new Map(
      scoped
        .filter(
          (entry) =>
            entry.scope.look === scope.look &&
            entry.scope.theme === scope.theme &&
            entry.elements.includes(element)
        )
        .flatMap(({ rule }) => rule.declarations)
    );

  // The cascade for an element with `data-look` set to `scope.look`, by specificity: the default
  // light rules (0,1,0), then the default dark and the look's light rules (0,2,0, in source order;
  // every look block follows the default ones), then the look's dark rules (0,3,0). Both dark
  // forms have the same specificity, so <html> and #root follow the same order.
  const resolved = (
    scope: Scope,
    element: Element = "root"
  ): ReadonlyMap<string, string> => {
    const layers: Array<Scope> = [{ look: "default", theme: "light" }];

    if (scope.theme === "dark") {
      layers.push({ look: "default", theme: "dark" });
    }

    if (scope.look !== "default") {
      layers.push({ look: scope.look, theme: "light" });

      if (scope.theme === "dark") {
        layers.push({ look: scope.look, theme: "dark" });
      }
    }

    return new Map(layers.flatMap((layer) => [...declared(layer, element)]));
  };

  return { looks, unscoped, wrappedColours, declared, resolved };
};

// ---------------------------------------------------------------------------------------------
// Colour

/** An sRGB colour with straight alpha, every channel in [0, 1]. */
interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

const parseHex = (hex: string): Rgba => {
  const digits = hex.slice(1);

  const full = digits.length <= 4 ? digits.replaceAll(/./gu, "$&$&") : digits;

  const channel = (index: number): number =>
    Number.parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;

  return {
    r: channel(0),
    g: channel(1),
    b: channel(2),
    a: full.length === 8 ? channel(3) : 1,
  };
};

/** `color-mix(in srgb, a p%, b q%)`, mixed premultiplied as CSS Color 5 says. */
const mix = (
  first: Rgba,
  firstShare: number | undefined,
  second: Rgba,
  secondShare: number | undefined
): Rgba => {
  const p1 = firstShare ?? (secondShare === undefined ? 50 : 100 - secondShare);
  const p2 = secondShare ?? 100 - p1;
  const sum = p1 + p2;
  const w1 = p1 / sum;
  const w2 = p2 / sum;
  const alpha = first.a * w1 + second.a * w2;
  const scale = sum < 100 ? sum / 100 : 1;

  if (alpha === 0) {
    return TRANSPARENT;
  }

  const channel = (key: "r" | "g" | "b"): number =>
    (first[key] * first.a * w1 + second[key] * second.a * w2) / alpha;

  return {
    r: channel("r"),
    g: channel("g"),
    b: channel("b"),
    a: alpha * scale,
  };
};

/** `top` drawn over `bottom`. */
const over = (top: Rgba, bottom: Rgba): Rgba => {
  const alpha = top.a + bottom.a * (1 - top.a);

  if (alpha === 0) {
    return TRANSPARENT;
  }

  const channel = (key: "r" | "g" | "b"): number =>
    (top[key] * top.a + bottom[key] * bottom.a * (1 - top.a)) / alpha;

  return { r: channel("r"), g: channel("g"), b: channel("b"), a: alpha };
};

/** An sRGB channel in linear light. */
const linear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

/** WCAG 2 relative luminance of an opaque colour. */
const luminance = (colour: Rgba): number =>
  0.2126 * linear(colour.r) +
  0.7152 * linear(colour.g) +
  0.0722 * linear(colour.b);

/** WCAG 2 contrast ratio of two opaque colours. */
const contrast = (first: Rgba, second: Rgba): number => {
  const one = luminance(first);
  const other = luminance(second);

  return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
};

const SHARE = /^(?<colour>.+?)\s+(?<share>[\d.]+)%$/u;

/** A token's value as a colour, resolving `var()` in its scope. Throws on anything else. */
const evaluate = (
  value: string,
  scope: ReadonlyMap<string, string>,
  seen: ReadonlySet<string> = new Set()
): Rgba => {
  const text = value.trim();

  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/iu.test(text)) {
    return parseHex(text);
  }

  if (text === "transparent") {
    return TRANSPARENT;
  }

  const reference = /^var\((?<name>--[\w-]+)\)$/u.exec(text);

  if (reference !== null) {
    const name = reference.groups?.name ?? "";
    const referenced = scope.get(name);

    if (referenced === undefined || seen.has(name)) {
      throw new Error(`cannot resolve ${text}`);
    }

    return evaluate(referenced, scope, new Set([...seen, name]));
  }

  const mixed = /^color-mix\((?<body>.*)\)$/u.exec(text);

  if (mixed !== null) {
    const [space, first, second] = splitTopLevel(mixed.groups?.body ?? "", ",");

    if (space !== "in srgb" || first === undefined || second === undefined) {
      throw new Error(`only color-mix(in srgb, a, b) is read: ${text}`);
    }

    const part = (
      argument: string
    ): { readonly colour: Rgba; readonly share: number | undefined } => {
      const shared = SHARE.exec(argument);

      return shared === null
        ? { colour: evaluate(argument, scope, seen), share: undefined }
        : {
            colour: evaluate(shared.groups?.colour ?? "", scope, seen),
            share: Number(shared.groups?.share),
          };
    };

    const left = part(first);
    const right = part(second);

    return mix(left.colour, left.share, right.colour, right.share);
  }

  throw new Error(`not a colour tokens.css may use: ${text}`);
};

// ---------------------------------------------------------------------------------------------
// Pairs

/** One judged pair: a foreground over a stack of grounds, bottom first, and its floor. */
interface Pair {
  readonly text: string;
  readonly ground: ReadonlyArray<string>;
  readonly floor: number;
}

/** Each text token over one stack of grounds, at the text floor. */
const textOn = (
  texts: ReadonlyArray<string>,
  ground: ReadonlyArray<string>
): ReadonlyArray<Pair> =>
  texts.map((text) => ({ text, ground, floor: TEXT_RATIO }));

/** The focus ring over one stack of grounds, at the non-text floor. */
const focusOn = (ground: ReadonlyArray<string>): Pair => ({
  text: "--stroke-focus",
  ground,
  floor: NON_TEXT_RATIO,
});

/** The pairs a scope's names call for, by family (tokens.css's header). */
const pairsOf = (names: ReadonlyArray<string>): ReadonlyArray<Pair> => {
  const family = (pattern: RegExp): ReadonlyArray<string> =>
    names.filter((name) => pattern.test(name));

  const surfaces = family(/^--surface-/u);
  const ladder = family(/^--select-\d+$/u);
  const tones = family(/^--tone-[a-z]+$/u);
  const inks = family(/^--ink-\d+$/u);

  const texts = [...inks, ...family(/^--accent-text$/u), ...tones];

  return surfaces.flatMap((surface) => [
    ...textOn(texts, [surface]),
    ...ladder.flatMap((step) => textOn(texts, [surface, step])),
    ...textOn([...inks, "--accent-text"], [surface, "--accent-wash"]),
    ...tones.flatMap((tone) => [
      ...textOn([tone, ...inks], [surface, `${tone}-wash`]),
      ...ladder.flatMap((step) =>
        textOn([tone, "--ink-1"], [surface, step, `${tone}-wash`])
      ),
    ]),
    ...textOn(["--accent-ink"], [surface, "--accent-fill"]),
    { text: "--accent-fill", ground: [surface], floor: NON_TEXT_RATIO },
    focusOn([surface]),
    ...ladder.map((step) => focusOn([surface, step])),
    focusOn([surface, "--accent-wash"]),
    ...tones.map((tone) => focusOn([surface, `${tone}-wash`])),
  ]);
};

interface Judged extends Pair {
  readonly ratio: number;
}

/** Every pair of one candidate in one theme, with its ratio. */
const judge = (tokens: Tokens, scope: Scope): ReadonlyArray<Judged> => {
  const values = tokens.resolved(scope);

  const colour = (name: string): Rgba => {
    const value = values.get(name);

    if (value === undefined) {
      throw new Error(`${scope.look} ${scope.theme} has no ${name}`);
    }

    return evaluate(value, values);
  };

  return pairsOf([...values.keys()]).map((pair) => {
    const [base, ...layers] = pair.ground.map(colour);

    if (base === undefined || base.a !== 1) {
      throw new Error(`${pair.ground[0]} is not opaque`);
    }

    let ground = base;

    for (const layer of layers) {
      ground = over(layer, ground);
    }

    return {
      ...pair,
      ratio: contrast(over(colour(pair.text), ground), ground),
    };
  });
};

/** The pairs under their floor, as readable lines. */
const failures = (tokens: Tokens, scope: Scope): ReadonlyArray<string> =>
  judge(tokens, scope)
    .filter((pair) => pair.ratio < pair.floor)
    .map(
      (pair) =>
        `${scope.look} ${scope.theme}: ${pair.text} on ${pair.ground.join(" + ")} is ${pair.ratio.toFixed(2)}, under ${pair.floor}`
    );

const THEMES: ReadonlyArray<Theme> = ["light", "dark"];

const colourNames = (
  declarations: ReadonlyMap<string, string>
): ReadonlyArray<string> =>
  [...declarations.keys()].filter((name) => COLOUR_TOKEN.test(name)).toSorted();

/** Replaces one declaration's value inside the block whose selector list starts with `selector`. */
const plant = (
  text: string,
  selector: string,
  name: string,
  value: string
): string => {
  const blockStart = text.indexOf(selector);
  const at = text.indexOf(`${name}:`, blockStart);
  const end = text.indexOf(";", at);

  assert.isAbove(blockStart, -1, `no block ${selector}`);
  assert.isAbove(at, blockStart, `no ${name} in ${selector}`);

  return `${text.slice(0, at)}${name}: ${value}${text.slice(end)}`;
};

const tokensText = readFileSync(tokensPath, "utf-8");

const tokens = readTokens(tokensText);

describe("contrast of the next tokens", () => {
  it("reads colours the way CSS draws them", () => {
    const white = parseHex("#ffffff");
    const black = parseHex("#000");

    assert.closeTo(contrast(white, black), 21, 1e-9);
    assert.closeTo(contrast(parseHex("#777777"), white), 4.48, 0.01);

    // A 40 percent white over black is the same grey as the 40/60 opaque mix.
    const translucent = evaluate(
      "color-mix(in srgb, #ffffff 40%, transparent)",
      new Map()
    );

    assert.closeTo(translucent.a, 0.4, 1e-9);
    assert.closeTo(translucent.r, 1, 1e-9);
    assert.deepStrictEqual(
      over(translucent, black),
      evaluate("color-mix(in srgb, #ffffff 40%, #000000)", new Map())
    );
    assert.closeTo(
      evaluate(
        "color-mix(in srgb, var(--a) 25%, #000000)",
        new Map([["--a", "#ffffff"]])
      ).r,
      0.25,
      1e-9
    );
  });

  it("holds only rules scoped to the next frame, with no colour behind an at-rule", () => {
    assert.deepStrictEqual(tokens.unscoped, []);
    assert.deepStrictEqual(tokens.wrappedColours, []);
  });

  it("offers three candidates, each defining every colour name in both themes", () => {
    assert.deepStrictEqual(tokens.looks, ["graphite", "ink", "stone"]);

    const expected = colourNames(
      tokens.declared({ look: "default", theme: "light" })
    );

    assert.isAbove(expected.length, 30);

    for (const look of tokens.looks) {
      for (const theme of THEMES) {
        assert.deepStrictEqual(
          colourNames(tokens.declared({ look, theme })),
          expected,
          `${look} ${theme}`
        );
      }
    }
  });

  it("draws graphite when no candidate is set", () => {
    for (const theme of THEMES) {
      assert.deepStrictEqual(
        tokens.resolved({ look: "default", theme }),
        tokens.resolved({ look: "graphite", theme })
      );
    }
  });

  it("resolves the same values on <html> and #root, in both themes, for every candidate", () => {
    for (const look of ["default", ...tokens.looks]) {
      for (const theme of THEMES) {
        assert.deepStrictEqual(
          tokens.resolved({ look, theme }, "html"),
          tokens.resolved({ look, theme }, "root"),
          `${look} ${theme}`
        );
      }
    }

    // A dark rule naming only the descendant form leaves <html> on the light values.
    const rootOnly = readTokens(
      tokensText.replace('.dark[data-ui="next"][data-look="stone"],\n', "")
    );

    assert.notDeepEqual(
      rootOnly.resolved({ look: "stone", theme: "dark" }, "html"),
      rootOnly.resolved({ look: "stone", theme: "dark" }, "root")
    );
  });

  it("meets AA for every named pair, in both themes, for every candidate", () => {
    const report: Array<string> = [];

    const found = tokens.looks.flatMap((look) =>
      THEMES.flatMap((theme) => {
        const judged = judge(tokens, { look, theme });

        const lowest = (floor: number): Judged | undefined =>
          judged
            .filter((pair) => pair.floor === floor)
            .toSorted((a, b) => a.ratio - b.ratio)[0];

        const text = lowest(TEXT_RATIO);
        const nonText = lowest(NON_TEXT_RATIO);

        report.push(
          `${look} ${theme}: ${judged.length} pairs; lowest text ${text?.ratio.toFixed(2)} (${text?.text} on ${text?.ground.join(" + ")}); lowest non-text ${nonText?.ratio.toFixed(2)} (${nonText?.text} on ${nonText?.ground.join(" + ")})`
        );

        return failures(tokens, { look, theme });
      })
    );

    if (process.env.CONTRAST_REPORT === "1") {
      console.log(report.join("\n"));
    }

    assert.deepStrictEqual(found, []);
  });

  it("fails a planted 40 percent ink, a missing token and an unreadable value", () => {
    const faint = readTokens(
      plant(
        tokensText,
        '.dark [data-ui="next"],',
        "--ink-3",
        "color-mix(in srgb, #f5f5f5 40%, transparent)"
      )
    );

    const found = failures(faint, { look: "graphite", theme: "dark" });

    assert.isAbove(found.length, 0);
    assert.isTrue(found.every((line) => line.includes("--ink-3 on")));
    assert.deepStrictEqual(
      failures(faint, { look: "graphite", theme: "light" }),
      []
    );

    const faintLight = readTokens(
      plant(
        tokensText,
        '[data-look="stone"] {\n  color-scheme: light',
        "--ink-2",
        "color-mix(in srgb, #2a2420 40%, transparent)"
      )
    );

    assert.isAbove(
      failures(faintLight, { look: "stone", theme: "light" }).length,
      0
    );

    const missing = readTokens(
      tokensText.replace(/^ {2}--tone-done-wash:.*$/mu, "")
    );

    assert.notDeepEqual(
      colourNames(missing.declared({ look: "default", theme: "light" })),
      colourNames(missing.declared({ look: "ink", theme: "light" }))
    );

    const unreadable = readTokens(
      plant(tokensText, '.dark [data-ui="next"],', "--ink-1", "oklch(0.9 0 0)")
    );

    assert.throws(() => {
      judge(unreadable, { look: "graphite", theme: "dark" });
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The class-string lint

/**
 * The colour names the installed Tailwind's theme ships: the palettes with shades (`amber`,
 * `taupe`...) and the bare colours (`black`, `white`). Read from theme.css, so the lint cannot fall
 * behind a Tailwind upgrade.
 */
interface TailwindColours {
  readonly shaded: ReadonlyArray<string>;
  readonly bare: ReadonlyArray<string>;
}

const tailwindColours = (): TailwindColours => {
  const theme = readFileSync(
    path.join(root, "apps/web/node_modules/tailwindcss/theme.css"),
    "utf-8"
  );

  const names = [
    ...theme.matchAll(/--color-(?<name>[a-z]+)(?<shade>-\d+)?:/gu),
  ];

  const pick = (shaded: boolean): ReadonlyArray<string> => [
    ...new Set(
      names.flatMap((match) =>
        (match.groups?.shade !== undefined) === shaded
          ? [match.groups?.name ?? ""]
          : []
      )
    ),
  ];

  return { shaded: pick(true), bare: pick(false) };
};

const TAILWIND_COLOURS = tailwindColours();

const PALETTE = TAILWIND_COLOURS.shaded.join("|");

const BARE = TAILWIND_COLOURS.bare.join("|");

const UTILITY =
  "bg|text|border|border-[xytrbl]|border-[se]|ring|ring-offset|outline|fill|stroke|from|via|to|decoration|divide|placeholder|caret|accent|shadow|inset-shadow|inset-ring|text-shadow|drop-shadow";

/** CSS Color 4's named colours (`transparent` and `currentcolor` are not colours of their own). */
const NAMED =
  "aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen";

/** Properties, in CSS or a style object, whose value may hold a colour. */
const COLOUR_PROPERTY =
  "[\\w-]*(?:color|Color)|background|fill|stroke|border(?:-[a-z]+)?|outline|(?:box-|text-)?shadow|boxShadow|textShadow";

/** What `next/` code may not hold: palette utilities, arbitrary colours and colour literals. */
const FORBIDDEN: ReadonlyArray<RegExp> = [
  new RegExp(
    `(?<![\\w-])(?:${UTILITY})-(?:(?:${PALETTE})-\\d{2,3}|${BARE})(?![\\w-])`,
    "gu"
  ),
  new RegExp(
    `(?<![\\w-])(?:${UTILITY})-\\[(?:#|(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\\(|color:(?!var\\())`,
    "gu"
  ),
  new RegExp(`(?<![\\w-])(?:${UTILITY})-\\[(?:${NAMED})\\]`, "giu"),
  new RegExp(
    `(?<![\\w-])["']?(?:${COLOUR_PROPERTY})["']?\\s*:\\s*["'\`]?[^;"'\`}\\n]*?(?<![\\w-])(?:${NAMED})(?![\\w-])`,
    "gu"
  ),
  /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})(?![\w-])/giu,
  /(?<![\w-])(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(/giu,
];

const SCANNED = /\.(?:ts|css|html)$/u;

const nextFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return nextFiles(entryPath);
    }

    return SCANNED.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      entryPath !== tokensPath
      ? [entryPath]
      : [];
  });

/** The file's text without block, HTML and line comments. */
const withoutComments = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/<!--[\s\S]*?-->/gu, "")
    .replaceAll(/(?<before>^|[^:"'`\\])\/\/.*$/gmu, "$<before>");

/** The forbidden colours in a file's code. */
const coloursIn = (text: string): ReadonlyArray<string> => {
  const code = withoutComments(text);

  return FORBIDDEN.flatMap((pattern) =>
    [...code.matchAll(pattern)].map((match) => match[0])
  );
};

describe("colours in next", () => {
  it("finds palette utilities and literals in code, not in comments or token names", () => {
    assert.deepStrictEqual(
      coloursIn(
        'h.Class("flex text-amber-500 bg-white/50 hover:border-zinc-200")'
      ),
      ["text-amber-500", "bg-white", "border-zinc-200"]
    );
    assert.deepStrictEqual(
      coloursIn('h.Class("bg-[#0a0a0a] text-[rgb(0_0_0)]")'),
      ["bg-[#", "text-[rgb(", "#0a0a0a", "rgb("]
    );
    assert.deepStrictEqual(
      coloursIn("const shade = 'rgb(0 0 0 / 40%)'; const ink = \"#fff\";"),
      ["#fff", "rgb("]
    );
    assert.deepStrictEqual(
      coloursIn(
        'h.Class("text-mauve-500 bg-taupe-200/50 text-shadow-red-500 drop-shadow-blue-400")'
      ),
      [
        "text-mauve-500",
        "bg-taupe-200",
        "text-shadow-red-500",
        "drop-shadow-blue-400",
      ]
    );
    assert.deepStrictEqual(
      coloursIn('h.Class("bg-[red] text-[color:#fff] border-[White]")'),
      ["text-[color:", "bg-[red]", "border-[White]", "#fff"]
    );
    assert.deepStrictEqual(
      coloursIn(
        'h.Style({ color: "white", backgroundColor: \'tomato\' }); const css = "fill: red; border: 1px solid navy";'
      ),
      [
        'color: "white',
        "backgroundColor: 'tomato",
        '"fill: red',
        "border: 1px solid navy",
      ]
    );
    assert.deepStrictEqual(
      coloursIn(
        '// fixes #5566, was text-blue-500\nh.Id("root"); h.Class("bg-background text-ink-2 text-tone-waiting border-stroke-1 text-2xs text-(--ink-2) text-[color:var(--ink-2)] bg-transparent")\nh.Style({ color: "var(--ink-1)", outline: "none", background: "transparent" });\n'
      ),
      []
    );
  });

  it("reads every palette the installed Tailwind ships", () => {
    for (const name of ["amber", "zinc", "mauve", "olive", "mist", "taupe"]) {
      assert.include(TAILWIND_COLOURS.shaded, name);
    }

    assert.sameMembers([...TAILWIND_COLOURS.bare], ["black", "white"]);
  });

  it("finds none in next outside tokens.css", () => {
    const files = nextFiles(nextDirectory);

    const found = Object.fromEntries(
      files.flatMap((file) => {
        const colours = coloursIn(readFileSync(file, "utf-8"));

        return colours.length === 0
          ? []
          : [[path.relative(root, file), colours]];
      })
    );

    assert.isAbove(files.length, 0);
    assert.deepStrictEqual(found, {});
  });
});
