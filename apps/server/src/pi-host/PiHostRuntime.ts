// The pi runtime a tools-only host binds and the context each handler and tool call receives. pi's
// loader returns a runtime whose action methods throw until a pi session binds them; the host has
// no pi session, so it binds the few answers tools need and refuses the rest:
//
// - `getActiveTools` and `getAllTools` answer the tools the instance registered; `setActiveTools`
//   is a no-op, because the brain installs its tool set once (footgun "moving default selections").
// - `appendEntry` is counted and dropped: a raw append into a busy conversation is a footgun.
// - Messages, session names, labels, models and thinking levels are refused with
//   `PiHostUnsupported` naming the API, inside a call. After its call settled, a package's
//   background work (pi-web-access posts a message when a background fetch finishes) gets a logged
//   drop instead, because a throw there has no caller and would reject a promise nobody handles.
// - Providers, MCP servers and virtual models fail the package's load (ADR 0002, ADR 0003).
//
// The context is pi's `ExtensionToolContext` with no UI (`hasUI: false`, `mode: "print"`), no model
// registry and no models, so features that need them fail with the extension's own error text.

import { AsyncLocalStorage } from "node:async_hooks";

import type {
  Extension,
  ExtensionContext,
  ExtensionRuntime,
  ExtensionUIContext,
  ExtensionToolContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Effect, Function, Option, Schema } from "effect";
import type { Types } from "effect";

import { errorText } from "../brain/Durable.ts";

/** A pi extension called an API the tools-only host does not provide; the call that made it fails. */
export class PiHostUnsupported extends Schema.TaggedError<PiHostUnsupported>()(
  "PiHostUnsupported",
  {
    message: Schema.String,
    /** The pi API, as the extension calls it (`sendMessage`). */
    api: Schema.String,
  }
) {}

/** Where the runtime reports what it dropped or what an extension said. */
export interface HostEvents {
  /** `ctx.ui.notify`: no UI, so the brain's log. */
  notify(message: string, level: string): void;
  /** An action the host refused outside any call, so it was dropped. */
  dropped(api: string): void;
  /** `appendEntry`, counted and dropped. */
  appended(customType: string): void;
}

/** One tool call in progress; `settled` turns true when its `execute` returns or throws. */
interface LiveCall {
  settled: boolean;
}

const calls = new AsyncLocalStorage<LiveCall>();

/**
 * Runs `execute` as one tool call: refused actions inside it throw `PiHostUnsupported`; the same
 * actions from work it left running are dropped once it settled.
 */
export const runInCall = async <A>(execute: () => Promise<A>): Promise<A> => {
  const call: LiveCall = { settled: false };

  try {
    return await calls.run(call, execute);
  } finally {
    call.settled = true;
  }
};

/** Refuses `api`: throws inside a live call, drops (and reports) everywhere else. */
const refuse = (api: string, events: HostEvents): void => {
  const call = calls.getStore();

  if (call !== undefined && !call.settled) {
    throw new PiHostUnsupported({
      message: `The Cairn tools-only pi host does not support ${api}: pi tools run without a pi session, so they cannot post messages, rename sessions or change models. The tool call failed; use the tool's other modes.`,
      api,
    });
  }

  events.dropped(api);
};

/** A refusal that holds outside calls too: registrations the load already turned down. */
const refuseAlways = (api: string) => () => {
  throw new PiHostUnsupported({
    message: `The Cairn tools-only pi host refuses ${api}: it hosts tools only, and providers and MCP servers reach the brain another way.`,
    api,
  });
};

/** The registrations the runtime holds that a tools-only host refuses, by API name. */
export const refusedRegistrations = (
  runtime: ExtensionRuntime
): ReadonlyArray<string> => {
  const refused: Array<string> = [];

  if (
    runtime.pendingProviderRegistrations.length > 0 ||
    runtime.pendingNativeProviderRegistrations.length > 0
  ) {
    refused.push("registerProvider");
  }

  if (runtime.mcpServers.list().length > 0) {
    refused.push("registerMcpServer");
  }

  if (runtime.pendingVirtualModelRegistrations.length > 0) {
    refused.push("registerVirtualModel");
  }

  return refused;
};

/** What `getAllTools` reports for each tool `extensions` registered. */
const toolInfos = (extensions: ReadonlyArray<Extension>): Array<ToolInfo> =>
  extensions.flatMap((extension) =>
    [...extension.tools.values()].map(({ definition, sourceInfo }) => {
      const info: Types.Mutable<ToolInfo> = {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        exposure: definition.exposure ?? "direct",
        sourceInfo,
      };

      if (definition.promptGuidelines !== undefined) {
        info.promptGuidelines = definition.promptGuidelines;
      }

      return info;
    })
  );

/**
 * Binds the action methods of `runtime`, which `extensions` share, to the host's answers. Later
 * registrations of providers, MCP servers and virtual models throw: the load already passed.
 */
export const bindRuntime = (
  runtime: ExtensionRuntime,
  extensions: ReadonlyArray<Extension>,
  events: HostEvents
): void => {
  runtime.getActiveTools = () =>
    extensions.flatMap((extension) => [...extension.tools.keys()]);

  runtime.getAllTools = () => toolInfos(extensions);
  runtime.setActiveTools = Function.constVoid;
  runtime.refreshTools = Function.constVoid;
  runtime.getSettings = () => ({});
  runtime.getCommands = () => [];
  runtime.getSessionName = Function.constUndefined;
  runtime.getThinkingLevel = () => "off";

  runtime.appendEntry = (customType) => {
    events.appended(customType);
  };

  runtime.sendMessage = () => {
    refuse("sendMessage", events);
  };

  runtime.sendUserMessage = () => {
    refuse("sendUserMessage", events);
  };

  runtime.setSessionName = () => {
    refuse("setSessionName", events);
  };

  runtime.setLabel = () => {
    refuse("setLabel", events);
  };

  runtime.setThinkingLevel = () => {
    refuse("setThinkingLevel", events);
  };

  runtime.setModel = async () => {
    refuse("setModel", events);

    return await Promise.resolve(false);
  };

  runtime.registerProvider = refuseAlways("registerProvider");
  runtime.registerNativeProvider = refuseAlways("registerProvider");
  runtime.registerVirtualModel = refuseAlways("registerVirtualModel");
  runtime.mcpServers.register = refuseAlways("registerMcpServer");
};

/** The last string among `args`: an inert theme returns the text it was asked to style. */
const plainText = (...args: ReadonlyArray<string>): string => args.at(-1) ?? "";

/** A theme whose every method returns its text unstyled; not thenable, so awaiting it never waits. */
const inertTheme = new Proxy(
  {},
  { get: (_target, key) => (key === "then" ? undefined : plainText) }
);

const answerNo = async () => await Promise.resolve(false);

/** A dialog's answer with no one to answer it: nothing chosen, nothing typed. */
const answerNothing = async (): Promise<string | undefined> => {
  await Promise.resolve();

  return Option.getOrUndefined(Option.none<string>());
};

/** The UI with no UI behind it: what a pi tool or handler may call on `ctx.ui`. */
type HostUi = Omit<ExtensionUIContext, "theme"> & { readonly theme: object };

/** The UI of a host with no UI: dialogs answer no, notifications go to the log, the rest is inert. */
const noUi = (events: HostEvents): HostUi => ({
  select: answerNothing,
  confirm: answerNo,
  input: answerNothing,
  editor: answerNothing,
  custom: async () =>
    await Promise.reject(
      new PiHostUnsupported({
        message:
          "The Cairn tools-only pi host has no UI to show a custom component in.",
        api: "ui.custom",
      })
    ),
  notify: (message, level) => {
    events.notify(message, level ?? "info");
  },
  onTerminalInput: Function.constant(Function.constVoid),
  setStatus: Function.constVoid,
  setWorkingMessage: Function.constVoid,
  setWorkingVisible: Function.constVoid,
  setWorkingIndicator: Function.constVoid,
  setHiddenThinkingLabel: Function.constVoid,
  setWidget: Function.constVoid,
  setFooter: Function.constVoid,
  setHeader: Function.constVoid,
  setTitle: Function.constVoid,
  pasteToEditor: Function.constVoid,
  setEditorText: Function.constVoid,
  getEditorText: () => "",
  addAutocompleteProvider: Function.constVoid,
  setEditorComponent: Function.constVoid,
  getEditorComponent: Function.constUndefined,
  theme: inertTheme,
  getAllThemes: () => [],
  getTheme: Function.constUndefined,
  setTheme: () => ({ success: false, error: "The Cairn pi host has no UI." }),
  getToolsExpanded: Function.constFalse,
  setToolsExpanded: Function.constVoid,
});

/** The session a tool sees: pi's read-only session manager. */
type HostSession = ExtensionContext["sessionManager"];

/** What one context is for. */
export interface HostContextOptions {
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
  /** What `sessionManager.getSessionId()` answers: the conversation, or the instance at start. */
  readonly sessionId: string;
  readonly events: HostEvents;
}

/** A session manager with no session: no entries, no branch, no file. */
const noSession = (options: HostContextOptions): HostSession => ({
  getCwd: () => options.cwd,
  getSessionDir: () => options.cwd,
  getSessionId: () => options.sessionId,
  getSessionFile: Function.constUndefined,
  getLeafId: Function.constNull,
  getLeafEntry: Function.constUndefined,
  getEntry: Function.constUndefined,
  getLabel: Function.constUndefined,
  getBranch: () => [],
  getHeader: Function.constNull,
  getEntries: () => [],
  getTree: () => [],
  getSessionName: Function.constUndefined,
  buildContextEntries: () => [],
  buildSessionProjection: () => ({
    entries: [],
    messages: [],
    thinkingLevel: "off",
    model: null,
  }),
});

/**
 * The context the host gives an extension's event handlers and tools: `cwd` and the call's abort
 * signal, no UI, no models, an empty session, and no nested tool calls.
 */
export const hostContext = (
  options: HostContextOptions
): ExtensionToolContext => {
  const context: Omit<
    ExtensionToolContext,
    "ui" | "sessionManager" | "modelRegistry" | "model"
  > & {
    readonly ui: HostUi;
    readonly sessionManager: HostSession;
    readonly modelRegistry?: ExtensionContext["modelRegistry"];
    readonly model?: ExtensionContext["model"];
  } = {
    ui: noUi(options.events),
    mode: "print",
    hasUI: false,
    cwd: options.cwd,
    sessionManager: noSession(options),
    scopedModels: [],
    isIdle: Function.constFalse,
    isProjectTrusted: Function.constFalse,
    signal: options.signal,
    abort: Function.constVoid,
    hasPendingMessages: Function.constFalse,
    shutdown: Function.constVoid,
    getContextUsage: Function.constUndefined,
    compact: Function.constVoid,
    getSystemPrompt: () => "",
    tools: [],
    executeTool: async (name) =>
      await Promise.reject(
        new PiHostUnsupported({
          message: `The Cairn tools-only pi host cannot run ${name} as a nested call: pi tools run without a pi session.`,
          api: "executeTool",
        })
      ),
  };

  // SAFETY: pi types the context for a full pi session. The host has none: `modelRegistry` and
  // `model` are absent (pi's own context may leave `model` undefined; extensions that need models
  // fail with their own error text), and the UI and session manager answer every member a tool or
  // handler reaches with an inert value. Every other field has pi's type.
  // Verified by: PiToolAdapter.test.ts "a tool that asks the user is told no",
  // PiHost.test.ts "each folder's calls see their own session_start".
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return context as ExtensionToolContext;
};

/** A lifecycle event the host delivers. */
export type HostEvent =
  | { readonly type: "session_start"; readonly reason: "startup" }
  | { readonly type: "session_shutdown"; readonly reason: "quit" };

/**
 * Delivers `event` to every handler `extensions` registered for it, one after another in
 * registration order (pi's own order). A handler that throws does not stop the others; the failures
 * come back as sentences.
 */
export const deliver = (
  extensions: ReadonlyArray<Extension>,
  event: HostEvent,
  context: ExtensionToolContext
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.forEach(
    extensions.flatMap((extension) =>
      (extension.handlers.get(event.type) ?? []).map((handler) => ({
        path: extension.path,
        handler,
      }))
    ),
    ({ path, handler }) =>
      Effect.tryPromise({
        try: async () => await handler(event, context),
        catch: (cause) =>
          `${path} failed in ${event.type}: ${errorText(cause)}`,
      }).pipe(
        Effect.match({
          onFailure: (failure): ReadonlyArray<string> => [failure],
          onSuccess: (): ReadonlyArray<string> => [],
        })
      )
  ).pipe(Effect.map((failures) => failures.flat()));
