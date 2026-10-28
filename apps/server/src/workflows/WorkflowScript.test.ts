import { createHash } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { isWorkflowSource, parseWorkflowScript } from "./WorkflowScript.ts";
import type { RefusalReason } from "./WorkflowScript.ts";

const META = `export const meta = {
  name: "review-modules",
  description: "Read each module, then verify",
  phases: [{ title: "Read" }, { title: "Verify", detail: "Fresh eyes" }],
};`;

/** A template literal interpolation, written so this file's own strings stay plain. */
const INTERPOLATION = ["$", "{n}"].join("");

const script = (body: string, meta = META) => `${meta}\n${body}`;

/** The reason a source is refused with, failing the test if it parses. */
const refusedWith = (source: string) =>
  parseWorkflowScript(source).pipe(
    Effect.flip,
    Effect.map((refusal) => ({
      reason: refusal.reason,
      message: refusal.message,
    }))
  );

const expectRefusal = (
  source: string,
  reason: RefusalReason,
  mentions?: string
) =>
  Effect.gen(function* () {
    const refusal = yield* refusedWith(source);

    assert.strictEqual(refusal.reason, reason, refusal.message);

    if (mentions !== undefined) {
      assert.include(refusal.message, mentions);
    }
  });

/** A refusal's reason and the decoder's part of its message: the advice after it names every field. */
const issue = (source: string) =>
  refusedWith(source).pipe(
    Effect.map(({ reason, message }) => ({
      reason,
      issue: message.split(". It needs")[0] ?? "",
    }))
  );

describe(parseWorkflowScript, () => {
  it.effect("reads a meta literal and hashes the source as submitted", () =>
    Effect.gen(function* () {
      const source = script('phase("Read");\nreturn 1;');
      const parsed = yield* parseWorkflowScript(source);

      assert.strictEqual(parsed.meta.name, "review-modules");
      assert.strictEqual(
        parsed.meta.description,
        "Read each module, then verify"
      );
      assert.deepStrictEqual(parsed.meta.phases, [
        { title: "Read", detail: null },
        { title: "Verify", detail: "Fresh eyes" },
      ]);
      assert.isTrue(Option.isNone(parsed.meta.whenToUse));
      assert.strictEqual(
        parsed.hash,
        `sha256-${createHash("sha256").update(source).digest("hex")}`
      );
      assert.isTrue(
        parsed.source.slice(parsed.exportAt).startsWith("export const meta")
      );
      assert.strictEqual(parsed.source.charAt(parsed.metaEnd - 1), ";");
    })
  );

  it.effect("tells two scripts apart by a single byte", () =>
    Effect.gen(function* () {
      const one = yield* parseWorkflowScript(script("return 1;"));
      const two = yield* parseWorkflowScript(script("return 2;"));

      assert.notStrictEqual(one.hash, two.hash);
    })
  );

  it.effect("accepts the literal forms JavaScript writes by hand", () =>
    Effect.gen(function* () {
      const parsed = yield* parseWorkflowScript(`// a header comment
/* and a block one */
export const meta = {
  // comments inside
  'name': 'quoted-keys',
  description: \`a template \\u00e9 without interpolation\`,
  whenToUse: "line one\\nline two \\x41 \\u{1F600}",
  phases: [
    { title: 'Trailing', detail: null === null ? undefined : "x" },
  ],
}
return 1;`).pipe(Effect.flip);

      // `null === null ? ...` is an expression, not a literal.
      assert.strictEqual(parsed.reason, "meta_not_literal");

      const plain = yield* parseWorkflowScript(`// a header comment
/* and a block one */
export const meta = {
  // comments inside
  'name': 'quoted-keys',
  description: \`a template \\u00e9 without interpolation\`,
  whenToUse: "line one\\nline two \\x41 \\u{1F600}",
  phases: [
    { title: 'Trailing', },
  ],
}
return 1;`);

      assert.strictEqual(plain.meta.name, "quoted-keys");
      assert.strictEqual(
        plain.meta.description,
        "a template é without interpolation"
      );
      assert.deepStrictEqual(
        plain.meta.whenToUse,
        Option.some("line one\nline two A \u{1F600}")
      );
      assert.deepStrictEqual(plain.meta.phases, [
        { title: "Trailing", detail: null },
      ]);
    })
  );

  it.effect("keeps an options line and points past it", () =>
    Effect.gen(function* () {
      const source = `// @options: {"max_output_tokens": 2000}\n${META}\nreturn 1;`;
      const parsed = yield* parseWorkflowScript(source);

      assert.isTrue(
        source.slice(parsed.exportAt).startsWith("export const meta")
      );
      assert.strictEqual(parsed.source, source);
    })
  );

  it.effect("refuses a script that sets its own deadline", () =>
    expectRefusal(
      `// @options: {"timeout_ms": 60000}\n${META}\nreturn 1;`,
      "sets_timeout",
      "timeout_ms"
    )
  );

  it.effect("refuses a malformed options line", () =>
    expectRefusal(`// @options: {"speed": 1}\n${META}`, "source_unreadable")
  );

  it.effect("refuses a script whose first statement is not the meta", () =>
    Effect.gen(function* () {
      yield* expectRefusal("const x = 1;\nreturn x;", "not_a_workflow");
      yield* expectRefusal(
        script("return 1;", `const y = 2;\n${META}`),
        "not_a_workflow"
      );
      yield* expectRefusal(
        'export const notMeta = { name: "x" };',
        "not_a_workflow"
      );
    })
  );

  it.effect("refuses every way meta stops being a pure literal", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string]> = [
        [
          'export const meta = { name: NAME, description: "d" };',
          "`NAME` is a name",
        ],
        [
          'export const meta = { name: make("x"), description: "d" };',
          "`make` is a name",
        ],
        [
          'export const meta = { ...base, name: "x", description: "d" };',
          "spread",
        ],
        [
          'export const meta = { name: "x", description: "d", phases: [...more] };',
          "spread",
        ],
        [
          'export const meta = { ["name"]: "x", description: "d" };',
          "computed key",
        ],
        [
          `export const meta = { name: \`x-${INTERPOLATION}\`, description: "d" };`,
          "interpolation",
        ],
        ['export const meta = { name, description: "d" };', "shorthand"],
        [
          'export const meta = { name: "x", description() { return "d"; } };',
          "shorthand",
        ],
        [
          'export const meta = { name: "x", description: "d" }.valueOf();',
          "end its statement",
        ],
        [
          'export const meta = { name: "x", description: "d" }\n(other)',
          "end its statement",
        ],
        ["export const meta = build();", "object literal"],
        [
          'export const meta = { name: "x", description: "d", n: 0x10 };',
          "decimal",
        ],
        [
          'export const meta = { name: "x", name: "y", description: "d" };',
          "appears twice",
        ],
        ['export const meta = { name: "x", description: "d" ', "ends early"],
      ];

      for (const [source, mentions] of cases) {
        yield* expectRefusal(source, "meta_not_literal", mentions);
      }
    })
  );

  it.effect(
    "refuses a meta literal that is not a valid meta, naming the fields",
    () =>
      Effect.gen(function* () {
        const missing = yield* issue('export const meta = { name: "x" };');

        assert.strictEqual(missing.reason, "meta_invalid");
        assert.include(missing.issue, '["description"]');
        assert.notInclude(missing.issue, '["name"]');

        const badName = yield* issue(
          'export const meta = { name: "Review Modules", description: "d" };'
        );

        assert.strictEqual(badName.reason, "meta_invalid");
        assert.include(badName.issue, '["name"]');
        assert.notInclude(badName.issue, '["description"]');
        yield* expectRefusal(
          'export const meta = { name: "x", description: "d", phases: [{ title: "A", model: "opus" }] };',
          "meta_invalid",
          "model"
        );
        yield* expectRefusal(
          'export const meta = { name: "x", description: "d", owner: "me" };',
          "meta_invalid",
          "owner"
        );
      })
  );

  it.effect(
    "refuses a second export and any import, wherever in the body",
    () =>
      Effect.gen(function* () {
        yield* expectRefusal(
          script("export const other = 1;"),
          "export_outside_meta",
          "line 6"
        );
        yield* expectRefusal(
          script(
            `if (true) {\n  const x = \`\${ (() => { export default 1; })() }\`;\n}`
          ),
          "export_outside_meta"
        );
        yield* expectRefusal(
          script('import fs from "node:fs";'),
          "import_statement"
        );
        yield* expectRefusal(
          script('const m = await import("x");'),
          "import_statement"
        );
      })
  );

  it.effect(
    "finds no keyword inside strings, comments, templates or regular expressions",
    () =>
      Effect.gen(function* () {
        const parsed = yield* parseWorkflowScript(
          script(`// export everything
/* import nothing */
const a = "export default 1";
const b = 'import x from "y"';
const c = \`export \${"import"} and \${ { n: "export" }.n }\`;
const d = /export|import/u.test(a) ? 1 : 2 / 3;
const e = { export: 1, import: 2 }.export;
const log2 = (x) => x;
let n = 4;
const f = n-- / 2;
const counts = [1];
const g = counts[0]++ / 2 + (n)-- / 1;
if (a) /"/.test(a);
while (false) /'/.test(a);
if (a) {
  n = 1;
}
/"/.test(a);
const o = { return: 4 };
const h = o.return / 2 + { k: 1 }.k / 3;
return [a, b, c, d, e, log2, f, g, h];`)
        );

        assert.strictEqual(parsed.meta.name, "review-modules");
      })
  );

  it.effect(
    "refuses a top-level declaration of a prelude name, and allows a nested one",
    () =>
      Effect.gen(function* () {
        yield* expectRefusal(
          script("const agent = 1;"),
          "reserved_name",
          "`agent`"
        );
        yield* expectRefusal(
          script("function parallel() {}"),
          "reserved_name",
          "`parallel`"
        );
        yield* expectRefusal(
          script("let budget = 5;"),
          "reserved_name",
          "`budget`"
        );
        yield* expectRefusal(
          script("const { budget } = { budget: 1 };"),
          "reserved_name",
          "`budget`"
        );
        yield* expectRefusal(
          script("const { a: [, { b: approve = 2 }] } = x;"),
          "reserved_name",
          "`approve`"
        );
        yield* expectRefusal(
          script("const [first, ...log] = [1, 2];"),
          "reserved_name",
          "`log`"
        );
        yield* expectRefusal(
          script("let x = f(1, 2), agent = 2;"),
          "reserved_name",
          "`agent`"
        );
        yield* expectRefusal(
          script("var x = 1\n, phase = 2;"),
          "reserved_name",
          "`phase`"
        );
        yield* expectRefusal(
          script("function* agent() {}"),
          "reserved_name",
          "`agent`"
        );
        yield* expectRefusal(
          script("const __cairnPhase = 1;"),
          "reserved_name",
          "__cairn"
        );
        yield* expectRefusal(
          script("tools.x(__cairnRun);"),
          "reserved_name",
          "__cairn"
        );
        // A keyword used as a property does not hide the rest of the line from the checks.
        yield* expectRefusal(
          script(
            "const o = { return: 4 };\nconst r = o.return / 2; const agent = 1;"
          ),
          "reserved_name",
          "`agent`"
        );
        // A word before `:` is a key only inside an object literal.
        yield* expectRefusal(
          script("const f = true ? __cairnBake : 0;"),
          "reserved_name",
          "__cairnBake"
        );
        yield* expectRefusal(
          script("switch (1) {\n  case __cairnRun: break;\n}"),
          "reserved_name",
          "__cairnRun"
        );

        const nested = yield* parseWorkflowScript(
          script(
            "const collect = () => {\n  const log = [];\n  return log;\n};\nreturn collect();"
          )
        );

        assert.strictEqual(nested.meta.name, "review-modules");

        // Names a declaration reads, not binds: keys, defaults, initialisers, the next statement.
        const reads = yield* parseWorkflowScript(
          script(
            "const { agent: worker = budget, [args.key]: value } = { agent: 1 };\nlet x = { phase: log }, y = parallel([])\nlog(x, y);\nreturn [worker, value];"
          )
        );

        assert.strictEqual(reads.meta.name, "review-modules");
      })
  );

  it.effect("refuses a body the lexer cannot step through", () =>
    expectRefusal(
      script('const x = "never closed;\nreturn x;'),
      "source_unreadable",
      "string"
    )
  );
});

describe(isWorkflowSource, () => {
  it("marks scripts whose first statement is the meta", () => {
    assert.isTrue(isWorkflowSource(script("return 1;")));
    assert.isTrue(
      isWorkflowSource(`// @options: {"max_output_tokens": 10}\n// hi\n${META}`)
    );
    assert.isFalse(isWorkflowSource("return 1;"));
    assert.isFalse(isWorkflowSource(`const x = 1;\n${META}`));
    assert.isFalse(isWorkflowSource(""));
  });
});
