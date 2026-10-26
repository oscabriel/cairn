// How the root derives the composer's context from its own state. Kept here so the root's wiring is
// one call: the route names the target, the shell gives the projects and the thread's row, the
// thread page gives its view, and `session.hello` the server's defaults. Arrays and rows are passed
// through untouched, so `contextChanged` can compare them by identity. Of the thread's view the
// composer keeps only the `pi.inbox` document and the user's prompts, which a streamed token does
// not change.
import { buildComposerPromptHistoryEntries } from "@cairn/client-logic/ComposerPromptHistory";
import type {
  ComposerPromptHistoryEntry,
  ComposerPromptHistoryMessage,
} from "@cairn/client-logic/ComposerPromptHistory";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { ModelDefaults } from "@cairn/protocol/Models";
import type { ProjectShell, ShellSnapshot } from "@cairn/protocol/Shell";
import type { ConversationView, Entry } from "@cairn/protocol/Thread";
import type { UsageSnapshot } from "@cairn/protocol/Usage";
import { Array, Option, Predicate, Record, Schema } from "effect";

import { AppRoute } from "../Route.ts";
import { ComposerTarget } from "./Model.ts";
import type { ComposerContext } from "./Model.ts";

const NO_PROJECTS: ReadonlyArray<ProjectShell> = [];

/** What the root hands over to build the context. */
export interface ComposerContextInput {
  readonly route: AppRoute;
  /** The routed thread's id, when the route names a well-formed one. */
  readonly threadId: Option.Option<ThreadId>;
  readonly epoch: number;
  readonly hasClient: boolean;
  readonly live: boolean;
  readonly shell: Option.Option<ShellSnapshot>;
  /** The thread page's view of the routed thread. */
  readonly threadView: Option.Option<ConversationView>;
  readonly defaults: Option.Option<ModelDefaults>;
  readonly usage: Option.Option<UsageSnapshot>;
}

const HistoryMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(Schema.Json)]),
});

const decodeHistoryMessage = Schema.decodeUnknownOption(HistoryMessage);

const decodeTextPart = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
);

const userTexts = (
  message: Schema.Json
): Option.Option<ComposerPromptHistoryMessage> => {
  const decoded = decodeHistoryMessage(message);

  return Option.map(decoded, (value) => ({
    id: "",
    role: value.role,
    texts: Predicate.isString(value.content)
      ? [value.content]
      : Array.getSomes(value.content.map((part) => decodeTextPart(part))).map(
          ({ text }) => text
        ),
  }));
};

const NO_PROMPTS: ReadonlyArray<ComposerPromptHistoryEntry> = [];

/** The prompts read from each entries array, so a view whose entries did not change is not re-read. */
const promptsByEntries = new WeakMap<
  ReadonlyArray<Entry>,
  ReadonlyArray<ComposerPromptHistoryEntry>
>();

/** The user's prompts in `entries`, oldest first, as the arrow-key history recalls them. */
const promptsOf = (
  entries: ReadonlyArray<Entry>
): ReadonlyArray<ComposerPromptHistoryEntry> => {
  const known = promptsByEntries.get(entries);

  if (known !== undefined) {
    return known;
  }

  const prompts = buildComposerPromptHistoryEntries(
    Array.flatMap(entries, (entry) =>
      Array.getSomes((entry.model ?? []).map(userTexts)).map((message) => ({
        ...message,
        id: String(entry.id),
      }))
    )
  );

  promptsByEntries.set(entries, prompts);

  return prompts;
};

/** The composer's target for a route: the hero at `/` and `/new/<id>`, a thread at `/t/<id>`. */
export const composerTarget = (
  route: AppRoute,
  threadId: Option.Option<ThreadId>
): ComposerTarget =>
  AppRoute.match(route, {
    Hero: () => ComposerTarget.Home(),
    Draft: ({ draftId }) => ComposerTarget.Draft({ draftId }),
    Thread: () =>
      Option.match(threadId, {
        onNone: () => ComposerTarget.None(),
        onSome: (id) => ComposerTarget.Thread({ threadId: id }),
      }),
    Settings: () => ComposerTarget.None(),
    NotFound: () => ComposerTarget.None(),
  });

/** The composer's context from the root's state. */
export const composerContext = (
  input: ComposerContextInput
): ComposerContext => {
  const view = Option.isSome(input.threadId) ? input.threadView : Option.none();

  return {
    target: composerTarget(input.route, input.threadId),
    epoch: input.epoch,
    hasClient: input.hasClient,
    live: input.live,
    projects: Option.match(input.shell, {
      onNone: () => NO_PROJECTS,
      onSome: (shell) => shell.projects,
    }),
    thread: Option.flatMap(input.threadId, (id) =>
      Option.flatMap(input.shell, (shell) =>
        Array.findFirst(shell.threads, (thread) => thread.id === id)
      )
    ),
    inbox: Option.flatMap(view, (current) =>
      Record.get(current.docs, "pi.inbox")
    ),
    prompts: Option.match(view, {
      onNone: () => NO_PROMPTS,
      onSome: (current) => promptsOf(current.entries),
    }),
    defaults: input.defaults,
    usage: input.usage,
  };
};
