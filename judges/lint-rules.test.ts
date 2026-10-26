// Judges the vendored anti-slop rules (T63): for each rule, one probe the rule must flag and one it
// must leave alone, linted with the repo's own config in a real zone (apps/server/src/brain), all in
// one oxlint run. A rule that stops firing (a broken `createOnce`, a config that turns it off) or
// starts firing on ordinary code fails here, not in review. Probes a killed run left behind are
// swept first.
import { randomBytes } from "node:crypto";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { lint } from "./lib/Oxlint.ts";

const root = path.join(import.meta.dirname, "..");

const ZONE = "apps/server/src/brain";

interface RuleCase {
  /** The diagnostic code oxlint reports, plugin and rule. */
  readonly code: string;
  /** A module the rule must flag. */
  readonly fires: string;
  /** A module the rule must leave alone. */
  readonly quiet: string;
}

const cases: ReadonlyArray<RuleCase> = [
  {
    code: "anti-slop(no-array-filter-map)",
    fires:
      "export const f = (xs: ReadonlyArray<number>) => xs.filter((x) => x > 1).map((x) => x * 2);",
    quiet:
      "export const f = (xs: ReadonlyArray<number>) => xs.flatMap((x) => (x > 1 ? [x * 2] : []));",
  },
  {
    code: "anti-slop(no-chained-type-assertions)",
    fires: "export const f = (x: string) => x as unknown as number;",
    quiet: "export const f = (x: string) => x.length;",
  },
  {
    code: "anti-slop(no-conditional-empty-object-spread)",
    fires:
      "export const f = (on: boolean) => ({ a: 1, ...(on ? { b: 2 } : {}) });",
    quiet: "export const f = (on: boolean) => ({ a: 1, b: on ? 2 : 0 });",
  },
  {
    code: "anti-slop(no-known-value-widening)",
    fires: "const v: unknown = { a: 1 };\n\nexport const f = () => v;",
    quiet: "const v = { a: 1 };\n\nexport const f = () => v;",
  },
  {
    code: "anti-slop(no-module-mocking)",
    fires: 'import { vi } from "vitest";\n\nvi.mock("node:fs");\n\nexport {};',
    quiet: 'import { vi } from "vitest";\n\nexport const spy = vi.fn();',
  },
  {
    code: "anti-slop(no-object-parameters)",
    fires: "export const f = (value: object) => value;",
    quiet: "export const f = (value: { readonly a: number }) => value.a;",
  },
  {
    code: "anti-slop(no-reduce-accumulator-copy)",
    fires:
      "export const f = (xs: ReadonlyArray<number>) =>\n  xs.reduce<Array<number>>((acc, x) => acc.concat(x), []);",
    quiet: "export const f = (xs: ReadonlyArray<number>) => xs.map((x) => x);",
  },
  {
    code: "anti-slop(no-reflect-apply)",
    fires:
      "export const f = (g: (a: number) => number) => Reflect.apply(g, undefined, [1]);",
    quiet: "export const f = (g: (a: number) => number) => g(1);",
  },
  {
    code: "anti-slop(no-reflect-get)",
    fires:
      'export const f = (o: { readonly a: number }) => Reflect.get(o, "a");',
    quiet: "export const f = (o: { readonly a: number }) => o.a;",
  },
  {
    code: "anti-slop(no-runtime-typeof)",
    fires: 'export const f = (x: string | number) => typeof x === "string";',
    quiet: "export const f = (x: string | number) => String(x);",
  },
  {
    code: "anti-slop(no-shape-in-symbol-names)",
    fires: "export const userShape = { a: 1 };",
    quiet: "export const user = { a: 1 };",
  },
  {
    code: "anti-slop(no-unknown-parameters)",
    fires: "export const f = (value: unknown) => String(value);",
    quiet: "export const f = (value: string) => value;",
  },
  {
    code: "anti-slop(no-unknown-returns)",
    fires: "export const f = (x: string): unknown => x;",
    quiet: "export const f = (x: string): string => x;",
  },
  {
    code: "anti-slop(no-unknown-type-aliases)",
    fires: "export type Loose = unknown;",
    quiet: "export type Tight = string;",
  },
  {
    code: "anti-slop(no-unsafe-dictionary-type)",
    fires: "export const d: Record<string, unknown> = {};",
    quiet: "export const d: Record<string, number> = {};",
  },
  {
    code: "anti-slop(no-widen-then-assert)",
    fires:
      'export const f = () => {\n  const x: unknown = "a";\n\n  return (x as string).length;\n};',
    quiet:
      'export const f = () => {\n  const x = "a";\n\n  return x.length;\n};',
  },
  {
    code: "anti-slop(require-readable-spacing)",
    fires:
      "export const f = () => {\n  const a = 1;\n  if (a > 0) {\n    return a;\n  }\n\n  return 0;\n};",
    quiet:
      "export const f = () => {\n  const a = 1;\n\n  if (a > 0) {\n    return a;\n  }\n\n  return 0;\n};",
  },
  {
    code: "anti-slop(require-safety-comment-for-type-assertion)",
    fires: "export const f = (x: string | number) => x as string;",
    quiet:
      "export const f = (x: string | number) =>\n  // SAFETY: callers pass only strings here.\n  x as string;",
  },
  {
    code: "anti-slop-effect(no-manual-effect-error-tag)",
    fires:
      'import { Effect } from "effect";\n\nexport const f = (e: Effect.Effect<number, { readonly _tag: "A" } | { readonly _tag: "B" }>) =>\n  e.pipe(Effect.catch((error) => (error._tag === "A" ? Effect.succeed(1) : Effect.succeed(2))));',
    quiet:
      'import { Effect } from "effect";\n\nexport const f = (e: Effect.Effect<number, { readonly _tag: "A" }>) =>\n  e.pipe(Effect.catchTag("A", () => Effect.succeed(1)));',
  },
  {
    code: "anti-slop-effect(no-manual-tag-comparison)",
    fires:
      'export const f = (x: { readonly _tag: "A" } | { readonly _tag: "B" }) => x._tag === "A";',
    quiet:
      'import { Predicate } from "effect";\n\nexport const f = (x: { readonly _tag: "A" } | { readonly _tag: "B" }) => Predicate.isTagged(x, "A");',
  },
  {
    code: "anti-slop-effect(no-manual-tagged-construction)",
    fires:
      'import { Schema } from "effect";\n\nconst A = Schema.TaggedStruct("A", { n: Schema.Number });\n\nexport const a: typeof A.Type = { _tag: "A", n: 1 };',
    quiet:
      'import { Schema } from "effect";\n\nconst A = Schema.TaggedStruct("A", { n: Schema.Number });\n\nexport const a = A.make({ n: 1 });',
  },
  {
    code: "anti-slop-effect(no-service-constructor-imports)",
    fires:
      'import { makeThing } from "./Thing.ts";\n\nexport const t = makeThing;',
    quiet: 'import { Thing } from "./Thing.ts";\n\nexport const t = Thing;',
  },
  {
    code: "anti-slop-effect(prefer-effect-match)",
    fires:
      'export const f = (x: "a" | "b" | "c") => (x === "a" ? 1 : x === "b" ? 2 : 3);',
    quiet: 'export const f = (x: "a" | "b") => (x === "a" ? 1 : 2);',
  },
];

/** A probe file name, as `probeName` makes them. */
const PROBE_FILE = /^LintRuleProbe\d+[0-9a-f]{8}(?:Fires|Quiet)\d+\.ts$/u;

const sweepProbes = () => {
  for (const name of readdirSync(path.join(root, ZONE))) {
    if (PROBE_FILE.test(name)) {
      rmSync(path.join(root, ZONE, name));
    }
  }
};

describe("the anti-slop rules", () => {
  sweepProbes();

  it("flag each rule's firing probe and leave its quiet probe alone", () => {
    const id = `${process.pid}${randomBytes(4).toString("hex")}`;

    const probes = cases.flatMap((ruleCase, index) => [
      {
        ruleCase,
        fires: true,
        file: path.join(ZONE, `LintRuleProbe${id}Fires${index}.ts`),
        source: ruleCase.fires,
      },
      {
        ruleCase,
        fires: false,
        file: path.join(ZONE, `LintRuleProbe${id}Quiet${index}.ts`),
        source: ruleCase.quiet,
      },
    ]);

    let findings: ReturnType<typeof lint>;

    try {
      for (const probe of probes) {
        writeFileSync(path.join(root, probe.file), `${probe.source}\n`);
      }

      findings = lint(probes.map((probe) => probe.file));
    } finally {
      for (const probe of probes) {
        rmSync(path.join(root, probe.file), { force: true });
      }
    }

    const wrong = probes.flatMap((probe) => {
      const flagged = findings.some(
        (finding) =>
          finding.code === probe.ruleCase.code &&
          path.resolve(root, finding.filename) === path.join(root, probe.file)
      );

      return flagged === probe.fires
        ? []
        : [
            `${probe.ruleCase.code}: ${probe.fires ? "did not fire" : "fired on the quiet probe"}`,
          ];
    });

    assert.deepStrictEqual(wrong, []);
  });

  it("probe every rule the two plugins define", () => {
    const defined = [
      ["anti-slop", "tools/oxlint/anti-slop/rules"],
      ["anti-slop-effect", "tools/oxlint/anti-slop/effect/rules"],
    ].flatMap(([plugin, directory]) =>
      readdirSync(path.join(root, directory ?? ""))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => `${plugin}(${name.replace(/\.ts$/u, "")})`)
    );

    assert.sameMembers(
      cases.map((ruleCase) => ruleCase.code),
      defined
    );
  });
});
