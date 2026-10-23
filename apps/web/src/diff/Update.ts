// The diff panel's update, and `open`, which its parent calls when the changed-files card asks for
// a turn's diff (optionally at one file). Every request bumps `version`, so a slow answer for a
// turn the user already left is dropped.
import type { ThreadId } from "@cairn/protocol/Ids";
import { Option } from "effect";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { CairnConnectionService } from "../connection/Connection.ts";
import { FetchDiff, ScrollToFile } from "./Command.ts";
import { Message } from "./Message.ts";
import { DiffLoad, initial, isOpen } from "./Model.ts";
import type { Model } from "./Model.ts";

type Return = Update.Return<Model, Message, CairnConnectionService>;

/** Asks for the patch of the panel's target with its current scope and whitespace switch. */
const refetch = (model: Model): Return =>
  Option.match(model.target, {
    onNone: () => ({ model }),
    onSome: (target) => {
      const version = model.version + 1;

      return {
        model: modifyFields(model, {
          version: () => version,
          load: () => DiffLoad.Loading(),
        }),
        commands: [
          FetchDiff({
            version,
            threadId: target.threadId,
            turn: target.turn,
            scope: model.scope,
            ignoreWhitespace: model.ignoreWhitespace,
          }),
        ],
      };
    },
  });

/** Opens the panel at `turn` of `threadId`, scrolled to `path` when one is given. */
export const open = (
  model: Model,
  threadId: ThreadId,
  turn: number,
  path: Option.Option<string>
): Return =>
  refetch(
    modifyFields(model, {
      target: () => Option.some({ threadId, turn }),
      scope: () => "turn" as const,
      selectedPath: () => path,
    })
  );

/** Closes the panel, keeping the whitespace switch and the loaded grammars. */
export const close = (model: Model): Return => ({
  model: modifyFields(initial, {
    ignoreWhitespace: () => model.ignoreWhitespace,
    version: () => model.version + 1,
    highlightedLanguages: () => model.highlightedLanguages,
  }),
});

/** The diff panel's update. */
export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    RequestedOpen: ({ path, threadId, turn }) =>
      open(model, threadId, turn, path),
    ClickedClose: () => close(model),
    ClickedToggle: ({ latestTurn, threadId }) =>
      isOpen(model)
        ? close(model)
        : refetch(
            modifyFields(model, {
              target: () => Option.some({ threadId, turn: latestTurn }),
              scope: () => "full" as const,
              selectedPath: () => Option.none(),
            })
          ),
    ClickedScope: ({ scope }) =>
      scope === model.scope
        ? { model }
        : refetch(modifyFields(model, { scope: () => scope })),
    ToggledWhitespace: () =>
      refetch(
        modifyFields(model, {
          ignoreWhitespace: () => !model.ignoreWhitespace,
        })
      ),
    ClickedRetry: () => refetch(model),
    ClickedFile: ({ path }) => ({
      model: modifyFields(model, { selectedPath: () => Option.some(path) }),
      commands: [ScrollToFile({ path })],
    }),
    LoadedDiff: ({ patch, version }) => {
      if (version !== model.version) {
        return { model };
      }

      const next = modifyFields(model, {
        load: () => DiffLoad.Loaded({ patch }),
      });

      return Option.match(model.selectedPath, {
        onNone: () => ({ model: next }),
        onSome: (path) => ({
          model: next,
          commands: [ScrollToFile({ path })],
        }),
      });
    },
    FailedDiff: ({ message: reason, version }) =>
      version === model.version
        ? {
            model: modifyFields(model, {
              load: () => DiffLoad.Failed({ message: reason }),
            }),
          }
        : { model },
    ScrolledToFile: () => ({ model }),
    LoadedLanguage: ({ language }) =>
      model.highlightedLanguages.includes(language)
        ? { model }
        : {
            model: modifyFields(model, {
              highlightedLanguages: () => [
                ...model.highlightedLanguages,
                language,
              ],
            }),
          },
    FailedLanguage: () => ({ model }),
  });
