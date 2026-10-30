// Ported from github.com/pingdotgg/t3code, apps/server/src/project/ProjectFaviconResolver.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the well-known paths in their order, then the icon
// link in the project's `index.html` (or a root route's `rel: "icon"` object), each looked for at
// the project's root only and never outside it; the href's `public/` copy before the bare path; a
// hit cached for ten minutes and a miss for one, checked again when the cached file is gone; the
// brace-free scan for object metadata, so a large source is read in linear time. Changed: one
// function over Effect's `FileSystem` instead of a service with a cache layer (the route owns its
// cache); no `.t3/project.json` icon and no per-project favicon path, which Cairn's project has
// none of; Apple `.icns` files are left out, since a browser cannot draw them; a file over
// `FAVICON_MAX_BYTES` is no favicon, so a stray large file is never sent to the rail.
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

import { Effect, FileSystem, Option } from "effect";

/** The largest file served as a favicon; anything bigger is treated as none. */
export const FAVICON_MAX_BYTES = 512 * 1024;

/** The largest page or route source read for its icon link; a bigger one is skipped. */
export const ICON_SOURCE_MAX_BYTES = 1024 * 1024;

/** Where a project's favicon usually lives, most likely first (t3code's list, without `.icns`). */
export const FAVICON_CANDIDATES: ReadonlyArray<string> = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  ".idea/icon.svg",
];

/** Files whose icon link names the favicon, read when no well-known path has one. */
export const ICON_SOURCE_FILES: ReadonlyArray<string> = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
];

/** The image types a favicon is served as, by extension. */
const MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

// Anchored on `<link`, so the pattern starts only at real candidates (t3code's).
const LINK_ICON_HTML =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["'](?<href>[^"'?]+))[^>]*>/iu;

const ICON_REL = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/iu;

const ICON_HREF = /\bhref\s*:\s*["'](?<href>[^"'?]+)/iu;

/**
 * The icon href a page or route source names: an HTML `<link rel="icon">`, else the first
 * brace-free run holding `rel: "icon"` and an `href`. None when it names no icon.
 */
export const iconHrefOf = (source: string): Option.Option<string> => {
  const link = LINK_ICON_HTML.exec(source)?.groups?.href;

  if (link !== undefined && link !== "") {
    return Option.some(link);
  }

  for (const run of source.split("}")) {
    if (!ICON_REL.test(run)) {
      continue;
    }

    const href = ICON_HREF.exec(run)?.groups?.href;

    if (href !== undefined && href !== "") {
      return Option.some(href);
    }
  }

  return Option.none();
};

/** A project's favicon: its absolute path and the image type it is served as. */
export interface Favicon {
  readonly path: string;
  readonly mediaType: string;
}

/** The media type a favicon file is served as, from its extension; none for anything else. */
export const faviconMediaType = (file: string): Option.Option<string> =>
  Option.fromUndefinedOr(MEDIA_TYPES.get(path.extname(file).toLowerCase()));

/** Whether `candidate` is `root` or lies inside it. */
const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

/**
 * Finds the favicon of the project rooted at `workspaceRoot`, as t3code does: the well-known
 * paths in order, then the icon link of the first source file that names one. Only files inside
 * the root (after links are followed), of an image type, and at most `FAVICON_MAX_BYTES` count.
 * A root that cannot be read has none. Never fails.
 */
export const findFavicon = Effect.fn("ProjectFavicon.findFavicon")(function* (
  workspaceRoot: string
) {
  const fileSystem = yield* FileSystem.FileSystem;

  const root = yield* fileSystem.realPath(workspaceRoot).pipe(Effect.option);

  if (Option.isNone(root)) {
    return Option.none<Favicon>();
  }

  /** The real path `relative` names, when it lies inside the root once links are followed. */
  const inside = Effect.fnUntraced(function* (relative: string) {
    const joined = path.resolve(root.value, relative);

    if (!isWithin(root.value, joined)) {
      return Option.none<string>();
    }

    const real = yield* fileSystem.realPath(joined).pipe(Effect.option);

    return Option.filter(real, (found) => isWithin(root.value, found));
  });

  /** The regular file at `relative` inside the root, when it is at most `limit` bytes. */
  const fileAt = Effect.fnUntraced(function* (relative: string, limit: number) {
    const real = yield* inside(relative);

    if (Option.isNone(real)) {
      return Option.none<string>();
    }

    const info = yield* fileSystem.stat(real.value).pipe(Effect.option);

    return Option.isSome(info) &&
      info.value.type === "File" &&
      Number(info.value.size) <= limit
      ? real
      : Option.none<string>();
  });

  /** The favicon at `relative`: a small enough file of an image type. */
  const faviconAt = Effect.fnUntraced(function* (relative: string) {
    if (Option.isNone(faviconMediaType(relative))) {
      return Option.none<Favicon>();
    }

    const file = yield* fileAt(relative, FAVICON_MAX_BYTES);

    return Option.flatMap(file, (found) =>
      Option.map(faviconMediaType(found), (mediaType) => ({
        path: found,
        mediaType,
      }))
    );
  });

  for (const candidate of FAVICON_CANDIDATES) {
    const found = yield* faviconAt(candidate);

    if (Option.isSome(found)) {
      return found;
    }
  }

  for (const sourceFile of ICON_SOURCE_FILES) {
    const file = yield* fileAt(sourceFile, ICON_SOURCE_MAX_BYTES);

    const source = Option.isSome(file)
      ? yield* fileSystem.readFileString(file.value).pipe(Effect.option)
      : Option.none<string>();

    const href = Option.flatMap(source, iconHrefOf);

    if (Option.isNone(href)) {
      continue;
    }

    const clean = href.value.replace(/^\//u, "");

    for (const relative of [path.join("public", clean), clean]) {
      const found = yield* faviconAt(relative);

      if (Option.isSome(found)) {
        return found;
      }
    }
  }

  return Option.none<Favicon>();
});
