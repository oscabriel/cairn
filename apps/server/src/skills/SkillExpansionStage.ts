// Ported from pi, earendil-works pi@4a080252, packages/coding-agent/src/core/agent-session.ts
// (`_expandSkillCommand`): a skill named by the user becomes pi's own block, so a thread continued
// in pi reads (and `parseSkillBlock` parses) the same turn. Changed: besides pi's leading
// `/skill:name args`, the composer's `skillRefs` (`$name` anywhere in the text) expand too, each
// block ahead of the text as typed; skills resolve through `SkillCatalog` for the thread's cwd, so
// a project skill wins over a user skill of the same name.
//
// MIT License. Copyright (c) 2025 Mario Zechner (pi).
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
//
// The skill expansion stage of `TurnContent` (it runs after `text`, before `attachments`):
//
// - `/skill:name args` at the very start of the text becomes pi's block followed by the args,
//   byte for byte what pi sends;
// - every other name in `skillRefs` adds its block ahead of the text, which stays as typed;
// - blocks come in the order the names were given, each once, separated by a blank line;
// - an unknown name, or a skill whose file cannot be read, is left as text (pi passes both through)
//   and logged;
// - the stage is also the turn-start refresh of the thread's skills (`refreshForTurn`), so a skill
//   added or edited since the last turn is in this turn's list and this turn's expansion.
import { readFileSync } from "node:fs";

import type { ThreadId } from "@cairn/protocol/Ids";
import { Effect, Option, Result } from "effect";

import { errorText } from "../brain/Durable.ts";
import { Projects } from "../projects/Projects.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { TurnContentError } from "../threads/TurnContent.ts";
import type { TurnContentStage, TurnDraft } from "../threads/TurnContent.ts";
import type { CatalogSkill } from "./SkillCatalog.ts";
import { SkillCatalog } from "./SkillCatalog.ts";

/** The prefix pi expands at the start of a message. */
export const SKILL_COMMAND = "/skill:";

/** pi's block for `skill`, whose body (frontmatter stripped, trimmed) is `body`. */
export const skillBlock = (skill: CatalogSkill, body: string): string =>
  `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;

/** The leading `/skill:` command of `text`, split as pi splits it. */
const leadingCommand = (text: string) => {
  if (!text.startsWith(SKILL_COMMAND)) {
    return Option.none();
  }

  const space = text.indexOf(" ");

  return Option.some({
    name:
      space === -1
        ? text.slice(SKILL_COMMAND.length)
        : text.slice(SKILL_COMMAND.length, space),
    args: space === -1 ? "" : text.slice(space + 1).trim(),
  });
};

/** The result of expanding one turn's text. */
export interface Expansion {
  readonly text: string;
  /** The skills expanded, in block order. */
  readonly expanded: ReadonlyArray<string>;
  /** Names that stayed text, with why. */
  readonly skipped: ReadonlyArray<{
    readonly name: string;
    readonly reason: string;
  }>;
}

/**
 * Expands `text` with the skills it names: pi's leading `/skill:name args`, then `refs`. `find`
 * resolves a name; `body` reads a skill's body or says why it cannot.
 */
export const expandSkills = (
  text: string,
  refs: ReadonlyArray<string>,
  find: (name: string) => Option.Option<CatalogSkill>,
  body: (skill: CatalogSkill) => Result.Result<string, string>
): Expansion => {
  const command = leadingCommand(text);
  const names = [...Option.toArray(Option.map(command, ({ name }) => name))];

  for (const ref of refs) {
    if (!names.includes(ref)) {
      names.push(ref);
    }
  }

  const blocks: Array<string> = [];
  const expanded: Array<string> = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const name of names) {
    const skill = find(name);

    if (Option.isNone(skill)) {
      skipped.push({ name, reason: "no skill has this name" });
      continue;
    }

    const read = body(skill.value);

    if (Result.isFailure(read)) {
      skipped.push({ name, reason: read.failure });
      continue;
    }

    blocks.push(skillBlock(skill.value, read.success));
    expanded.push(name);
  }

  if (blocks.length === 0) {
    return { text, expanded, skipped };
  }

  // pi replaces a leading command it expanded with its block and keeps only the args.
  const rest = Option.match(command, {
    onNone: () => text,
    onSome: ({ name, args }) => (expanded[0] === name ? args : text),
  });

  return {
    text: [...blocks, ...(rest === "" ? [] : [rest])].join("\n\n"),
    expanded,
    skipped,
  };
};

/** pi's `stripFrontmatter`, loaded lazily with the rest of pi-coding-agent. */
const loadStripFrontmatter = Effect.tryPromise({
  try: async () => {
    const pi = await import("@earendil-works/pi-coding-agent");

    return pi.stripFrontmatter;
  },
  catch: (cause) =>
    new TurnContentError({
      message: `Skill expansion could not load @earendil-works/pi-coding-agent: ${errorText(cause)}. Reinstall the brain's dependencies, then send again.`,
      stage: "skillExpansion",
      reason: "unavailable",
      field: Option.none(),
      cause,
    }),
});

const unavailable = (failure: { readonly message: string }) =>
  new TurnContentError({
    message: `Skill expansion could not read the thread's workspace: ${failure.message}. Nothing was sent; send again.`,
    stage: "skillExpansion",
    reason: "unavailable",
    field: Option.none(),
  });

/**
 * The thread's cwd as the shell knows it: its worktree, else its project's root. None before the
 * thread's row exists (a launch checks its first message before it writes the row), and where no
 * shell store is composed (tests of other stages), when only the user's skills apply.
 */
const cwdOfThread = Effect.fnUntraced(function* (threadId: ThreadId) {
  const stores = Option.all({
    rows: yield* Effect.serviceOption(ThreadRows),
    projects: yield* Effect.serviceOption(Projects),
  });

  if (Option.isNone(stores)) {
    return Option.none<string>();
  }

  const { rows, projects } = stores.value;
  const row = yield* rows.get(threadId).pipe(Effect.mapError(unavailable));

  if (Option.isNone(row)) {
    return Option.none<string>();
  }

  if (Option.isSome(row.value.shell.worktreePath)) {
    return row.value.shell.worktreePath;
  }

  const project = yield* projects
    .get(row.value.shell.projectId)
    .pipe(Effect.mapError(unavailable));

  return Option.map(project, (found) => found.shell.workspaceRoot);
});

/** Puts `text` in place of the input's text block, or first when the input had no text. */
const withText = (draft: TurnDraft, text: string): TurnDraft => {
  const index = draft.content.findIndex(
    (block) => block.type === "text" && block.text === draft.input.text
  );

  if (index === -1) {
    return { ...draft, content: [{ type: "text", text }, ...draft.content] };
  }

  return {
    ...draft,
    content: draft.content.map((block, at) =>
      at === index ? { type: "text", text } : block
    ),
  };
};

/**
 * The skill expansion stage. It needs nothing from its layer: the catalog is a reference (no skills
 * by default) and the shell store is read when it is there.
 */
export const skillExpansionStage: TurnContentStage<never> = {
  name: "skillExpansion",
  run: Effect.fn("SkillExpansionStage.run")(function* (draft: TurnDraft) {
    const catalog = yield* SkillCatalog;
    const cwd = yield* cwdOfThread(draft.threadId);
    const view = yield* catalog.refreshForTurn(cwd);
    const { text, skillRefs } = draft.input;

    if (skillRefs.length === 0 && !text.startsWith(SKILL_COMMAND)) {
      return draft;
    }

    const strip = yield* loadStripFrontmatter;

    const find = (name: string) =>
      Option.fromNullishOr(view.skills.find((skill) => skill.name === name));

    const body = (skill: CatalogSkill): Result.Result<string, string> => {
      try {
        return Result.succeed(
          strip(readFileSync(skill.filePath, "utf-8")).trim()
        );
      } catch (error) {
        return Result.fail(`its file could not be read: ${errorText(error)}`);
      }
    };

    const expansion = expandSkills(text, skillRefs, find, body);

    for (const { name, reason } of expansion.skipped) {
      yield* Effect.logWarning("skill not expanded").pipe(
        Effect.annotateLogs({
          event: "skill_not_expanded",
          skill: name,
          reason,
        })
      );
    }

    if (expansion.expanded.length === 0) {
      return draft;
    }

    yield* Effect.logInfo("skills expanded").pipe(
      Effect.annotateLogs({
        event: "skill_expanded",
        skills: expansion.expanded.join(" "),
      })
    );

    return withText(draft, expansion.text);
  }),
};
