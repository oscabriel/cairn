// The `next` composer's context strip (plan look track L7): where the thread runs and on which
// branch, under the box, as quiet text with its glyphs. The facts and the choices are classic's
// (`hero/ContextStripView.ts`, over `hero/ContextStrip.ts`): for a draft in a repository the
// workspace and the base branch, both changeable; for a started thread the same facts, locked;
// nothing for a scratch draft or a thread the shell does not know.

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Folder, GitBranch } from "lucide";

import {
  activeDraft,
  draftProject,
  isDraftTarget,
} from "../../composer/Drafts.ts";
import { icon } from "../../composer/Icon.ts";
import { Message } from "../../composer/Message.ts";
import { Popover } from "../../composer/Model.ts";
import type { Model } from "../../composer/Model.ts";
import {
  resolveBranchLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
} from "../../hero/ContextStrip.ts";
import {
  CONTEXT_CONTROL_CLASS,
  CONTEXT_FACT_CLASS,
  CONTEXT_STRIP_CLASS,
} from "./Classes.ts";

const label = (h: HtmlBuilder<Message>, text: string): Html =>
  h.span(
    [
      h.DataAttribute("composer-label", "true"),
      h.Class("min-w-0 max-w-60 truncate"),
    ],
    [text]
  );

const isOpen = (model: Model, tag: Popover["_tag"]): boolean =>
  Option.exists(model.popover, (popover) => popover._tag === tag);

/** A strip control: a button that opens its menu. */
const control = (
  h: HtmlBuilder<Message>,
  ariaLabel: string,
  open: { readonly message: Message; readonly expanded: boolean },
  children: ReadonlyArray<Html>,
  attributes: ReadonlyArray<ReturnType<HtmlBuilder<Message>["DataAttribute"]>>
): Html =>
  h.button(
    [
      h.Type("button"),
      h.AriaLabel(ariaLabel),
      ...attributes,
      h.AriaExpanded(open.expanded),
      h.OnClick(open.message),
      h.Class(CONTEXT_CONTROL_CLASS),
    ],
    children
  );

/**
 * A started thread's fact (its workspace, its branch): words with their glyph, not a control,
 * since nothing about a running thread's place can change from here.
 */
const fact = (
  h: HtmlBuilder<Message>,
  title: string,
  children: ReadonlyArray<Html>,
  attributes: ReadonlyArray<ReturnType<HtmlBuilder<Message>["DataAttribute"]>>
): Html =>
  h.span(
    [...attributes, h.Title(title), h.Class(CONTEXT_FACT_CLASS)],
    children
  );

const strip = (
  h: HtmlBuilder<Message>,
  locked: boolean,
  children: ReadonlyArray<Html>
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "composer-context-strip"),
      ...onlyIf(locked, h.DataAttribute("locked", "true")),
      h.DataAttribute("testid", "composer-context-strip"),
      h.Class(CONTEXT_STRIP_CLASS),
    ],
    children
  );

const SPACER_CLASS = "min-w-0 flex-1";

/** The strip for the composer's target; none for a scratch draft or an unknown thread. */
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

    const branch = resolveBranchLabel(
      draft.baseBranch,
      Option.flatMap(model.branches, ({ result }) => result.current)
    );

    return Option.some(
      strip(h, false, [
        control(
          h,
          "Workspace",
          {
            message: Message.OpenedPopover({ popover: Popover.EnvMode() }),
            expanded: isOpen(model, "EnvMode"),
          },
          [
            icon(h, Folder, "folder", ""),
            label(h, resolveEnvModeLabel(draft.envMode)),
          ],
          [h.DataAttribute("composer-context-control", "true")]
        ),
        h.div([h.Class(SPACER_CLASS)]),
        control(
          h,
          "Base branch",
          {
            message: Message.OpenedPopover({
              popover: Popover.Branch({ query: "" }),
            }),
            expanded: isOpen(model, "Branch"),
          },
          [
            icon(h, GitBranch, "git-branch", ""),
            label(
              h,
              Option.getOrElse(branch, () => "Branch")
            ),
          ],
          [h.DataAttribute("slot", "combobox-trigger")]
        ),
      ])
    );
  }

  return Option.map(model.context.thread, (thread) =>
    strip(h, true, [
      fact(
        h,
        "Workspace",
        [
          icon(h, Folder, "folder", ""),
          label(h, resolveLockedWorkspaceLabel(thread.worktreePath, "local")),
        ],
        [h.DataAttribute("composer-context-control", "true")]
      ),
      h.div([h.Class(SPACER_CLASS)]),
      ...Option.match(thread.branch, {
        onNone: () => [],
        onSome: (name) => [
          fact(
            h,
            "Branch",
            [icon(h, GitBranch, "git-branch", ""), label(h, name)],
            [h.DataAttribute("slot", "combobox-trigger")]
          ),
        ],
      }),
    ])
  );
};
