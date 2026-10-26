// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/runtimeModeConfig.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the four modes in t3code's order with their labels
// and descriptions. Changed: icons are named by their lucide icon name instead of React components,
// and every mode but full access is marked as applying in a later phase, because Phase 1 enforces
// no approvals (plan D37).
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

import { DEFAULT_RUNTIME_MODE } from "@cairn/protocol/Policy";
import type { RuntimeMode } from "@cairn/protocol/Policy";

/** The lucide icons the runtime-mode control draws. */
export type RuntimeModeIcon = "lock" | "pen-line" | "sparkles" | "lock-open";

/** How the runtime-mode control shows one mode. */
export interface RuntimeModePresentation {
  readonly label: string;
  readonly description: string;
  readonly icon: RuntimeModeIcon;
  /** False for a mode Cairn lists but does not enforce yet. */
  readonly isEnforced: boolean;
}

/** The note shown beside a mode that is not enforced yet. */
export const LATER_PHASE_NOTE = "Applies in a later phase";

/** Every mode's presentation, keyed by mode. */
export const runtimeModePresentation: Readonly<
  Record<RuntimeMode, RuntimeModePresentation>
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: "lock",
    isEnforced: false,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: "pen-line",
    isEnforced: false,
  },
  auto: {
    label: "Auto",
    description:
      "Supported providers approve routine actions; others still ask.",
    icon: "sparkles",
    isEnforced: false,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: "lock-open",
    isEnforced: true,
  },
};

/** The modes in the order the control lists them. */
export const runtimeModeOptions: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/** The mode a new thread starts in. */
export const defaultRuntimeMode: RuntimeMode = DEFAULT_RUNTIME_MODE;
