// The `cairn` section: one paragraph telling the model where it is. It names the thread's arms (the
// folder its coding tools work in) and how to reach every tool beyond the coding tools: from a code
// mode script, through `searchTools()`. The text depends only on the conversation's cwd, so it is
// byte-stable across requests and changes only when the cwd does.
import { defineExtension, section } from "@earendil-works/pi-durable";
import { Option } from "effect";

import { ExtensionOrder } from "../brain/Extensions.ts";
import type { CairnExtension } from "../brain/Extensions.ts";

/** The section's key, which is also its tag. */
export const CAIRN_SECTION = "cairn";

/** The section's text for a thread whose cwd is `cwd` (none for a thread without arms). */
export const cairnSectionText = (cwd: Option.Option<string>): string =>
  [
    "You are working in Cairn, the owner's own agent workspace, on the owner's machine.",
    Option.match(cwd, {
      onNone: () =>
        "This thread has no folder yet, so the coding tools cannot run.",
      onSome: (dir) =>
        `This thread's arms are the folder ${dir}: the coding tools read, edit and run commands there, and relative paths resolve against it.`,
    }),
    "Every other tool (the owner's connected services, browsers and more) is reached from code mode:",
    "in a `codemode` script, call `searchTools()` with what you need, then call the tool it names as `tools.<name>()`.",
    "Look for a tool before saying you cannot do something.",
  ].join(" ");

/** The cairn extension. */
export const cairnSectionExtension: CairnExtension = {
  order: ExtensionOrder.cairn,
  extension: defineExtension({
    name: "cairn",
    sections: [
      section(CAIRN_SECTION, (input) =>
        cairnSectionText(Option.fromNullishOr(input.agent.cwd))
      ),
    ],
  }),
};
