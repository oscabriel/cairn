// Where the root finds the `next` shell's update (the pattern is `next/FrameLoad.ts`). The shell's
// Model and Messages are in the entry, since the root Model holds them; its update, Commands and
// derived reads are in the `next` chunk, registered here by `Layout.ts` when the chunk loads. Until
// then the root only keeps the shell's context current, and no shell Message can arrive: the shell
// draws only once the chunk has loaded, and its key bindings run only while `next` draws.

import { Option } from "effect";

import type { inform, update } from "./Update.ts";

/** The shell's update and the step that tells it the root's context. */
export interface ShellRuntime {
  readonly update: typeof update;
  readonly inform: typeof inform;
}

// Held outside the Model on purpose: a module is code, not state. One key, set once.
const loaded = new Map<"shell", ShellRuntime>();

/** Registers the shell's update; `Layout.ts` calls it when the `next` chunk loads. */
export const registerShell = (runtime: ShellRuntime): void => {
  loaded.set("shell", runtime);
};

/** The shell's update, once the `next` chunk has loaded. */
export const loadedShell = (): Option.Option<ShellRuntime> =>
  Option.fromUndefinedOr(loaded.get("shell"));
