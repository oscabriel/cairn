// Gives each test run a temporary folder of its own and removes it when the run ends. Tests make
// their scratch folders with `mkdtempSync(os.tmpdir())` and few remove them; under a tmpfs `/tmp`
// that leak grew to gigabytes. Workers start after this runs, so they inherit TMPDIR.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export default function setup() {
  // Short, so Unix socket paths made under it stay inside their 108-byte limit.
  const root = mkdtempSync(path.join(os.tmpdir(), "cairn-vt-"));

  process.env.TMPDIR = root;

  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
