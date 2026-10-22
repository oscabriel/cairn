// How the root derives the composer's context from its own state. Kept here so the root's wiring is
// one call: the route names the target, the shell gives the projects and the thread's row, the
// thread page gives its view, and `session.hello` the server's defaults. Arrays and rows are passed
// through untouched, so `contextChanged` can compare them by identity.
import type { ThreadId } from "@cairn/protocol/Ids";
import type { ModelDefaults } from "@cairn/protocol/Models";
import type { ProjectShell, ShellSnapshot } from "@cairn/protocol/Shell";
import type { ConversationView } from "@cairn/protocol/Thread";
import { Array, Option } from "effect";

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
}

/** The composer's target for a route: the hero at `/` and `/new/<id>`, a thread at `/t/<id>`. */
export const composerTarget = (
  route: AppRoute,
  threadId: Option.Option<ThreadId>
): ComposerTarget =>
  AppRoute.match(route, {
    Inbox: () => ComposerTarget.Home(),
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
): ComposerContext => ({
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
  view: Option.isSome(input.threadId) ? input.threadView : Option.none(),
  defaults: input.defaults,
});
