// What the coding tools ask git once, when the brain starts: its `git version` line, or why git
// could not run. The coding tools decide the commit trailer from it (`CodingTools.ts`). A service of
// its own, so the brain reads git's version without importing the git runner (`git/Git.ts`, which
// gives it through `GitVersionLive`).

import { Context } from "effect";

/** Git's `git version` line as the brain started, or the message of the failure that stopped it. */
export class GitVersion extends Context.Service<
  GitVersion,
  { readonly line: string }
>()("cairn/server/brain/GitVersion") {}
