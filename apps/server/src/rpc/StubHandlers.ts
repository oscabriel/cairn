// A handler for every RPC that fails with a typed `Unavailable`, so the group is complete from the
// first wave and a client sees a clear, retryable answer instead of a dropped socket. Each domain's
// handlers replace their entries in `Handlers.ts` as they land.

import { Unavailable } from "@cairn/protocol/Errors";
import { Effect, Stream } from "effect";

const unavailable = (tag: string) =>
  new Unavailable({
    message: `${tag} is not available on this brain yet. Nothing ran; update the brain and retry.`,
  });

const unary = (tag: string) => () => Effect.fail(unavailable(tag));

const stream = (tag: string) => () => Stream.fail(unavailable(tag));

/** Every RPC in `CairnRpcs`, each failing with `Unavailable`. */
export const stubHandlers = {
  "session.hello": unary("session.hello"),
  "shell.subscribe": stream("shell.subscribe"),
  "shell.dispatch": unary("shell.dispatch"),
  "thread.launch": unary("thread.launch"),
  "thread.send": unary("thread.send"),
  "thread.stop": unary("thread.stop"),
  "thread.withdraw": unary("thread.withdraw"),
  "thread.configure": unary("thread.configure"),
  "thread.respond": unary("thread.respond"),
  "thread.retryTask": unary("thread.retryTask"),
  "thread.subscribe": stream("thread.subscribe"),
  "thread.history": unary("thread.history"),
  "thread.entry": unary("thread.entry"),
  "projects.browse": unary("projects.browse"),
  "projects.ensureScratch": unary("projects.ensureScratch"),
  "projects.searchEntries": unary("projects.searchEntries"),
  "git.branches": unary("git.branches"),
  "attachments.createUploadUrl": unary("attachments.createUploadUrl"),
  "attachments.discard": unary("attachments.discard"),
  "diff.turn": unary("diff.turn"),
  "diff.full": unary("diff.full"),
  "models.list": unary("models.list"),
  "providers.status": unary("providers.status"),
  "usage.subscribe": stream("usage.subscribe"),
  "skills.list": unary("skills.list"),
  "skills.reload": unary("skills.reload"),
  "executor.status": unary("executor.status"),
  "executor.signIn": unary("executor.signIn"),
  "push.subscribe": unary("push.subscribe"),
  "push.unsubscribe": unary("push.unsubscribe"),
  "presence.report": unary("presence.report"),
  "settings.get": unary("settings.get"),
  "settings.update": unary("settings.update"),
  "roles.check": unary("roles.check"),
  "spend.get": unary("spend.get"),
  "providers.login.start": stream("providers.login.start"),
  "providers.login.cancel": unary("providers.login.cancel"),
  "providers.logout": unary("providers.logout"),
  "goal.setCriteria": unary("goal.setCriteria"),
  "workflow.stop": unary("workflow.stop"),
  "workflow.stopNode": unary("workflow.stopNode"),
  "workflow.list": unary("workflow.list"),
  "workflow.eventStatus": unary("workflow.eventStatus"),
  "reach.list": unary("reach.list"),
  "artifact.revoke": unary("artifact.revoke"),
  "portal.close": unary("portal.close"),
  "portal.start": unary("portal.start"),
} as const;
