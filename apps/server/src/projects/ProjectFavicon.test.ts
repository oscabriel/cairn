// Ported from github.com/pingdotgg/t3code, apps/server/src/project/ProjectFaviconResolver.test.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the cases for well-known files, icon hrefs from
// HTML and from route metadata (rel before or after href, nested objects, an icon entry without an
// href), a large source with no icon, none at all, and hrefs outside the root. Changed: Cairn has
// no `t3.json` icon or saved override, so those cases are gone; added a link that escapes the root,
// a file over the size ceiling and a source over its ceiling.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";

import {
  FAVICON_MAX_BYTES,
  findFavicon,
  ICON_SOURCE_MAX_BYTES,
  iconHrefOf,
} from "./ProjectFavicon.ts";

const workspace = Effect.fn("test.workspace")(function* (
  files: Readonly<Record<string, string>>
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cairn-favicon-" });

  for (const [file, text] of Object.entries(files)) {
    yield* fs.makeDirectory(path.dirname(path.join(root, file)), {
      recursive: true,
    });
    yield* fs.writeFileString(path.join(root, file), text);
  }

  // The resolver answers real paths; a temp folder may sit behind a link (macOS `/var`).
  return yield* fs.realPath(root);
});

const found = (root: string) =>
  Effect.map(findFavicon(root), (favicon) =>
    Option.map(favicon, (each) => path.relative(root, each.path))
  );

layer(NodeServices.layer)("finding a project's favicon", (it) => {
  it.effect("prefers the well-known files, in t3code's order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* workspace({
          "public/favicon.svg": "<svg/>",
          "favicon.ico": "ico",
          "index.html": '<link rel="icon" href="/brand.svg">',
          "public/brand.svg": "<svg/>",
        });

        const favicon = yield* findFavicon(root);

        assert.deepStrictEqual(
          Option.map(favicon, (each) => ({
            file: path.relative(root, each.path),
            mediaType: each.mediaType,
          })),
          Option.some({ file: "favicon.ico", mediaType: "image/x-icon" })
        );
      })
    )
  );

  it.effect("follows the icon link in index.html to its public copy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* workspace({
          "index.html": '<link rel="icon" href="/brand/logo.svg">',
          "public/brand/logo.svg": "<svg>brand</svg>",
        });

        assert.deepStrictEqual(
          yield* found(root),
          Option.some("public/brand/logo.svg")
        );
      })
    )
  );

  it.effect("reads route metadata objects, whichever key comes first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* workspace({
          "src/root.tsx": `const links = [{ rel: "icon" }, { href: "/brand/logo.svg", rel: "shortcut icon" }];`,
          "public/brand/logo.svg": "<svg/>",
        });

        assert.deepStrictEqual(
          yield* found(root),
          Option.some("public/brand/logo.svg")
        );
      })
    )
  );

  it.effect(
    "finds none in a root without one, and none for a missing root",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* workspace({ "README.md": "# none" });

          assert.isTrue(Option.isNone(yield* findFavicon(root)));
          assert.isTrue(
            Option.isNone(yield* findFavicon(path.join(root, "gone")))
          );
        })
      )
  );

  it.effect(
    "never leaves the root: an href or a link pointing outside is skipped",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outside = yield* workspace({ "secret.svg": "<svg/>" });

          const root = yield* workspace({
            "index.html": '<link rel="icon" href="../../secret.svg">',
            "public/index.html": '<link rel="icon" href="/brand/logo.svg">',
            "public/brand/logo.svg": "<svg/>",
          });

          assert.deepStrictEqual(
            yield* found(root),
            Option.some("public/brand/logo.svg")
          );

          const linked = yield* workspace({});

          yield* fs.symlink(
            path.join(outside, "secret.svg"),
            path.join(linked, "favicon.svg")
          );

          assert.isTrue(Option.isNone(yield* findFavicon(linked)));
        })
      )
  );

  it.effect(
    "passes over a file over the ceiling and a source over its own",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* workspace({
            "favicon.svg": "x".repeat(FAVICON_MAX_BYTES + 1),
            "favicon.png": "png",
          });

          assert.deepStrictEqual(
            yield* found(root),
            Option.some("favicon.png")
          );

          const big = yield* workspace({
            "index.html": `${" ".repeat(ICON_SOURCE_MAX_BYTES)}<link rel="icon" href="/a.svg">`,
            "public/a.svg": "<svg/>",
          });

          assert.isTrue(Option.isNone(yield* findFavicon(big)));
        })
      )
  );

  it.effect("scans a large source with no icon in linear time", () =>
    Effect.sync(() => {
      const filler = `<p>${"companion guide { rel ".repeat(24)}</p>\n`;
      const source = `<html><body>\n${filler.repeat(1200)}</body></html>`;
      const started = performance.now();

      assert.isTrue(Option.isNone(iconHrefOf(source)));
      assert.isBelow(performance.now() - started, 2000);
    })
  );

  it.effect(
    "reads an icon href from a link first, then from a metadata object",
    () =>
      Effect.sync(() => {
        assert.deepStrictEqual(
          iconHrefOf('<link href="/x.png" rel="icon">'),
          Option.some("/x.png")
        );
        assert.deepStrictEqual(
          iconHrefOf(
            `links: [{ attributes: {}, rel: "icon", href: "/brand/logo.svg" }]`
          ),
          Option.some("/brand/logo.svg")
        );
        assert.isTrue(
          Option.isNone(iconHrefOf('<link rel="stylesheet" href="/a.css">'))
        );
      })
  );
});
