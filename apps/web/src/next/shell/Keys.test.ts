// The shell's keyboard (U-11, ADR 0050): the bindings are the table's and nothing else, so settle,
// pin, undo and the classic sidebar's toggle are not bound; Previous and Next thread walk only the
// rows the sidebar list draws, as a click on each would open it; New thread opens the project
// thread of the project the sidebar shows (ADR 0048), or a draft of that project where it has none;
// and the settings page's Keyboard section lists every key the shell answers.

import { NOW, shellRow } from "@cairn/client-logic/ShellRowTestKit";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Option, Predicate } from "effect";
import { assert, describe, it } from "vitest";

import { AppRoute, draftRouter } from "../../Route.ts";
import { drawnRowsOf, keyBindings, keyboardRowsOf } from "./Keys.ts";
import { Message, OutMessage } from "./Message.ts";
import type { ShortcutCommand } from "./Message.ts";
import type { Model } from "./Model.ts";
import {
  CAIRN,
  DEV,
  MANAGED,
  MYR,
  onProjectThread,
  PROJECT_THREAD,
  SCRATCH_THREAD,
  shellModelOn,
} from "./ShellFixtures.ts";
import { inform, update } from "./Update.ts";

const managedAt = (index: number): ThreadShell => {
  const found = MANAGED[index];

  if (found === undefined) {
    throw new Error(`no managed fixture ${String(index)}`);
  }

  return found;
};

/**
 * The live group, in the order it is drawn: the row that asks first, the running one, then the one
 * held by its plan's limit. The two failed and the two resting rows are folded.
 */
const asking = managedAt(0);

const running = managedAt(1);

const held = managedAt(3);

const onThread = (thread: Pick<ThreadShell, "id">) =>
  shellModelOn(AppRoute.Thread({ threadId: thread.id }));

const press = (model: Model, command: ShortcutCommand) =>
  update(model, Message.PressedShortcut({ command }));

/** Where a press sends the user: the path asked of the root, if any. */
const destination = (
  model: Model,
  command: ShortcutCommand
): Option.Option<string> => {
  const { outMessage } = press(model, command);

  return outMessage !== undefined &&
    Predicate.isTagged(outMessage, "RequestedNavigate")
    ? Option.some(outMessage.url)
    : Option.none();
};

const pathOf = (threadId: string) => `/t/${threadId}`;

describe("the key bindings", () => {
  it("bind only the commands the shell answers", () => {
    const keys = keyBindings.map((binding) => binding.keys);

    assert.deepStrictEqual(keys, [
      "Mod+n",
      "Mod+Shift+o",
      "Mod+Shift+{",
      "Mod+Shift+}",
    ]);

    // Settle, pin, undo, the classic sidebar's toggle, and the diff, palette and model picker
    // toggles nothing answers.
    for (const unbound of [
      "Mod+Shift+s",
      "Mod+Shift+p",
      "Mod+z",
      "Mod+b",
      "Mod+d",
      "Mod+k",
      "Mod+Shift+m",
    ]) {
      assert.notInclude(keys, unbound);
    }
  });

  it("are each listed for the settings page, with the scratch key and Escape", () => {
    assert.deepStrictEqual(
      keyboardRowsOf(false).map((row) => [row.title, row.keys]),
      [
        ["New thread", ["Ctrl+N", "Ctrl+Shift+O"]],
        ["Previous thread", ["Ctrl+Shift+["]],
        ["Next thread", ["Ctrl+Shift+]"]],
        ["Scratch thread", ["Ctrl+J"]],
        ["Close", ["Esc"]],
      ]
    );
    assert.deepStrictEqual(keyboardRowsOf(true)[0]?.keys, ["⌘N", "⇧⌘O"]);
  });
});

describe("Previous and Next thread", () => {
  it("walk the rows the sidebar draws, top to bottom", () => {
    assert.deepStrictEqual(
      drawnRowsOf(onProjectThread).map((row) => row.threadId),
      [PROJECT_THREAD, asking.id, running.id, held.id]
    );
    assert.deepStrictEqual(
      destination(onProjectThread, "thread.next"),
      Option.some(pathOf(asking.id))
    );
    assert.deepStrictEqual(
      destination(onThread(running), "thread.previous"),
      Option.some(pathOf(asking.id))
    );
    assert.isTrue(
      Option.isNone(destination(onProjectThread, "thread.previous"))
    );
  });

  it("stop at the last row drawn, never reaching a folded row or a thread no list shows", () => {
    assert.isTrue(Option.isNone(destination(onThread(held), "thread.next")));

    // The scratch thread has no row in the list, so the keys do nothing from it.
    const onScratch = shellModelOn(
      AppRoute.Thread({ threadId: SCRATCH_THREAD })
    );

    assert.isTrue(Option.isNone(destination(onScratch, "thread.next")));
    assert.isTrue(Option.isNone(destination(onScratch, "thread.previous")));
  });

  it("reach the resting rows once their fold is open", () => {
    const opened = update(
      onThread(held),
      Message.ClickedRestingThreads()
    ).model;

    // The first resting row follows the project thread and the three live rows.
    const firstResting = drawnRowsOf(opened).at(4);

    assert.isDefined(firstResting);
    assert.deepStrictEqual(
      destination(opened, "thread.next"),
      Option.some(pathOf(firstResting?.threadId ?? ""))
    );
  });

  it("open an earlier project thread as its row in the open Previous fold does", () => {
    const earlier = shellRow(40, {
      projectId: CAIRN,
      title: "Last week's project thread",
      archivedAt: Option.some(NOW),
    });

    const told = inform(onProjectThread, onProjectThread.context).model;

    const read = update(
      told,
      Message.ReceivedPreviousThreads({
        request: told.previous.request,
        page: { threads: [earlier], next: Option.none() },
        more: false,
      })
    ).model;

    const folded = update(read, Message.ClickedPreviousThreads()).model;

    const onHeld: Model = {
      ...folded,
      context: {
        ...folded.context,
        route: AppRoute.Thread({ threadId: held.id }),
      },
    };

    const pressed = press(onHeld, "thread.next");

    assert.deepStrictEqual(
      pressed.outMessage,
      OutMessage.RequestedNavigate({ url: pathOf(earlier.id) })
    );
    assert.isTrue(
      Option.exists(
        pressed.model.previous.opened,
        (opened) => opened.id === earlier.id
      )
    );
  });
});

describe("New thread", () => {
  it("opens the project thread of the project the user is in (ADR 0048)", () => {
    assert.deepStrictEqual(
      destination(onThread(asking), "chat.new"),
      Option.some(pathOf(PROJECT_THREAD))
    );
    assert.deepStrictEqual(
      destination(shellModelOn(AppRoute.Settings()), "chat.new"),
      Option.some(pathOf(PROJECT_THREAD))
    );
  });

  it("stays in the project the sidebar shows, never jumping to the hero's default", () => {
    const draftId = asking.id;

    // A draft of a project with no project thread: the sidebar shows that project.
    const onMyrDraft = inform(shellModelOn(AppRoute.Draft({ draftId })), {
      ...shellModelOn(AppRoute.Draft({ draftId })).context,
      draftProjectId: Option.some(MYR),
    }).model;

    // Settings, with a project picked on the rail that has no project thread.
    const onSettings: Model = {
      ...shellModelOn(AppRoute.Settings()),
      selectedProjectId: Option.some(DEV),
    };

    for (const [model, projectId] of [
      [onMyrDraft, MYR],
      [onSettings, DEV],
    ] as const) {
      const pressed = press(model, "chat.new");

      assert.isUndefined(pressed.outMessage);
      assert.deepStrictEqual(
        (pressed.commands ?? []).map(({ name }) => name),
        ["PrepareProjectDraft"]
      );
      assert.deepStrictEqual(
        update(
          pressed.model,
          Message.PreparedProjectDraft({ projectId, draftId })
        ).outMessage,
        OutMessage.RequestedProjectDraft({ projectId, draftId })
      );
    }
  });

  it("stays put on the project thread itself", () => {
    const pressed = press(onProjectThread, "chat.new");

    assert.isUndefined(pressed.outMessage);
    assert.lengthOf(pressed.commands ?? [], 0);
  });

  it("opens a draft of the project where it has no project thread, and a new draft where there is no project", () => {
    const shell = Option.getOrThrow(onProjectThread.context.shell);

    const withProjects = (projects: typeof shell.projects): Model => ({
      ...onProjectThread,
      context: {
        ...onProjectThread.context,
        shell: Option.some({ ...shell, projects }),
      },
    });

    const without = withProjects(
      shell.projects.map((project) => ({
        ...project,
        projectThreadId: Option.none(),
      }))
    );

    const inProject = press(without, "chat.new");

    assert.deepStrictEqual(
      (inProject.commands ?? []).map(({ name }) => name),
      ["PrepareProjectDraft"]
    );

    const scratchOnly = withProjects(
      shell.projects.filter((project) => project.kind === "scratch")
    );

    const pressed = press(scratchOnly, "chat.new");

    assert.deepStrictEqual(
      (pressed.commands ?? []).map(({ name }) => name),
      ["PrepareDraft"]
    );

    const draftId = asking.id;

    assert.deepStrictEqual(
      update(scratchOnly, Message.PreparedDraft({ draftId })).outMessage,
      OutMessage.RequestedNavigate({ url: draftRouter({ draftId }) })
    );
  });
});
