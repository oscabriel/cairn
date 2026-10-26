// Scratch folders for judges that run Claude Code: a fresh folder under the temp dir, removed with
// the transcripts Claude Code wrote for it when the scope closes, however the judge ends.
//
//   const cwd = yield* Scratch.make("cairn-claude-eligibility-")
//
// A child closed on another fiber may write its transcript once more as it exits, so the release
// removes the folders again after `CHILD_EXIT_GRACE`.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { Duration, Effect } from "effect";

/** How long a closed child gets to exit before its transcript folder is removed again. */
export const CHILD_EXIT_GRACE = Duration.seconds(3);

/** Claude Code's project folder for `cwd`: every `/` and `.` of the realpath becomes `-`. */
export const projectFolder = (cwd: string) =>
  path.join(homedir(), ".claude", "projects", cwd.replaceAll(/[/.]/gu, "-"));

const removeAll = (root: string) =>
  Effect.sync(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(projectFolder(root), { recursive: true, force: true });
  });

/** A fresh folder named `<prefix>XXXXXX`, its realpath, removed with its transcripts on release. */
export const make = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))),
    (root) =>
      removeAll(root).pipe(
        Effect.andThen(Effect.sleep(CHILD_EXIT_GRACE)),
        Effect.andThen(removeAll(root))
      )
  );
