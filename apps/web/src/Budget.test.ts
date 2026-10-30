// @vitest-environment node
// The bundle budget (plan D46, notes/edges.md section 3 "Budgets"): a production build of the web
// app, read through its Vite manifest. Judged: the entry chunk with every chunk it imports
// statically (what a cold load must fetch before the app runs) and the CSS those chunks carry,
// each gzipped. A lazy chunk D46 names (the transcript, markdown, diff and settings folders) is
// judged only when the manifest has a dynamic entry from that folder, and then it must stay out of
// the entry's static imports; so the test holds before the integrator splits `diff` and
// `settings` and keeps holding after.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Predicate, Record, Schema } from "effect";
import { build } from "vite";
import type { Rolldown } from "vite";

/**
 * Entry JS ceiling, gzip bytes (300 KiB). See `ENTRY_JS_TARGET` for the plan's number and why it
 * differs. Wave 4 integration raised it from 256 KiB: the diff panel's and settings page's state,
 * the hold banner and the usage meter add about 22 KB gzip to the entry even with both views
 * split out (ADR 0021). Wave 6a raised it from 288 KiB: until 7A deletes the classic views, the
 * entry carries both their state and the `next` shell's, request card's, meters' and subagent
 * rows' Models and Messages (295,528 B at wave 6a); 7A lowers it again. D46's binding bar is
 * round trips and time to interactive, which `judges/load.ts` judges.
 */
export const ENTRY_JS_BUDGET = 307_200;

/**
 * The plan's entry target (D46: 200 KB gzip). Not met by wave 3's client: effect, foldkit and
 * its UI package alone are about 100 KB gzip and the sidebar and composer about 60 KB, before
 * the transcript (about 30 KB, which a thread page needs at once). Reported, not enforced.
 */
export const ENTRY_JS_TARGET = 200_000;

/** Entry CSS ceiling, gzip bytes (D46: 35 KB). */
export const ENTRY_CSS_BUDGET = 35_000;

/** Folders D46 says load on demand; a manifest key is the imported module's path. */
const LAZY_FOLDERS = [
  "src/timeline/",
  "src/timeline/markdown/",
  "src/diff/",
  "src/settings/",
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

/** Builds the app in memory and returns its manifest and every emitted file's text by name. */
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

  for (const item of outputs.flatMap((result) => result.output)) {
    files.set(item.fileName, textOf(item));
  }

  const manifestText = Option.getOrThrow(
    Option.fromNullishOr(files.get(".vite/manifest.json"))
  );

  return { manifest: decodeManifest(manifestText), files };
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

describe("the bundle budget", () => {
  it.live(
    "keeps the entry's JS and CSS under budget and named lazy chunks lazy",
    () =>
      Effect.gen(function* () {
        const { manifest, files } = yield* buildApp;

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

        const lazy = Object.entries(manifest).filter(
          ([key, chunk]) =>
            chunk.isDynamicEntry === true &&
            LAZY_FOLDERS.some((folder) => key.startsWith(folder))
        );

        yield* Effect.logInfo("bundle budget").pipe(
          Effect.annotateLogs({
            entryJsGzip: entryJs,
            entryJsTarget: ENTRY_JS_TARGET,
            entryCssGzip: entryCss,
            lazyChunks: lazy.map(([key]) => key).join(","),
          })
        );

        assert.isAtMost(entryJs, ENTRY_JS_BUDGET, "entry JS gzip bytes");
        assert.isAtMost(entryCss, ENTRY_CSS_BUDGET, "entry CSS gzip bytes");

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

        for (const [key] of lazy) {
          assert.notInclude(
            closure,
            key,
            `${key} is imported statically by the entry`
          );
        }
      }),
    60_000
  );
});
