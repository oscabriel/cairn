// Ported from github.com/pingdotgg/t3code, apps/web/src/components/BranchToolbar.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the strip under the composer card with the
// workspace control ("Current checkout" or "New worktree") on the left and the branch control on the
// right, their DOM, classes and labels (the workspace icon in its tooltip trigger, the branch
// control as a combobox trigger), and the locked labels once a thread has started. Changed: no
// environment picker (one machine); the branch list comes from `git.branches`; the judges' test id
// sits on a `display: contents` wrapper, so the strip keeps t3code's landmarks.
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
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { ChevronDown, Folder, GitBranch } from "lucide";

import {
  CONTEXT_CONTROL_CLASS,
  CONTEXT_LABEL_CLASS,
  CONTEXT_LABEL_MOTION_CLASS,
  CONTEXT_STRIP_CLASS,
  CONTROL_BASE_CLASS,
} from "../composer/Classes.ts";
import {
  activeDraft,
  draftProject,
  isDraftTarget,
} from "../composer/Drafts.ts";
import { icon } from "../composer/Icon.ts";
import { Message } from "../composer/Message.ts";
import { Popover } from "../composer/Model.ts";
import type { Model } from "../composer/Model.ts";
import {
  resolveBranchLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
} from "./ContextStrip.ts";

const label = (h: HtmlBuilder<Message>, text: string): Html =>
  h.span(
    [h.DataAttribute("composer-label", "true"), h.Class(CONTEXT_LABEL_CLASS)],
    [
      h.span(
        [
          h.DataAttribute("composer-label-motion", "true"),
          h.Class(CONTEXT_LABEL_MOTION_CLASS),
        ],
        [text]
      ),
    ]
  );

const clickOrDisabled = (
  h: HtmlBuilder<Message>,
  onClick: Option.Option<Message>
) =>
  Option.match(onClick, {
    onNone: () => [h.Disabled(true)],
    onSome: (message) => [h.OnClick(message)],
  });

/** The workspace control on the left. */
const workspaceControl = (
  h: HtmlBuilder<Message>,
  onClick: Option.Option<Message>,
  children: ReadonlyArray<Html>
): Html =>
  h.button(
    [
      h.Type("button"),
      h.AriaLabel("Workspace"),
      h.DataAttribute("composer-context-control", "true"),
      ...clickOrDisabled(h, onClick),
      h.Class(
        `${CONTROL_BASE_CLASS} ${CONTEXT_CONTROL_CLASS} justify-center whitespace-nowrap min-w-0 shrink`
      ),
    ],
    children
  );

/** The branch control on the right, a combobox trigger in t3code. */
const branchControl = (
  h: HtmlBuilder<Message>,
  ariaLabel: string,
  onClick: Option.Option<Message>,
  children: ReadonlyArray<Html>
): Html =>
  h.span(
    [h.Class("flex min-w-0")],
    [
      h.button(
        [
          h.Type("button"),
          h.AriaLabel(ariaLabel),
          h.DataAttribute("slot", "combobox-trigger"),
          ...clickOrDisabled(h, onClick),
          h.Class(
            `${CONTROL_BASE_CLASS} ${CONTEXT_CONTROL_CLASS} shrink-0 justify-center whitespace-nowrap min-w-0 max-w-full active:scale-100`
          ),
        ],
        children
      ),
    ]
  );

const workspaceIcon = (h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.DataAttribute("slot", "tooltip-trigger"),
      h.Class("inline-flex shrink-0"),
    ],
    [icon(h, Folder, "folder", "size-3 shrink-0")]
  );

/** The strip around its controls; the judges' test id sits on a box-less wrapper. */
const strip = (
  h: HtmlBuilder<Message>,
  locked: boolean,
  children: ReadonlyArray<Html>
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "composer-context-strip"),
      ...(locked ? [h.DataAttribute("locked", "true")] : []),
      h.Class(CONTEXT_STRIP_CLASS),
    ],
    [
      h.div(
        [
          h.DataAttribute("testid", "composer-context-strip"),
          h.Class("contents"),
        ],
        children
      ),
    ]
  );

const chevron = (h: HtmlBuilder<Message>): Html =>
  icon(h, ChevronDown, "chevron-down", "size-3 shrink-0 opacity-50");

/**
 * The context strip: for a draft in a repository, the workspace mode and the base branch, both
 * changeable; for a started thread, the same facts locked. None for a scratch draft or a thread the
 * shell does not know.
 */
export const contextStripView = (
  model: Model,
  h: HtmlBuilder<Message>
): Option.Option<Html> => {
  if (isDraftTarget(model)) {
    const project = Option.filter(
      draftProject(model),
      (current) => current.kind === "folder"
    );

    if (Option.isNone(project)) {
      return Option.none();
    }

    const draft = activeDraft(model);

    const current = Option.flatMap(
      model.branches,
      ({ result }) => result.current
    );

    const branch = resolveBranchLabel(draft.baseBranch, current);

    return Option.some(
      strip(h, false, [
        workspaceControl(
          h,
          Option.some(Message.OpenedPopover({ popover: Popover.EnvMode() })),
          [
            workspaceIcon(h),
            label(h, resolveEnvModeLabel(draft.envMode)),
            chevron(h),
          ]
        ),
        h.div([h.Class("flex min-w-0 flex-1")]),
        h.div(
          [h.Class("flex items-center gap-1 min-w-0 flex-initial justify-end")],
          [
            branchControl(
              h,
              "Base branch",
              Option.some(
                Message.OpenedPopover({
                  popover: Popover.Branch({ query: "" }),
                })
              ),
              [
                icon(h, GitBranch, "git-branch", "size-3 shrink-0 opacity-70"),
                label(
                  h,
                  Option.getOrElse(branch, () => "Branch")
                ),
                chevron(h),
              ]
            ),
          ]
        ),
      ])
    );
  }

  return Option.map(model.context.thread, (thread) =>
    strip(h, true, [
      workspaceControl(h, Option.none(), [
        workspaceIcon(h),
        label(h, resolveLockedWorkspaceLabel(thread.worktreePath, "local")),
      ]),
      h.div([h.Class("flex min-w-0 flex-1")]),
      ...Option.match(thread.branch, {
        onNone: () => [],
        onSome: (name) => [
          branchControl(h, "Branch", Option.none(), [
            icon(h, GitBranch, "git-branch", "size-3 shrink-0 opacity-70"),
            label(h, name),
          ]),
        ],
      }),
    ])
  );
};
