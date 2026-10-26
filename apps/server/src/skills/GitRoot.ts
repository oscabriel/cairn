// The checkout a folder sits in, found the way pi finds it: the nearest folder above it, itself
// included, that holds a `.git` entry (a folder, or a worktree's file).

import { existsSync } from "node:fs";
import path from "node:path";

import { Option } from "effect";

/** The nearest folder at or above `start` holding `.git`; none outside any checkout. */
export const gitRootOf = (start: string): Option.Option<string> => {
  let dir = path.resolve(start);

  for (;;) {
    if (existsSync(path.join(dir, ".git"))) {
      return Option.some(dir);
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      return Option.none();
    }

    dir = parent;
  }
};
