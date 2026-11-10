// @vitest-environment node
// The bundle budget (plan D46, notes/edges.md section 3 "Budgets", ADR 0021): a production build
// of the web app, read through its Vite manifest. Judged: the entry chunk with every chunk it
// imports statically (what a cold load must fetch before the app runs), which must be one script,
// and the CSS those chunks carry, each gzipped; and the views a cold load never draws, which must
// stay out of that closure whatever imports them (`DEFERRED`).

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Predicate, Record, Schema } from "effect";
import { build } from "vite";
import type { Rolldown } from "vite";

/**
 * Entry JS ceiling, gzip bytes (315.5 KiB): 316,724 B measured on 2026-11-10, once the views a cold
 * load never draws became chunks of their own (`next/page/Chunks.ts`, finding W-8), with about 2%
 * headroom. ADR 0021 states the same number.
 *
 * What earns a raise: a named feature drawn on a thread list or a thread's first page, which
 * therefore cannot load later, with its measured cost in gzip bytes, approved in the commit that
 * raises the number. Anything a cold load does not draw goes into a chunk instead (`DEFERRED`). The
 * binding bar is still round trips and time to interactive, which `judges/load.ts` judges.
 */
export const ENTRY_JS_BUDGET = 323_072;

/**
 * The plan's entry target (D46: 200 KB gzip). Not met: effect, foldkit and its UI package alone are
 * about 100 KB gzip before Cairn's own code. Reported, not enforced.
 */
export const ENTRY_JS_TARGET = 200_000;

/**
 * Entry CSS ceiling, gzip bytes, under D46's 35 KB: 33,550 B at the cutover (7A), 34,143 B with the
 * model picker's provider rail, phone sheet and touch sizes (2026-10-31).
 */
export const ENTRY_CSS_BUDGET = 34_600;

/**
 * The views a cold load never draws, by a module only each one needs (a path under `apps/web`, or a
 * package's folder under `node_modules`). Each must be in the build and outside the entry's static
 * closure, whether or not anything imports it dynamically: a static import anywhere in the entry's
 * graph fails it. Their state, Messages and updates stay in the entry.
 */
const DEFERRED: ReadonlyArray<{
  readonly view: string;
  readonly module: string;
}> = [
  { view: "the settings page", module: "src/next/settings/View.ts" },
  { view: "the settings page's push switch", module: "src/next/push/View.ts" },
  {
    view: "the usage page and its budget forms",
    module: "src/next/meters/UsageView.ts",
  },
  {
    view: "the model picker and the composer's menus",
    module: "src/composer/Popovers.ts",
  },
  { view: "the add-project picker", module: "src/next/shell/AddProject.ts" },
  { view: "the work panel", module: "src/next/shell/WorkPanel.ts" },
  { view: "the goal panel", module: "src/next/shell/GoalPanel.ts" },
  { view: "the refresh confirm", module: "src/next/shell/Refresh.ts" },
  {
    view: "the rename and remove dialog",
    module: "src/next/shell/ManageDialog.ts",
  },
  { view: "the diff panel", module: "src/diff/View.ts" },
  { view: "syntax highlighting", module: "node_modules/@shikijs/core/" },
];

/** The dev-only look catalogue's folder, as a manifest key starts. */
const LOOK_CATALOGUE_FOLDER = "src/next/ui/catalogue/";

/** The attribute only the look catalogue's view writes (`data-look-catalogue`). */
const LOOK_CATALOGUE_MARKER = "look-catalogue";

const ManifestChunk = Schema.Struct({
  file: Schema.String,
  isEntry: Schema.optionalKey(Schema.Boolean),
  isDynamicEntry: Schema.optionalKey(Schema.Boolean),
  imports: Schema.optionalKey(Schema.Array(Schema.String)),
  css: Schema.optionalKey(Schema.Array(Schema.String)),
});

const Manifest = Schema.Record(Schema.String, ManifestChunk);

type Manifest = typeof Manifest.Type;

const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Manifest)
);

const gzipSize = (text: string) =>
  Effect.promise(async () => {
    const stream = new Blob([text])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));

    const bytes = await new Response(stream).arrayBuffer();

    return bytes.byteLength;
  });

/** An emitted file's text: a chunk's code or an asset's source. */
const textOf = (item: Rolldown.OutputChunk | Rolldown.OutputAsset): string => {
  if (item.type === "chunk") {
    return item.code;
  }

  return Predicate.isString(item.source)
    ? item.source
    : new TextDecoder().decode(item.source);
};

/**
 * Builds the app in memory and returns its manifest, every emitted file's text by name, and the
 * modules in each chunk by file name.
 */
const buildApp = Effect.promise(async () => {
  const output = await build({
    configFile: new URL("../vite.config.ts", import.meta.url).pathname,
    root: new URL("..", import.meta.url).pathname,
    logLevel: "silent",
    build: { manifest: true, write: false },
  });

  // Without `watch`, `build` gives one output per environment, never a watcher.
  const outputs = (Array.isArray(output) ? output : [output]).filter(
    (result): result is Rolldown.RolldownOutput => "output" in result
  );

  const files = new Map<string, string>();
  const modules = new Map<string, ReadonlyArray<string>>();

  for (const item of outputs.flatMap((result) => result.output)) {
    files.set(item.fileName, textOf(item));

    if (item.type === "chunk") {
      modules.set(item.fileName, Object.keys(item.modules));
    }
  }

  const manifestText = Option.getOrThrow(
    Option.fromNullishOr(files.get(".vite/manifest.json"))
  );

  return { manifest: decodeManifest(manifestText), files, modules };
});

/** The entry's key and every key it reaches through static imports. */
const staticClosure = (manifest: Manifest) => {
  const entry = Option.getOrThrow(
    Record.findFirst(manifest, (chunk) => chunk.isEntry === true)
  );

  const seen = new Set<string>();
  const pending = [entry[0]];

  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (!seen.has(key)) {
      seen.add(key);
      const imports = manifest[key]?.imports ?? [];

      pending.push(...imports);
    }
  }

  return seen;
};

/** The index of the brace that closes the block opened at `open`. */
const closingBrace = (text: string, open: number): number => {
  let depth = 0;

  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") {
      depth += 1;
    } else if (text[index] === "}") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return text.length;
};

/** The top-level blocks of a CSS body: each one's prelude and its contents. */
const cssBlocks = (
  body: string
): ReadonlyArray<{ head: string; inner: string }> => {
  const blocks: Array<{ head: string; inner: string }> = [];

  for (let start = 0; start < body.length;) {
    const open = body.indexOf("{", start);

    if (open === -1) {
      break;
    }

    const close = closingBrace(body, open);

    blocks.push({
      head: body.slice(start, open).trim(),
      inner: body.slice(open + 1, close),
    });
    start = close + 1;
  }

  return blocks;
};

const propertiesOf = (declarations: string): ReadonlyArray<string> =>
  declarations
    .split(";")
    .map((declaration) => declaration.split(":")[0]?.trim() ?? "")
    .filter((property) => property !== "");

/** A selector that is one bare utility class (`.flex`, `.w-full`), no variant and no pseudo. */
const PLAIN_UTILITY = /^\.(?:[\w-]|\\.)+$/u;

/**
 * Plain utilities the built CSS places after a width, container or other conditional variant that
 * sets the same property, where they would win over it on an element that has both. One Tailwind
 * build sorts every plain utility before every variant, so the list is empty; several builds merged
 * into one file are not (the settings rows' `@min-[32rem]` grid lost to a later `.flex`, 2026-11-01).
 * A conditional rule counts only when its selector names a variant (`\:`): `.container`'s own
 * widths and the `@supports` colour fallbacks belong to plain utilities.
 */
const shadowedVariants = (css: string): ReadonlyArray<string> => {
  const layer = css.indexOf("@layer utilities{");

  if (layer === -1) {
    return [];
  }

  const open = css.indexOf("{", layer);
  const variants = new Map<string, string>();
  const shadowed: Array<string> = [];

  const collect = (inner: string, condition: string) => {
    for (const block of cssBlocks(inner)) {
      if (block.head.startsWith("@")) {
        collect(block.inner, `${condition} ${block.head}`);
      } else if (block.head.includes("\\:")) {
        for (const property of propertiesOf(block.inner)) {
          if (!variants.has(property)) {
            variants.set(property, `${condition} ${block.head}`);
          }
        }
      }
    }
  };

  for (const block of cssBlocks(css.slice(open + 1, closingBrace(css, open)))) {
    if (block.head.startsWith("@")) {
      collect(block.inner, block.head);
    } else if (PLAIN_UTILITY.test(block.head)) {
      const property = propertiesOf(block.inner).find((name) =>
        variants.has(name)
      );

      if (property !== undefined) {
        shadowed.push(
          `${block.head} (${property}) after ${variants.get(property) ?? ""}`
        );
      }
    }
  }

  return shadowed;
};

describe("the bundle budget", () => {
  it.live(
    "keeps the entry one script, its JS and CSS under budget, and the deferred views out of it",
    () =>
      Effect.gen(function* () {
        const { manifest, files, modules } = yield* buildApp;

        const closure = [...staticClosure(manifest)];

        const chunks = closure.flatMap((key) =>
          Option.toArray(Option.fromNullishOr(manifest[key]))
        );

        const sizeOf = (file: string) =>
          gzipSize(Option.getOrThrow(Option.fromNullishOr(files.get(file))));

        const js = yield* Effect.forEach(chunks, (chunk) => sizeOf(chunk.file));

        const css = yield* Effect.forEach(
          [...new Set(chunks.flatMap((chunk) => chunk.css ?? []))],
          sizeOf
        );

        const entryJs = js.reduce((sum, size) => sum + size, 0);
        const entryCss = css.reduce((sum, size) => sum + size, 0);

        const scripts = [...new Set(chunks.map((chunk) => chunk.file))];

        const entryModules = scripts.flatMap((file) => modules.get(file) ?? []);

        const builtModules = [...modules.values()].flat();

        yield* Effect.logInfo("bundle budget").pipe(
          Effect.annotateLogs({
            entryJsGzip: entryJs,
            entryJsTarget: ENTRY_JS_TARGET,
            entryCssGzip: entryCss,
            scripts: scripts.join(","),
          })
        );

        assert.isAtMost(entryJs, ENTRY_JS_BUDGET, "entry JS gzip bytes");
        assert.isAtMost(entryCss, ENTRY_CSS_BUDGET, "entry CSS gzip bytes");

        // Every plain utility sorts before every variant (`shadowedVariants`).
        for (const file of new Set(
          chunks.flatMap((chunk) => chunk.css ?? [])
        )) {
          assert.deepStrictEqual(
            shadowedVariants(
              Option.getOrThrow(Option.fromNullishOr(files.get(file)))
            ),
            [],
            `${file}: plain utilities after a variant of the same property`
          );
        }

        // The look catalogue (`next/ui/catalogue`, `/__look`) is for the dev server only: no
        // chunk comes from its folder and no emitted file carries its marker.
        assert.deepStrictEqual(
          Object.keys(manifest).filter((key) =>
            key.startsWith(LOOK_CATALOGUE_FOLDER)
          ),
          [],
          "manifest entries from the look catalogue"
        );
        assert.deepStrictEqual(
          [...files].flatMap(([file, text]) =>
            text.includes(LOOK_CATALOGUE_MARKER) ? [file] : []
          ),
          [],
          "emitted files carrying the look catalogue"
        );

        // A cold load runs one script; split shared code would cost a request before interactive.
        assert.lengthOf(scripts, 1, `entry scripts: ${scripts.join(", ")}`);

        for (const { view, module } of DEFERRED) {
          const isIt = (id: string) => id.includes(`/${module}`);

          assert.isTrue(
            builtModules.some(isIt),
            `${view} (${module}) is not in the build: name the module that draws it now`
          );
          assert.deepStrictEqual(
            entryModules.filter(isIt),
            [],
            `${view} (${module}) is in the entry's static closure`
          );
        }
      }),
    60_000
  );

  it("catches a plain utility placed after a variant of the same property", () => {
    const merged =
      "@layer utilities{.grid{display:grid}@container row (width>=32rem){.\\@min-\\[32rem\\]\\/row\\:grid{display:grid}}.flex{display:flex}}";

    assert.deepStrictEqual(shadowedVariants(merged), [
      ".flex (display) after @container row (width>=32rem) .\\@min-\\[32rem\\]\\/row\\:grid",
    ]);
    assert.deepStrictEqual(
      shadowedVariants(
        "@layer utilities{.flex{display:flex}.container{width:100%}@media (width>=40rem){.container{max-width:40rem}}.max-w-3xl{max-width:48rem}}"
      ),
      []
    );
  });
});
