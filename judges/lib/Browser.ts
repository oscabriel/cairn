// The browser judges' driver: system Chromium over the DevTools protocol, with the part of
// Playwright's API the judges call and nothing else (ADR 0044). A page, a context, a locator with
// auto-waiting and strict single-match behaviour, actionability before a click, real key events,
// touch, routes, WebSocket routes, init scripts and screenshots. The wire is `Cdp.ts`, the keyboard
// `BrowserKeys.ts`, and what runs in the page `BrowserPageScript.ts`.
//
// A port of intent from github.com/microsoft/playwright, packages/playwright-core/src/server (frames.ts,
// dom.ts, input.ts, chromium/crPage.ts, chromium/crInput.ts) and src/client/locator.ts, at v1.64.1:
// names, defaults and the order of an action's checks follow it, so a judge reads as it did. Written
// for Cairn; nothing a judge does not call was ported.
//
// Copyright (c) Microsoft Corporation. Licensed under the Apache License, Version 2.0; you may not
// use this file except in compliance with the License. A copy is at
// http://www.apache.org/licenses/LICENSE-2.0. Software distributed under the License is distributed
// on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

/* oxlint-disable no-await-in-loop, class-methods-use-this -- a driver retries one step after another, and its API keeps Playwright's shape (`page.waitForTimeout`, `context.newCDPSession`) */
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Predicate, Schema } from "effect";

import { KEYS, MODIFIER_BITS } from "./BrowserKeys.ts";
import type { KeyDescription } from "./BrowserKeys.ts";
import {
  fixedTimeScript,
  PAGE_DRIVER,
  socketCommand,
  webSocketRouteScript,
} from "./BrowserPageScript.ts";
import { startBrowser } from "./Cdp.ts";
import type { BrowserProcess, CdpSession } from "./Cdp.ts";

/** A raw protocol session on a page. */
export type CDPSession = CdpSession;

/** How long an action, a wait or a navigation may take unless the judge says otherwise. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The gaps between one try and the next while a locator waits. */
const BACKOFF_MS = [0, 20, 50, 100, 100, 250];

/** How long the network must be quiet for `networkidle`. */
const NETWORK_IDLE_MS = 500;

const POLL_MS = 10;

/** How long a click waits for the frame it caused before going on without it. */
const SETTLE_LIMIT_MS = 1000;

const CONTROL_OR_META = process.platform === "darwin" ? "Meta" : "Control";

const SOCKET_BINDING = "__cairnBrowserSocket";

/** Linux's defaults for a headless browser's generic font families, as Playwright sets them. */
const FONT_FAMILIES = {
  standard: "Times New Roman",
  fixed: "Monospace",
  serif: "Times New Roman",
  sansSerif: "Arial",
  cursive: "Comic Sans MS",
  fantasy: "Impact",
};

const PERMISSIONS = new Map([
  ["clipboard-read", "clipboardReadWrite"],
  ["clipboard-write", "clipboardSanitizedWrite"],
]);

/** What a protocol command rejects with once its page or browser is gone. */
const GONE =
  /closed|exited|Session with given id not found|Execution context was destroyed|Cannot find context|Inspected target navigated or closed/u;

/** Chromium's words for a page navigating out from under a command, which a retry survives. */
const NAVIGATING =
  /Execution context was destroyed|Cannot find context|Cannot find default execution context|Inspected target navigated or closed|Promise was collected/u;

// ---------------------------------------------------------------------------------------------
// What the protocol answers. Only the fields the driver reads.

const decodeCreatedContext = Schema.decodeUnknownSync(
  Schema.Struct({ browserContextId: Schema.String })
);

const decodeCreatedTarget = Schema.decodeUnknownSync(
  Schema.Struct({ targetId: Schema.String })
);

const decodeAttached = Schema.decodeUnknownSync(
  Schema.Struct({ sessionId: Schema.String })
);

const decodeFrameTree = Schema.decodeUnknownSync(
  Schema.Struct({
    frameTree: Schema.Struct({
      frame: Schema.Struct({
        id: Schema.String,
        loaderId: Schema.String,
        url: Schema.String,
      }),
    }),
  })
);

const decodeNavigate = Schema.decodeUnknownSync(
  Schema.Struct({
    loaderId: Schema.optional(Schema.String),
    errorText: Schema.optional(Schema.String),
  })
);

const decodeLifecycle = Schema.decodeUnknownSync(
  Schema.Struct({
    frameId: Schema.String,
    loaderId: Schema.String,
    name: Schema.String,
  })
);

const decodeFrameNavigated = Schema.decodeUnknownSync(
  Schema.Struct({
    frame: Schema.Struct({
      id: Schema.String,
      parentId: Schema.optional(Schema.String),
      loaderId: Schema.String,
      url: Schema.String,
      urlFragment: Schema.optional(Schema.String),
    }),
  })
);

const decodeWithinDocument = Schema.decodeUnknownSync(
  Schema.Struct({ frameId: Schema.String, url: Schema.String })
);

const decodeRequestSent = Schema.decodeUnknownSync(
  Schema.Struct({
    requestId: Schema.String,
    type: Schema.optional(Schema.String),
    request: Schema.Struct({ url: Schema.String }),
  })
);

const decodeRequestDone = Schema.decodeUnknownSync(
  Schema.Struct({ requestId: Schema.String })
);

const decodeSocketCreated = Schema.decodeUnknownSync(
  Schema.Struct({ requestId: Schema.String, url: Schema.String })
);

const decodeSocketFrame = Schema.decodeUnknownSync(
  Schema.Struct({
    requestId: Schema.String,
    response: Schema.Struct({
      opcode: Schema.Finite,
      payloadData: Schema.String,
    }),
  })
);

const RemoteValue = Schema.Struct({
  type: Schema.optional(Schema.String),
  value: Schema.optional(Schema.Json),
  unserializableValue: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

const ExceptionDetails = Schema.Struct({
  text: Schema.String,
  exception: Schema.optional(RemoteValue),
});

const decodeThrown = Schema.decodeUnknownSync(
  Schema.Struct({ exceptionDetails: ExceptionDetails })
);

const decodeConsole = Schema.decodeUnknownSync(
  Schema.Struct({ args: Schema.Array(RemoteValue) })
);

const decodeDialog = Schema.decodeUnknownSync(
  Schema.Struct({ type: Schema.String })
);

const decodeEvaluated = Schema.decodeUnknownSync(
  Schema.Struct({
    result: RemoteValue,
    exceptionDetails: Schema.optional(ExceptionDetails),
  })
);

const decodeLayoutMetrics = Schema.decodeUnknownSync(
  Schema.Struct({
    visualViewport: Schema.Struct({
      pageX: Schema.Finite,
      pageY: Schema.Finite,
      scale: Schema.Finite,
    }),
  })
);

const decodeCaptured = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.String })
);

const decodePaused = Schema.decodeUnknownSync(
  Schema.Struct({
    requestId: Schema.String,
    request: Schema.Struct({
      url: Schema.String,
      headers: Schema.Record(Schema.String, Schema.String),
      postData: Schema.optional(Schema.String),
      postDataEntries: Schema.optional(
        Schema.Array(Schema.Struct({ bytes: Schema.optional(Schema.String) }))
      ),
    }),
  })
);

const decodeBindingCalled = Schema.decodeUnknownSync(
  Schema.Struct({
    name: Schema.String,
    payload: Schema.String,
    executionContextId: Schema.Finite,
  })
);

const decodeSocketMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.Literals(["open", "message", "serverMessage"]),
      id: Schema.Finite,
      url: Schema.optional(Schema.String),
      data: Schema.optional(Schema.String),
    })
  )
);

// What the page-side driver answers (BrowserPageScript.ts).
const decodeAnswer = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("done"),
      value: Schema.optional(Schema.Json),
    }),
    Schema.Struct({ kind: Schema.Literal("none") }),
    Schema.Struct({ kind: Schema.Literal("retry"), reason: Schema.String }),
    Schema.Struct({
      kind: Schema.Literal("strict"),
      count: Schema.Finite,
      previews: Schema.Array(Schema.String),
    }),
  ])
);

const decodePoint = Schema.decodeUnknownSync(
  Schema.Struct({ x: Schema.Finite, y: Schema.Finite })
);

const Box = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

const decodeBox = Schema.decodeUnknownSync(Schema.NullOr(Box));

const decodeSize = Schema.decodeUnknownSync(
  Schema.Struct({ width: Schema.Finite, height: Schema.Finite })
);

const decodeNullableString = Schema.decodeUnknownSync(
  Schema.NullOr(Schema.String)
);

const decodeString = Schema.decodeUnknownSync(Schema.String);

const decodeStrings = Schema.decodeUnknownSync(Schema.Array(Schema.String));

const decodeCount = Schema.decodeUnknownSync(Schema.Finite);

const decodeBoolean = Schema.decodeUnknownSync(Schema.Boolean);

const decodeWaited = Schema.decodeUnknownSync(
  Schema.Struct({
    done: Schema.Boolean,
    value: Schema.optional(Schema.Json),
  })
);

// ---------------------------------------------------------------------------------------------
// The public shapes.

/** A locator's wait or a navigation ran out of time. */
export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

/** A function run in the page (its text is sent, so it closes over nothing), or an expression. */
export type PageFunction<A, R> = ((arg: A) => R | Promise<R>) | string;

/** How `Browser.newContext` emulates a device; each default is a plain desktop page. */
export interface BrowserContextOptions {
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly screen?: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor?: number;
  readonly isMobile?: boolean;
  readonly hasTouch?: boolean;
  readonly colorScheme?: "light" | "dark";
  readonly reducedMotion?: "reduce" | "no-preference";
  readonly timezoneId?: string;
  readonly locale?: string;
  readonly userAgent?: string;
  readonly permissions?: ReadonlyArray<"clipboard-read" | "clipboard-write">;
}

/** The iPhone 15 as Chromium emulates it: the phone-sized judges' soft-keyboard and typing device. */
export const IPHONE_15: BrowserContextOptions = {
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1",
  screen: { width: 393, height: 852 },
  viewport: { width: 393, height: 659 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

/**
 * A driver with one of its promises deliberately broken, for the driver's own test: `no-strict`
 * lets a locator act on the first of several matches, `no-auto-wait` gives up on the first try.
 */
export type BrowserControl = "no-strict" | "no-auto-wait";

/** How `chromium.launch` starts the browser. */
export interface LaunchOptions {
  readonly headless?: boolean;
  readonly control?: BrowserControl;
}

type LifecycleState = "commit" | "domcontentloaded" | "load" | "networkidle";

interface NavigationOptions {
  readonly waitUntil?: LifecycleState;
  readonly timeout?: number;
}

interface TimeoutOption {
  readonly timeout?: number;
}

interface WaitForOptions {
  readonly state?: "attached" | "detached" | "visible" | "hidden";
  readonly timeout?: number;
}

interface PointerOptions {
  readonly timeout?: number;
  readonly position?: { readonly x: number; readonly y: number };
}

interface WaitForFunctionOptions {
  readonly timeout?: number;
  readonly polling?: number | "raf";
}

interface ScreenshotOptions {
  readonly path?: string;
  readonly caret?: "hide";
  readonly animations?: "disabled" | "allow";
  /** Capture the whole scrollable page instead of the viewport. */
  readonly fullPage?: boolean;
}

interface HasText {
  readonly hasText?: string | RegExp;
}

interface FilterOptions extends HasText {
  readonly visible?: boolean;
}

interface RoleOptions {
  readonly name?: string | RegExp;
  readonly exact?: boolean;
}

/** A URL a route or a wait matches: a glob, a regular expression, or a test of the parsed URL. */
export type UrlMatcher = string | RegExp | ((url: URL) => boolean);

/** What `waitForFunction` resolves to: the truthy value the page function returned. */
export interface JSHandle<R> {
  jsonValue(): Promise<R>;
}

/** One console call in the page. */
export class ConsoleMessage {
  private readonly messageText: string;

  constructor(messageText: string) {
    this.messageText = messageText;
  }

  /** The call's arguments, joined by spaces. */
  text(): string {
    return this.messageText;
  }
}

/** One frame on a page's real socket: text as a string, binary as bytes. */
export interface SocketFrame {
  readonly payload: string | Buffer;
}

/** A real WebSocket the page opened; `on` sees its frames from the moment it was created. */
export class WebSocketHandle {
  private readonly socketUrl: string;
  private readonly listeners = {
    framesent: new Set<(frame: SocketFrame) => void>(),
    framereceived: new Set<(frame: SocketFrame) => void>(),
  };

  constructor(socketUrl: string) {
    this.socketUrl = socketUrl;
  }

  /** The URL the socket connected to. */
  url(): string {
    return this.socketUrl;
  }

  /** Calls `listener` for each frame in that direction. */
  on(
    event: "framesent" | "framereceived",
    listener: (frame: SocketFrame) => void
  ): void {
    this.listeners[event].add(listener);
  }

  /** Hands one frame to its listeners; the page's dispatch. */
  emit(event: "framesent" | "framereceived", frame: SocketFrame): void {
    for (const listener of this.listeners[event]) {
      listener(frame);
    }
  }
}

/** The request a route caught. */
export class RouteRequest {
  private readonly requestUrl: string;
  private readonly requestHeaders: Readonly<Record<string, string>>;
  private readonly body: Buffer | null;

  constructor(
    requestUrl: string,
    requestHeaders: Readonly<Record<string, string>>,
    body: Buffer | null
  ) {
    this.requestUrl = requestUrl;
    this.requestHeaders = requestHeaders;
    this.body = body;
  }

  /** The requested URL. */
  url(): string {
    return this.requestUrl;
  }

  /** The headers, with names in lower case. */
  headers(): Readonly<Record<string, string>> {
    return this.requestHeaders;
  }

  /** The request's body bytes, or null when it has none. */
  postDataBuffer(): Buffer | null {
    return this.body;
  }
}

/** What a route answers instead of the network. */
export interface FulfillOptions {
  readonly status: number;
  readonly json: Schema.Json;
}

/** A paused request: the handler lets it through or answers it. */
export class Route {
  private readonly session: CdpSession;
  private readonly requestId: string;
  private readonly caught: RouteRequest;

  constructor(session: CdpSession, requestId: string, caught: RouteRequest) {
    this.session = session;
    this.requestId = requestId;
    this.caught = caught;
  }

  /** The request this route holds. */
  request(): RouteRequest {
    return this.caught;
  }

  /** Lets the request through to the network. */
  async continue(): Promise<void> {
    await this.session.send("Fetch.continueRequest", {
      requestId: this.requestId,
    });
  }

  /** Answers the request without touching the network. */
  async fulfill(options: FulfillOptions): Promise<void> {
    await this.session.send("Fetch.fulfillRequest", {
      requestId: this.requestId,
      responseCode: options.status,
      responseHeaders: [{ name: "content-type", value: "application/json" }],
      body: Buffer.from(JSON.stringify(options.json)).toString("base64"),
    });
  }
}

/** The server side of a routed socket, from `WebSocketRoute.connectToServer`. */
export interface WebSocketRouteServer {
  /** Sends a frame to the real server. */
  send(message: string): void;
  /** Replaces forwarding: the handler sees each frame the server sends. */
  onMessage(handler: (message: string) => void): void;
}

/**
 * A socket the page opened while a WebSocket route was on. A frame with no handler is forwarded,
 * so `connectToServer` alone leaves the socket working.
 */
export class WebSocketRoute {
  /** The page-side handler, when the judge set one. */
  pageHandler: ((message: string) => void) | undefined;
  /** The server-side handler, when the judge set one. */
  serverHandler: ((message: string) => void) | undefined;
  /** Whether a real socket was asked for. */
  connected = false;

  private readonly socketUrl: string;
  private readonly command: (name: string, data?: string) => void;

  constructor(
    socketUrl: string,
    command: (name: string, data?: string) => void
  ) {
    this.socketUrl = socketUrl;
    this.command = command;
  }

  /** The URL the page asked for. */
  url(): string {
    return this.socketUrl;
  }

  /** Delivers a frame to the page. */
  send(message: string): void {
    this.command("toPage", message);
  }

  /** The handler sees each frame the page sends, instead of forwarding it. */
  onMessage(handler: (message: string) => void): void {
    this.pageHandler = handler;
  }

  /** Opens the real socket behind this one. */
  connectToServer(): WebSocketRouteServer {
    this.connected = true;
    this.command("connect");

    return {
      send: (message) => {
        this.command("toServer", message);
      },
      onMessage: (handler) => {
        this.serverHandler = handler;
      },
    };
  }

  /** Hands one frame from the page to the handler, or on to the server. */
  fromPage(message: string): void {
    if (this.pageHandler !== undefined) {
      this.pageHandler(message);
    } else if (this.connected) {
      this.command("toServer", message);
    }
  }

  /** Hands one frame from the server to the handler, or on to the page. */
  fromServer(message: string): void {
    if (this.serverHandler === undefined) {
      this.command("toPage", message);
    } else {
      this.serverHandler(message);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers.

/** A text or name to match, as the page-side driver takes it. */
type WireText =
  | { readonly text: string; readonly exact?: boolean }
  | { readonly regex: { readonly source: string; readonly flags: string } };

/** One link of a locator's chain, which the page-side driver walks left to right. */
type Step =
  | { readonly kind: "css"; readonly selector: string }
  | { readonly kind: "testId"; readonly id: string }
  | {
      readonly kind: "role";
      readonly role: "button" | "option" | "combobox";
      readonly name?: WireText;
    }
  | { readonly kind: "text"; readonly text: WireText }
  | { readonly kind: "hasText"; readonly text: WireText }
  | { readonly kind: "visible"; readonly visible: boolean }
  | { readonly kind: "nth"; readonly index: number };

const wireText = (text: string | RegExp, exact: boolean): WireText => {
  if (Predicate.isString(text)) {
    return { text, exact };
  }

  return { regex: { source: text.source, flags: text.flags } };
};

const json = (value: Schema.Json | ReadonlyArray<Step> | undefined): string =>
  JSON.stringify(value) ?? "undefined";

const globToRegExp = (glob: string): RegExp => {
  let source = "";

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob.charAt(index);

    if (char === "*" && glob.charAt(index + 1) === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replaceAll(/[$()+.?[\\\]^{|}]/gu, String.raw`\$&`);
    }
  }

  return new RegExp(`^${source}$`, "u");
};

const urlMatches = (matcher: UrlMatcher, url: string): boolean => {
  if (Predicate.isString(matcher)) {
    return globToRegExp(matcher).test(url);
  }

  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;

    return matcher.test(url);
  }

  return matcher(new URL(url));
};

const splitKeys = (keys: string): ReadonlyArray<string> => {
  const parts: Array<string> = [];
  let building = "";

  for (const char of keys) {
    if (char === "+" && building !== "") {
      parts.push(building);
      building = "";
    } else {
      building += char;
    }
  }

  parts.push(building);

  return parts;
};

const requestBody = (
  entries: ReadonlyArray<{ readonly bytes?: string | undefined }> | undefined,
  text: string | undefined
): Buffer | null => {
  if (entries !== undefined) {
    return Buffer.concat(
      entries.map((entry) => Buffer.from(entry.bytes ?? "", "base64"))
    );
  }

  return text === undefined ? null : Buffer.from(text);
};

const lowerCaseKeys = (
  headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );

/** Splits Chromium's `Name: message\n  at...` the way `Error` holds it. */
const toError = (description: string): Error => {
  const firstLine = description.split("\n", 1)[0] ?? description;
  const match = /^(?<name>[A-Za-z]*Error): (?<message>.*)$/u.exec(firstLine);
  const error = new Error(match?.groups?.message ?? firstLine);

  error.name = match?.groups?.name ?? "Error";
  error.stack = description;

  return error;
};

const remoteText = (value: typeof RemoteValue.Type): string => {
  if (Predicate.isString(value.value)) {
    return value.value;
  }

  return (
    value.description ??
    value.unserializableValue ??
    (value.value === undefined ? value.type : JSON.stringify(value.value)) ??
    ""
  );
};

/** A value `returnByValue` could not put in JSON. */
const unserializable = (text: string): number | bigint =>
  text.endsWith("n") ? BigInt(text.slice(0, -1)) : Number(text);

const awaitDeadline = async <A>(
  work: Promise<A>,
  timeout: number,
  what: string
): Promise<A> => {
  if (timeout === Number.POSITIVE_INFINITY) {
    return await work;
  }

  const { promise, reject } = Promise.withResolvers<never>();

  const timer = setTimeout(() => {
    reject(new TimeoutError(`${what}: Timeout ${String(timeout)}ms exceeded.`));
  }, timeout);

  try {
    return await Promise.race([work, promise]);
  } finally {
    clearTimeout(timer);
  }
};

/** An init script as text. */
export interface InitSource {
  readonly content: string;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- JSON.stringify takes any value; the judge's argument keeps its own type up to here
const argumentSource = <A>(arg: A): string =>
  JSON.stringify(arg) ?? "undefined";

const callExpression = <A, R>(
  fn: PageFunction<A, R>,
  arg: A | undefined
): string =>
  Predicate.isString(fn)
    ? `(async () => {
        const result = (0, eval)(${JSON.stringify(fn)});

        return typeof result === "function" ? result(${argumentSource(arg)}) : result;
      })()`
    : `(${fn.toString()})(${argumentSource(arg)})`;

/** A script as `Page.addScriptToEvaluateOnNewDocument` takes it; `arg` is already source text. */
const initSource = (
  script: PageFunction<never, unknown> | InitSource,
  arg: string
): string => {
  if (Predicate.isString(script)) {
    return script;
  }

  if ("content" in script) {
    return script.content;
  }

  return `(${script.toString()})(${arg})`;
};

const budget = (timeout: number): number =>
  timeout === 0 ? Number.POSITIVE_INFINITY : timeout;

// ---------------------------------------------------------------------------------------------
// The keyboard and the mouse.

/** The page's keyboard: real key events, one `Input.dispatchKeyEvent` at a time. */
export class Keyboard {
  private readonly session: CdpSession;
  private readonly held = new Set<string>();

  constructor(session: CdpSession) {
    this.session = session;
  }

  /** Types `text` a character at a time: a key where the US layout has one, an insertion otherwise. */
  async type(text: string): Promise<void> {
    for (const char of text) {
      await (KEYS.has(char) ? this.press(char) : this.insertText(char));
    }
  }

  /** Presses a key or a chord such as `ControlOrMeta+Shift+V`, and lets it all go again. */
  async press(keys: string): Promise<void> {
    const parts = splitKeys(keys);

    for (const part of parts) {
      await this.down(part);
    }

    for (const part of parts.toReversed()) {
      await this.up(part);
    }
  }

  /** Inserts text the way an IME commit does, with no key events. */
  async insertText(text: string): Promise<void> {
    await this.session.send("Input.insertText", { text });
  }

  private describeKey(name: string): KeyDescription {
    const key = KEYS.get(name === "ControlOrMeta" ? CONTROL_OR_META : name);

    if (key === undefined) {
      throw new Error(`Unknown key: "${name}"`);
    }

    const described =
      this.held.has("Shift") && key.shifted !== undefined ? key.shifted : key;

    const chord =
      this.held.size > 1 || (!this.held.has("Shift") && this.held.size === 1);

    return chord ? { ...described, text: "" } : described;
  }

  private mask(): number {
    let mask = 0;

    for (const modifier of this.held) {
      mask += MODIFIER_BITS.get(modifier) ?? 0;
    }

    return mask;
  }

  private async down(name: string): Promise<void> {
    const key = this.describeKey(name);

    if (MODIFIER_BITS.has(key.key)) {
      this.held.add(key.key);
    }

    await this.session.send("Input.dispatchKeyEvent", {
      type: key.text === "" ? "rawKeyDown" : "keyDown",
      modifiers: this.mask(),
      windowsVirtualKeyCode: key.keyCode,
      code: key.code,
      key: key.key,
      text: key.text,
      unmodifiedText: key.text,
      location: key.location,
      isKeypad: false,
    });
  }

  private async up(name: string): Promise<void> {
    const key = this.describeKey(name);

    this.held.delete(key.key);

    await this.session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: this.mask(),
      windowsVirtualKeyCode: key.keyCode,
      code: key.code,
      key: key.key,
      location: key.location,
      isKeypad: false,
    });
  }
}

/** The page's mouse. */
export class Mouse {
  private readonly session: CdpSession;
  private x = 0;
  private y = 0;

  constructor(session: CdpSession) {
    this.session = session;
  }

  /** Moves the pointer. */
  async move(x: number, y: number): Promise<void> {
    this.x = x;
    this.y = y;
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: "none",
      buttons: 0,
      x,
      y,
      modifiers: 0,
      force: 0,
    });
  }

  /** Scrolls the wheel where the pointer is. */
  async wheel(deltaX: number, deltaY: number): Promise<void> {
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: this.x,
      y: this.y,
      modifiers: 0,
      deltaX,
      deltaY,
    });
  }

  /** Moves to a point and clicks it with the left button. */
  async click(x: number, y: number): Promise<void> {
    await this.move(x, y);
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      buttons: 1,
      x,
      y,
      modifiers: 0,
      clickCount: 1,
      force: 0.5,
    });
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      buttons: 0,
      x,
      y,
      modifiers: 0,
      clickCount: 1,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// The locator.

/** One try at an action: its value, or why to try again. */
type Attempt<A> =
  | { readonly done: true; readonly value: A }
  | { readonly done: false; readonly reason: string };

/**
 * A chain of steps to elements, resolved afresh on every try. An action waits for its element and
 * refuses to choose between several; `count`, `all`, `allTextContents` and `evaluateAll` read
 * whatever is there now.
 */
export class Locator {
  private readonly page: Page;
  private readonly steps: ReadonlyArray<Step>;

  constructor(page: Page, steps: ReadonlyArray<Step>) {
    this.page = page;
    this.steps = steps;
  }

  /** The elements matching a CSS selector inside this locator's. */
  locator(selector: string, options?: HasText): Locator {
    const css = this.chain({ kind: "css", selector });

    return options === undefined ? css : css.filter(options);
  }

  /** The elements whose `data-testid` is `id`. */
  getByTestId(id: string): Locator {
    return this.chain({ kind: "testId", id });
  }

  /** The elements with an ARIA role, optionally named: only the roles a judge asks for. */
  getByRole(
    role: "button" | "option" | "combobox",
    options?: RoleOptions
  ): Locator {
    return this.chain(
      options?.name === undefined
        ? { kind: "role", role }
        : {
            kind: "role",
            role,
            name: wireText(options.name, options.exact ?? false),
          }
    );
  }

  /** The smallest elements containing `text`. */
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator {
    return this.chain({
      kind: "text",
      text: wireText(text, options?.exact ?? false),
    });
  }

  /** The elements that also pass a text or visibility test. */
  filter(options: FilterOptions): Locator {
    const steps = [...this.steps];

    if (options.hasText !== undefined) {
      steps.push({ kind: "hasText", text: wireText(options.hasText, false) });
    }

    if (options.visible !== undefined) {
      steps.push({ kind: "visible", visible: options.visible });
    }

    return new Locator(this.page, steps);
  }

  /** The first match. */
  first(): Locator {
    return this.nth(0);
  }

  /** The last match. */
  last(): Locator {
    return this.nth(-1);
  }

  /** The match at `index`, counting from the end when negative. */
  nth(index: number): Locator {
    return this.chain({ kind: "nth", index });
  }

  /** How many elements match right now. */
  async count(): Promise<number> {
    return decodeCount(await this.page.driverRaw("count", [json(this.steps)]));
  }

  /** A locator for each element matching right now. */
  async all(): Promise<ReadonlyArray<Locator>> {
    const count = await this.count();

    return Array.from({ length: count }, (_, index) => this.nth(index));
  }

  /** Each match's `textContent`, right now. */
  async allTextContents(): Promise<ReadonlyArray<string>> {
    return decodeStrings(
      await this.page.driverRaw("texts", [json(this.steps)])
    );
  }

  /** Each match's rendered text (`innerText`), right now. */
  async allInnerTexts(): Promise<ReadonlyArray<string>> {
    return decodeStrings(
      await this.page.driverRaw("innerTexts", [json(this.steps)])
    );
  }

  /** Whether the one match is visible now; false when nothing matches. */
  async isVisible(): Promise<boolean> {
    const answer = decodeAnswer(
      await this.page.driverRaw("isVisible", [json(this.actionSteps())])
    );

    if (answer.kind === "strict") {
      throw this.strictError(answer.count, answer.previews);
    }

    return answer.kind === "done" && decodeBoolean(answer.value);
  }

  /** Waits for the one match to reach a state; `visible` by default. */
  async waitFor(options: WaitForOptions = {}): Promise<void> {
    const state = options.state ?? "visible";

    await this.retry("locator.waitFor", options.timeout, async () =>
      this.answerOf(
        await this.page.driverRaw("state", [
          json(this.actionSteps()),
          json(state),
          "true",
        ])
      )
    );
  }

  /** The one match's `textContent`, once there is one. */
  async textContent(options: TimeoutOption = {}): Promise<string | null> {
    return decodeNullableString(
      await this.read("locator.textContent", "text", undefined, options)
    );
  }

  /** One attribute of the one match, once there is one. */
  async getAttribute(
    name: string,
    options: TimeoutOption = {}
  ): Promise<string | null> {
    return decodeNullableString(
      await this.read("locator.getAttribute", "attribute", name, options)
    );
  }

  /** The value of the one match, an input, once there is one. */
  async inputValue(options: TimeoutOption = {}): Promise<string> {
    return decodeString(
      await this.read("locator.inputValue", "inputValue", undefined, options)
    );
  }

  /** The one match's box in the viewport, or null when it renders no box. */
  async boundingBox(
    options: TimeoutOption = {}
  ): Promise<typeof Box.Type | null> {
    return decodeBox(
      await this.read("locator.boundingBox", "box", undefined, options)
    );
  }

  /** Focuses the one match. */
  async focus(options: TimeoutOption = {}): Promise<void> {
    await this.read("locator.focus", "focus", undefined, options);
  }

  /** Fires a synthetic click on the one match, with none of a real click's checks. */
  async dispatchEvent(
    type: "click",
    options: TimeoutOption = {}
  ): Promise<void> {
    await this.read("locator.dispatchEvent", type, undefined, options);
  }

  /** Scrolls the one match into view once it stops moving. */
  async scrollIntoViewIfNeeded(options: TimeoutOption = {}): Promise<void> {
    await this.retry(
      "locator.scrollIntoViewIfNeeded",
      options.timeout,
      async () =>
        this.answerOf(
          await this.page.driverRaw("scrollIntoView", [
            json(this.actionSteps()),
          ])
        )
    );
  }

  /**
   * Clicks the one match once it is visible, enabled and stable and nothing else would take the
   * click; a real mouse press and release.
   */
  async click(options: PointerOptions = {}): Promise<void> {
    const point = await this.pointer("locator.click", options);

    await this.page.mouse.click(point.x, point.y);
    await this.page.settle();
  }

  /** Taps the one match after the same checks as a click. The context needs `hasTouch`. */
  async tap(options: PointerOptions = {}): Promise<void> {
    if (!this.page.hasTouch()) {
      throw new Error(
        "locator.tap: The page does not support tap. Use hasTouch context option to enable touch support."
      );
    }

    const point = await this.pointer("locator.tap", options);

    await this.page.touchTap(point.x, point.y);
    await this.page.settle();
  }

  /** Replaces the one match's text in one insertion, once it is visible and editable. */
  async fill(value: string, options: TimeoutOption = {}): Promise<void> {
    await this.retry("locator.fill", options.timeout, async () =>
      this.answerOf(
        await this.page.driverRaw("prepareFill", [json(this.actionSteps())])
      )
    );

    const { keyboard } = this.page;

    await (value === ""
      ? keyboard.press("Delete")
      : keyboard.insertText(value));
  }

  /** Focuses the one match and presses a key or chord. */
  async press(keys: string, options: TimeoutOption = {}): Promise<void> {
    await this.focus(options);
    await this.page.keyboard.press(keys);
  }

  /** Selects the option of the one match, a `<select>`, with this value or label. */
  async selectOption(
    value: string,
    options: TimeoutOption = {}
  ): Promise<void> {
    await this.retry("locator.selectOption", options.timeout, async () =>
      this.answerOf(
        await this.page.driverRaw("selectOption", [
          json(this.actionSteps()),
          json(value),
        ])
      )
    );
  }

  /** Runs a function in the page on the one match, once there is one. */
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- E is how a judge annotates the element its page function takes, as with Playwright
  evaluate<R, E extends HTMLElement | SVGElement = HTMLElement | SVGElement>(
    fn: (element: E) => R | Promise<R>
  ): Promise<R>;
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- E is how a judge annotates the element its page function takes, as with Playwright
  evaluate<R, A, E extends HTMLElement | SVGElement = HTMLElement | SVGElement>(
    fn: (element: E, arg: A) => R | Promise<R>,
    arg: A
  ): Promise<R>;
  async evaluate<R, A>(
    fn: (element: never, arg: A) => R | Promise<R>,
    arg?: A
  ): Promise<R> {
    const steps = json(this.actionSteps());
    const argument = JSON.stringify(arg) ?? "undefined";

    return await this.retry(
      "locator.evaluate",
      undefined,
      async () =>
        await this.page.answerOfValue<R>(
          this,
          `(async () => {
          const found = ${PAGE_DRIVER}.one(${steps});

          return found.kind === "done"
            ? { kind: "done", value: await (${fn.toString()})(found.value, ${argument}) }
            : found;
        })()`
        )
    );
  }

  /** Runs a function in the page on every match right now, which may be none. */
  async evaluateAll<
    R,
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- E is how a judge annotates the element its page function takes, as with Playwright
    E extends HTMLElement | SVGElement = HTMLElement | SVGElement,
  >(fn: (elements: Array<E>) => R | Promise<R>): Promise<R> {
    return await this.page.evaluateExpression<R>(
      `(${fn.toString()})([...${PAGE_DRIVER}.all(${json(this.steps)})])`
    );
  }

  /** What error messages call this locator. */
  describe(): string {
    return JSON.stringify(this.steps);
  }

  /** The error an action raises on several matches. */
  strictError(count: number, previews: ReadonlyArray<string>): Error {
    return new Error(
      `strict mode violation: ${this.describe()} resolved to ${String(count)} elements:\n  ${previews.join("\n  ")}`
    );
  }

  /** Turns the page-side driver's answer into one try's result, or raises a strict violation. */
  answerOf(raw: Schema.Json | undefined): Attempt<Schema.Json | undefined> {
    const answer = decodeAnswer(raw);

    if (answer.kind === "strict") {
      throw this.strictError(answer.count, answer.previews);
    }

    if (answer.kind === "done") {
      return { done: true, value: answer.value };
    }

    return {
      done: false,
      reason: answer.kind === "none" ? "no element matches" : answer.reason,
    };
  }

  private chain(step: Step): Locator {
    return new Locator(this.page, [...this.steps, step]);
  }

  /** The chain an action resolves; the `no-strict` control quietly takes the first match. */
  private actionSteps(): ReadonlyArray<Step> {
    return this.page.controlIs("no-strict")
      ? [...this.steps, { kind: "nth", index: 0 }]
      : this.steps;
  }

  private async read(
    what: string,
    reader: string,
    argument: string | undefined,
    options: TimeoutOption
  ): Promise<Schema.Json | undefined> {
    return await this.retry(what, options.timeout, async () =>
      this.answerOf(
        await this.page.driverRaw("read", [
          json(this.actionSteps()),
          json(reader),
          json(argument),
        ])
      )
    );
  }

  private async pointer(what: string, options: PointerOptions) {
    return decodePoint(
      await this.retry(what, options.timeout, async (attempt) =>
        this.answerOf(
          await this.page.driverRaw("pointer", [
            json(this.actionSteps()),
            json(options.position),
            String(attempt),
          ])
        )
      )
    );
  }

  private async attemptWithin<A>(
    attempt: Promise<Attempt<A>>,
    left: number,
    what: string
  ): Promise<Attempt<A>> {
    try {
      return await awaitDeadline(attempt, left, what);
    } catch (error) {
      if (error instanceof TimeoutError) {
        return { done: false, reason: "the page did not answer in time" };
      }

      if (error instanceof Error && NAVIGATING.test(error.message)) {
        return { done: false, reason: "the page was navigating" };
      }

      throw error;
    }
  }

  /**
   * Tries until the page says done or the time is up. A navigation under a try counts as one more
   * reason to wait; a strict violation or a page error is raised at once.
   */
  private async retry<A>(
    what: string,
    timeout: number | undefined,
    attempt: (tries: number) => Promise<Attempt<A>>
  ): Promise<A> {
    const limit = this.page.timeoutOf(timeout);
    const deadline = Date.now() + limit;
    let reason = "nothing tried yet";

    for (let tries = 0; ; tries += 1) {
      const left = deadline - Date.now();

      if (left <= 0 || (tries > 0 && this.page.controlIs("no-auto-wait"))) {
        throw new TimeoutError(
          `${what}: Timeout ${String(limit)}ms exceeded waiting for ${this.describe()}: ${reason}`
        );
      }

      const outcome = await this.attemptWithin(attempt(tries), left, what);

      if (outcome.done) {
        return outcome.value;
      }

      ({ reason } = outcome);
      await sleep(
        Math.min(BACKOFF_MS[tries] ?? 100, Math.max(deadline - Date.now(), 0))
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The page.

type PageEventValue = Error | ConsoleMessage | WebSocketHandle | undefined;

/** One tab in a context: what a judge navigates, reads and types into. */
export class Page {
  /** The page's keyboard. */
  readonly keyboard: Keyboard;
  /** The page's mouse. */
  readonly mouse: Mouse;

  private readonly owner: BrowserContext;
  private readonly session: CdpSession;
  private readonly targetId: string;
  private readonly root: CdpSession;
  private readonly control: BrowserControl | undefined;
  private readonly listeners = new Map<string, Set<(value: never) => void>>();
  private readonly lifecycle = new Map<string, Set<string>>();
  private readonly inflight = new Map<string, string>();
  private readonly sockets = new Map<string, WebSocketHandle>();
  private readonly routes: Array<{
    readonly matcher: UrlMatcher;
    readonly handler: (route: Route) => void | Promise<void>;
  }> = [];
  private readonly socketRoutes: Array<{
    readonly matcher: UrlMatcher;
    readonly handler: (socket: WebSocketRoute) => void;
  }> = [];
  private readonly routedSockets = new Map<string, WebSocketRoute>();
  private viewport: { readonly width: number; readonly height: number };
  private screen: { readonly width: number; readonly height: number };
  private mainFrame = "";
  private loaderId = "";
  private currentUrl = "about:blank";
  private lastNetworkAt = 0;
  private defaultTimeout = DEFAULT_TIMEOUT_MS;

  constructor(
    owner: BrowserContext,
    session: CdpSession,
    root: CdpSession,
    targetId: string,
    control: BrowserControl | undefined
  ) {
    this.owner = owner;
    this.session = session;
    this.root = root;
    this.targetId = targetId;
    this.control = control;
    this.keyboard = new Keyboard(session);
    this.mouse = new Mouse(session);
    this.viewport = owner.options.viewport ?? { width: 1280, height: 720 };
    this.screen = owner.options.screen ?? this.viewport;
  }

  /** Wires the page's events and applies its context's emulation; `BrowserContext.newPage`'s. */
  async initialize(initScripts: ReadonlyArray<string>): Promise<void> {
    this.listen();

    const { options } = this.owner;

    await Promise.all([
      this.session.send("Page.enable"),
      this.session.send("Page.setLifecycleEventsEnabled", { enabled: true }),
      this.session.send("Runtime.enable"),
      this.session.send("Network.enable"),
      this.session.send("Emulation.setFocusEmulationEnabled", {
        enabled: true,
      }),
      this.session.send("Page.setFontFamilies", {
        fontFamilies: FONT_FAMILIES,
      }),
      this.session.send("Emulation.setEmulatedMedia", {
        media: "",
        features: [
          {
            name: "prefers-color-scheme",
            value: options.colorScheme ?? "light",
          },
          {
            name: "prefers-reduced-motion",
            value: options.reducedMotion ?? "no-preference",
          },
          { name: "forced-colors", value: "none" },
          { name: "prefers-contrast", value: "no-preference" },
        ],
      }),
      this.applyViewport(),
    ]);

    if (options.hasTouch === true) {
      await this.session.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
      });
    }

    if (options.userAgent !== undefined || options.locale !== undefined) {
      await this.session.send("Emulation.setUserAgentOverride", {
        userAgent: options.userAgent ?? "",
        acceptLanguage: options.locale ?? "",
      });
    }

    if (options.locale !== undefined) {
      await this.session.send("Emulation.setLocaleOverride", {
        locale: options.locale,
      });
    }

    if (options.timezoneId !== undefined) {
      await this.session.send("Emulation.setTimezoneOverride", {
        timezoneId: options.timezoneId,
      });
    }

    await Promise.all(
      initScripts.map(async (source) => {
        await this.addSource(source);
      })
    );

    const { frameTree } = decodeFrameTree(
      await this.session.send("Page.getFrameTree")
    );

    this.mainFrame = frameTree.frame.id;
    this.loaderId = frameTree.frame.loaderId;
    this.currentUrl = frameTree.frame.url;
  }

  /** Listens for a page event. */
  on(event: "pageerror", listener: (error: Error) => void): void;
  on(event: "console", listener: (message: ConsoleMessage) => void): void;
  on(event: "load", listener: () => void): void;
  on(event: "websocket", listener: (socket: WebSocketHandle) => void): void;
  on(event: string, listener: (value: never) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();

    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  /** The URL the page is on, hash included. */
  url(): string {
    return this.currentUrl;
  }

  /** Changes how long this page's actions, waits and navigations may take from now on. */
  setDefaultTimeout(timeout: number): void {
    this.defaultTimeout = timeout;
  }

  /** The time a call may take: its own timeout or the page's; none at all for 0. */
  timeoutOf(timeout: number | undefined): number {
    return budget(timeout ?? this.defaultTimeout);
  }

  /** The viewport as it is now. */
  viewportSize(): { readonly width: number; readonly height: number } {
    return this.viewport;
  }

  /** Whether the context emulates a touch screen. */
  hasTouch(): boolean {
    return this.owner.options.hasTouch === true;
  }

  /** Whether this page's browser is a broken control of this kind. */
  controlIs(control: BrowserControl): boolean {
    return this.control === control;
  }

  /** A locator for a CSS selector. */
  locator(selector: string, options?: HasText): Locator {
    return new Locator(this, []).locator(selector, options);
  }

  /** A locator for a `data-testid`. */
  getByTestId(id: string): Locator {
    return new Locator(this, []).getByTestId(id);
  }

  /** A locator for an ARIA role. */
  getByRole(
    role: "button" | "option" | "combobox",
    options?: RoleOptions
  ): Locator {
    return new Locator(this, []).getByRole(role, options);
  }

  /** A locator for the smallest elements containing some text. */
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator {
    return new Locator(this, []).getByText(text, options);
  }

  /** Clicks the first match of a selector, with a locator click's checks. */
  async click(selector: string, options: PointerOptions = {}): Promise<void> {
    await this.locator(selector).first().click(options);
  }

  /** One attribute of the first match of a selector, once there is one. */
  async getAttribute(
    selector: string,
    name: string,
    options: TimeoutOption = {}
  ): Promise<string | null> {
    return await this.locator(selector).first().getAttribute(name, options);
  }

  /** Waits for the first match of a selector to reach a state; `visible` by default. */
  async waitForSelector(
    selector: string,
    options: WaitForOptions = {}
  ): Promise<void> {
    await this.locator(selector).first().waitFor(options);
  }

  /** Navigates and waits for `waitUntil`, `load` by default. Rejects with Chromium's net error. */
  async goto(url: string, options: NavigationOptions = {}): Promise<void> {
    const timeout = this.timeoutOf(options.timeout);
    const startedAt = Date.now();

    const answer = decodeNavigate(
      await awaitDeadline(
        this.session.send("Page.navigate", { url }),
        timeout,
        "page.goto"
      )
    );

    if (answer.errorText !== undefined && answer.errorText !== "") {
      throw new Error(`page.goto: ${answer.errorText} at ${url}`);
    }

    if (answer.loaderId !== undefined) {
      await this.waitForLoader(
        answer.loaderId,
        options.waitUntil ?? "load",
        timeout - (Date.now() - startedAt)
      );
    }
  }

  /** Reloads and waits for `waitUntil`, `load` by default. */
  async reload(options: NavigationOptions = {}): Promise<void> {
    const timeout = this.timeoutOf(options.timeout);
    const startedAt = Date.now();
    const before = this.loaderId;

    await this.session.send("Page.reload");
    await this.waitUntil(
      "page.reload",
      timeout,
      () => this.loaderId !== before
    );
    await this.waitForLoader(
      this.loaderId,
      options.waitUntil ?? "load",
      timeout - (Date.now() - startedAt)
    );
  }

  /** Waits for the URL to match, then for the document to have loaded. */
  async waitForURL(
    matcher: UrlMatcher,
    options: TimeoutOption = {}
  ): Promise<void> {
    await this.waitUntil(
      "page.waitForURL",
      this.timeoutOf(options.timeout),
      () => {
        const fired = this.lifecycle.get(this.loaderId);

        return (
          urlMatches(matcher, this.currentUrl) &&
          (fired === undefined || fired.has("load"))
        );
      }
    );
  }

  /** Waits a fixed time. */
  async waitForTimeout(ms: number): Promise<void> {
    await sleep(ms);
  }

  /** Runs a function or expression in the page and returns its JSON result. */
  evaluate<R>(fn: PageFunction<void, R>): Promise<R>;
  evaluate<R, A>(fn: PageFunction<A, R>, arg: A): Promise<R>;
  async evaluate<R, A>(fn: PageFunction<A, R>, arg?: A): Promise<R> {
    return await this.evaluateExpression<R>(callExpression(fn, arg));
  }

  /**
   * Polls a page function until it returns something truthy, every animation frame by default, and
   * resolves to that. A navigation under it restarts the poll.
   */
  waitForFunction<R>(
    fn: PageFunction<void, R>,
    arg?: undefined,
    options?: WaitForFunctionOptions
  ): Promise<JSHandle<R>>;
  waitForFunction<R, A>(
    fn: PageFunction<A, R>,
    arg: A,
    options?: WaitForFunctionOptions
  ): Promise<JSHandle<R>>;
  async waitForFunction<R, A>(
    fn: PageFunction<A, R>,
    arg?: A,
    options: WaitForFunctionOptions = {}
  ): Promise<JSHandle<R>> {
    const limit = this.timeoutOf(options.timeout);
    const deadline = Date.now() + limit;
    const polling = options.polling ?? "raf";

    const nextPoll =
      polling === "raf"
        ? "requestAnimationFrame(resolve);"
        : `setTimeout(resolve, ${String(polling)});`;

    while (Date.now() < deadline) {
      const left = Math.min(deadline - Date.now(), 2_147_000_000);

      const waited = await this.pollOnce(
        `(async () => {
          const until = performance.now() + ${String(left)};

          while (performance.now() < until) {
            const value = await ${callExpression(fn, arg)};

            if (value) {
              return { done: true, value };
            }

            await new Promise((resolve) => { ${nextPoll} });
          }

          return { done: false };
        })()`
      );

      if (waited.done) {
        const { value } = waited;

        return {
          jsonValue: async () => {
            await Promise.resolve();

            // SAFETY: the page function's own result came back by value; R is what the judge says
            // it returns, and the judges decode what they read from it.
            // Verified by: Browser.test.ts "waitForFunction resolves to the page's truthy value"
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            return value as R;
          },
        };
      }

      await sleep(POLL_MS);
    }

    throw new TimeoutError(
      `page.waitForFunction: Timeout ${String(limit)}ms exceeded.`
    );
  }

  /** Adds a script that runs in every document this page loads from now on, before its own code. */
  addInitScript(
    script: PageFunction<void, unknown> | InitSource
  ): Promise<void>;
  addInitScript<A>(script: PageFunction<A, unknown>, arg: A): Promise<void>;
  async addInitScript<A>(
    script: PageFunction<A, unknown> | InitSource,
    arg?: A
  ): Promise<void> {
    await this.addSource(initSource(script, argumentSource(arg)));
  }

  /** Adds a `<style>` to the current document. */
  async addStyleTag(options: { readonly content: string }): Promise<void> {
    await this.evaluate((content) => {
      const style = document.createElement("style");

      style.textContent = content;
      document.head.append(style);
    }, options.content);
  }

  /** Changes the viewport, and the emulated screen with it. */
  async setViewportSize(size: {
    readonly width: number;
    readonly height: number;
  }): Promise<void> {
    this.viewport = size;
    this.screen = size;
    await this.applyViewport();
  }

  /** Captures the viewport as a PNG, with the caret hidden, and writes it to `path` when given. */
  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    await this.evaluateExpression(
      `${PAGE_DRIVER}.prepareScreenshot(${String(options.animations === "disabled")})`
    );

    try {
      const { data } = decodeCaptured(
        await this.session.send(
          "Page.captureScreenshot",
          options.fullPage === true
            ? await this.fullPageCapture()
            : await this.viewportCapture()
        )
      );

      const png = Buffer.from(data, "base64");

      if (options.path !== undefined) {
        mkdirSync(path.dirname(options.path), { recursive: true });
        await writeFile(options.path, png);
      }

      return png;
    } finally {
      await this.evaluateExpression(`${PAGE_DRIVER}.restoreScreenshot()`).catch(
        () => null
      );
    }
  }

  /** Answers or lets through every request whose URL matches; the newest matching route wins. */
  async route(
    matcher: UrlMatcher,
    handler: (route: Route) => void | Promise<void>
  ): Promise<void> {
    if (this.routes.length === 0) {
      await this.session.send("Network.setCacheDisabled", {
        cacheDisabled: true,
      });
      await this.session.send("Fetch.enable", {
        patterns: [{ urlPattern: "*" }],
      });
    }

    this.routes.unshift({ matcher, handler });
  }

  /** Stands in for every WebSocket whose URL matches; takes effect from the next document. */
  async routeWebSocket(
    matcher: UrlMatcher,
    handler: (socket: WebSocketRoute) => void
  ): Promise<void> {
    if (this.socketRoutes.length === 0) {
      await this.session.send("Runtime.addBinding", { name: SOCKET_BINDING });
      await this.addSource(webSocketRouteScript(SOCKET_BINDING));
    }

    this.socketRoutes.unshift({ matcher, handler });
  }

  /** Closes the tab. */
  async close(): Promise<void> {
    await this.root.send("Target.closeTarget", { targetId: this.targetId });
  }

  /** A raw protocol session on this page, for what the driver does not wrap. */
  cdp(): CdpSession {
    return this.session;
  }

  /**
   * Waits for the frame an action caused, so a read right after a click sees what it drew. The app
   * renders on animation frames; a page the action navigated away has nothing to wait for.
   */
  async settle(): Promise<void> {
    try {
      await awaitDeadline(
        this.evaluateExpression(
          "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
        ),
        SETTLE_LIMIT_MS,
        "page.settle"
      );
    } catch (error) {
      const ended =
        error instanceof TimeoutError ||
        (error instanceof Error && GONE.test(error.message));

      if (!ended) {
        throw error;
      }
    }
  }

  /** Taps a point with the emulated touch screen. */
  async touchTap(x: number, y: number): Promise<void> {
    await Promise.all([
      this.session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        modifiers: 0,
        touchPoints: [{ x, y }],
      }),
      this.session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        modifiers: 0,
        touchPoints: [],
      }),
    ]);
  }

  /** Adds an already-rendered init script; the context's way in. */
  async addSource(source: string): Promise<void> {
    await this.session.send("Page.addScriptToEvaluateOnNewDocument", {
      source,
      runImmediately: true,
    });
  }

  /** Calls a method of the page-side driver with arguments already rendered as source. */
  async driverRaw(
    method: string,
    args: ReadonlyArray<string>
  ): Promise<Schema.Json | undefined> {
    return await this.evaluateExpression<Schema.Json | undefined>(
      `${PAGE_DRIVER}.${method}(${args.join(", ")})`
    );
  }

  /** Runs an expression that yields a page-side answer, whose `value` is the judge's own R. */
  async answerOfValue<R>(
    locator: Locator,
    expression: string
  ): Promise<Attempt<R>> {
    const attempt = locator.answerOf(
      await this.evaluateExpression<Schema.Json>(expression)
    );

    // SAFETY: `value` is what the judge's page function returned, by value; R is what the judge says
    // that function returns, and the judges decode what they read from it.
    // Verified by: Browser.test.ts "evaluate runs in the page on the one match"
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const typed = attempt as Attempt<R>;

    return typed;
  }

  /** Evaluates an expression in the page's main world, awaited and by value, as a user gesture. */
  async evaluateExpression<R>(expression: string): Promise<R> {
    const { result, exceptionDetails } = decodeEvaluated(
      await this.session.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
        silent: true,
      })
    );

    if (exceptionDetails !== undefined) {
      throw new Error(
        exceptionDetails.exception?.description ?? exceptionDetails.text
      );
    }

    const value =
      result.unserializableValue === undefined
        ? result.value
        : unserializable(result.unserializableValue);

    // SAFETY: the page's result came back by value; R is what the caller says its own page code
    // returns: the judges decode what they read, and the driver's own calls decode theirs.
    // Verified by: Browser.test.ts "evaluate returns the page function's result"
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const typed = value as R;

    return typed;
  }

  private async viewportCapture(): Promise<Schema.JsonObject> {
    const { visualViewport } = decodeLayoutMetrics(
      await this.session.send("Page.getLayoutMetrics")
    );

    return {
      format: "png",
      captureBeyondViewport: false,
      clip: {
        x: visualViewport.pageX,
        y: visualViewport.pageY,
        width: Math.ceil(this.viewport.width / visualViewport.scale),
        height: Math.ceil(this.viewport.height / visualViewport.scale),
        scale: visualViewport.scale,
      },
    };
  }

  private async fullPageCapture(): Promise<Schema.JsonObject> {
    const size = decodeSize(
      await this.evaluateExpression<Schema.Json>(
        `${PAGE_DRIVER}.fullPageSize()`
      )
    );

    return {
      format: "png",
      captureBeyondViewport:
        size.width > this.viewport.width || size.height > this.viewport.height,
      clip: { x: 0, y: 0, ...size, scale: 1 },
    };
  }

  /** One run of `waitForFunction`'s poll; a navigation under it counts as not done yet. */
  private async pollOnce(expression: string) {
    try {
      return decodeWaited(
        await this.evaluateExpression<Schema.Json>(expression)
      );
    } catch (error) {
      if (error instanceof Error && NAVIGATING.test(error.message)) {
        return { done: false, value: undefined };
      }

      throw error;
    }
  }

  private async applyViewport(): Promise<void> {
    const mobile = this.owner.options.isMobile === true;

    const landscape = this.screen.width > this.screen.height;

    await this.session.send("Emulation.setDeviceMetricsOverride", {
      mobile,
      width: this.viewport.width,
      height: this.viewport.height,
      screenWidth: this.screen.width,
      screenHeight: this.screen.height,
      deviceScaleFactor: this.owner.options.deviceScaleFactor ?? 1,
      screenOrientation:
        mobile && !landscape
          ? { angle: 0, type: "portraitPrimary" }
          : { angle: mobile ? 90 : 0, type: "landscapePrimary" },
    });
  }

  private emit(event: string, value?: PageEventValue): void {
    for (const listener of this.listeners.get(event) ?? []) {
      // SAFETY: `on`'s overloads tie each event name to its listener's parameter, and each `emit`
      // call passes that event's value. A Map cannot tie a key's type to its value's type.
      // Verified by: Browser.test.ts "reports page errors, console calls and socket frames"
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const typed = listener as (value?: PageEventValue) => void;

      typed(value);
    }
  }

  private async waitUntil(
    what: string,
    timeout: number,
    met: () => boolean
  ): Promise<void> {
    const deadline = Date.now() + timeout;

    while (!met()) {
      if (Date.now() >= deadline) {
        throw new TimeoutError(
          `${what}: Timeout ${String(timeout)}ms exceeded; the page is at ${this.currentUrl}`
        );
      }

      await sleep(POLL_MS);
    }
  }

  /**
   * Waits until `loaderId`'s navigation has committed and the page's current document, which a
   * later navigation may have replaced, has reached `state`.
   */
  private async waitForLoader(
    loaderId: string,
    state: LifecycleState,
    timeout: number
  ): Promise<void> {
    await this.waitUntil(`page waiting for ${state}`, timeout, () => {
      if (!this.lifecycle.has(loaderId)) {
        return false;
      }

      if (state === "commit") {
        return true;
      }

      const fired = this.lifecycle.get(this.loaderId);

      if (state === "domcontentloaded") {
        return fired?.has("DOMContentLoaded") === true;
      }

      return (
        fired?.has("load") === true &&
        (state === "load" ||
          (this.inflight.size === 0 &&
            Date.now() - this.lastNetworkAt >= NETWORK_IDLE_MS))
      );
    });
  }

  private onCommitted(loaderId: string): void {
    if (loaderId === this.loaderId) {
      return;
    }

    this.loaderId = loaderId;

    if (!this.lifecycle.has(loaderId)) {
      this.lifecycle.set(loaderId, new Set());
    }

    // The old document's requests die with it; the new document's own request is still running.
    for (const [requestId, type] of this.inflight) {
      if (type !== "Document") {
        this.inflight.delete(requestId);
      }
    }

    this.lastNetworkAt = Date.now();
  }

  private listen(): void {
    this.session.on("Page.lifecycleEvent", (raw) => {
      const event = decodeLifecycle(raw);

      if (event.frameId !== this.mainFrame) {
        return;
      }

      const fired = this.lifecycle.get(event.loaderId) ?? new Set<string>();

      fired.add(event.name);
      this.lifecycle.set(event.loaderId, fired);

      if (event.name === "init") {
        this.onCommitted(event.loaderId);
      }
    });
    this.session.on("Page.frameNavigated", (raw) => {
      const { frame } = decodeFrameNavigated(raw);

      if (frame.parentId !== undefined) {
        return;
      }

      this.mainFrame = frame.id;
      this.currentUrl = `${frame.url}${frame.urlFragment ?? ""}`;
      this.onCommitted(frame.loaderId);
    });
    this.session.on("Page.navigatedWithinDocument", (raw) => {
      const event = decodeWithinDocument(raw);

      if (event.frameId === this.mainFrame) {
        this.currentUrl = event.url;
      }
    });
    this.session.on("Page.loadEventFired", () => {
      this.emit("load");
    });
    this.session.on("Page.javascriptDialogOpening", (raw) => {
      // As with no dialog listener: a `beforeunload` goes ahead, anything else is dismissed.
      this.background(
        this.session.send("Page.handleJavaScriptDialog", {
          accept: decodeDialog(raw).type === "beforeunload",
        })
      );
    });
    this.session.on("Network.requestWillBeSent", (raw) => {
      const event = decodeRequestSent(raw);

      if (!event.request.url.startsWith("data:")) {
        this.inflight.set(event.requestId, event.type ?? "Other");
        this.lastNetworkAt = Date.now();
      }
    });

    for (const finished of [
      "Network.loadingFinished",
      "Network.loadingFailed",
    ]) {
      this.session.on(finished, (raw) => {
        if (this.inflight.delete(decodeRequestDone(raw).requestId)) {
          this.lastNetworkAt = Date.now();
        }
      });
    }

    this.session.on("Network.webSocketCreated", (raw) => {
      const event = decodeSocketCreated(raw);
      const socket = new WebSocketHandle(event.url);

      this.sockets.set(event.requestId, socket);
      this.emit("websocket", socket);
    });
    this.session.on("Network.webSocketFrameSent", (raw) => {
      this.socketFrame("framesent", raw);
    });
    this.session.on("Network.webSocketFrameReceived", (raw) => {
      this.socketFrame("framereceived", raw);
    });
    this.session.on("Network.webSocketClosed", (raw) => {
      this.sockets.delete(decodeRequestDone(raw).requestId);
    });
    this.session.on("Runtime.exceptionThrown", (raw) => {
      const { exceptionDetails } = decodeThrown(raw);

      this.emit(
        "pageerror",
        toError(
          exceptionDetails.exception?.description ?? exceptionDetails.text
        )
      );
    });
    this.session.on("Runtime.consoleAPICalled", (raw) => {
      const event = decodeConsole(raw);

      this.emit(
        "console",
        new ConsoleMessage(event.args.map(remoteText).join(" "))
      );
    });
    this.session.on("Fetch.requestPaused", (raw) => {
      this.background(this.onRequestPaused(raw));
    });
    this.session.on("Runtime.bindingCalled", (raw) => {
      this.onBindingCalled(raw);
    });
  }

  /** Runs protocol work no judge is waiting on; a page gone by then is nothing to report. */
  private background(work: Promise<Schema.Json | undefined>): void {
    const settled = async (): Promise<void> => {
      try {
        await work;
      } catch (error) {
        if (!(error instanceof Error) || !GONE.test(error.message)) {
          throw error;
        }
      }
    };

    // A failure that gets past `settled` is a driver bug or a judge's handler throwing: an unhandled
    // rejection ends the judge, loudly, as it should.
    // oxlint-disable-next-line typescript/no-floating-promises
    settled();
  }

  private socketFrame(
    event: "framesent" | "framereceived",
    raw: Schema.Json
  ): void {
    const { requestId, response } = decodeSocketFrame(raw);

    this.sockets.get(requestId)?.emit(event, {
      payload:
        response.opcode === 1
          ? response.payloadData
          : Buffer.from(response.payloadData, "base64"),
    });
  }

  private async onRequestPaused(raw: Schema.Json): Promise<undefined> {
    const { requestId, request } = decodePaused(raw);

    const route = this.routes.find(({ matcher }) =>
      urlMatches(matcher, request.url)
    );

    if (route === undefined) {
      await this.session.send("Fetch.continueRequest", { requestId });

      return undefined;
    }

    await route.handler(
      new Route(
        this.session,
        requestId,
        new RouteRequest(
          request.url,
          lowerCaseKeys(request.headers),
          requestBody(request.postDataEntries, request.postData)
        )
      )
    );

    return undefined;
  }

  private onBindingCalled(raw: Schema.Json): void {
    const called = decodeBindingCalled(raw);

    if (called.name !== SOCKET_BINDING) {
      return;
    }

    const message = decodeSocketMessage(called.payload);
    const key = `${String(called.executionContextId)}:${String(message.id)}`;

    const command = (name: string, data?: string): void => {
      this.background(
        this.session.send("Runtime.evaluate", {
          contextId: called.executionContextId,
          expression: socketCommand(message.id, name, data),
        })
      );
    };

    const socket = this.routedSockets.get(key);

    if (message.kind === "message") {
      if (socket === undefined) {
        command("toServer", message.data);
      } else {
        socket.fromPage(message.data ?? "");
      }

      return;
    }

    if (message.kind === "serverMessage") {
      if (socket === undefined) {
        command("toPage", message.data);
      } else {
        socket.fromServer(message.data ?? "");
      }

      return;
    }

    const url = message.url ?? "";

    const route = this.socketRoutes.find(({ matcher }) =>
      urlMatches(matcher, url)
    );

    if (route === undefined) {
      command("connect");

      return;
    }

    const routed = new WebSocketRoute(url, command);

    this.routedSockets.set(key, routed);
    route.handler(routed);

    if (!routed.connected) {
      command("open");
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The context and the browser.

/** A clock a context's pages read. */
interface ContextClock {
  /** `Date` reads `time` from now on, in every document; timers keep running on real time. */
  setFixedTime(time: number | string | Date): Promise<void>;
}

/** An isolated browser profile: its own storage, emulation and init scripts. */
export class BrowserContext {
  /** The emulation this context was made with. */
  readonly options: BrowserContextOptions;
  /** The clock its pages read. */
  readonly clock: ContextClock;

  private readonly process: BrowserProcess;
  private readonly contextId: string;
  private readonly control: BrowserControl | undefined;
  private readonly openPages: Array<Page> = [];
  private readonly initScripts: Array<string> = [];

  constructor(
    process: BrowserProcess,
    contextId: string,
    options: BrowserContextOptions,
    control: BrowserControl | undefined
  ) {
    this.process = process;
    this.contextId = contextId;
    this.options = options;
    this.control = control;
    this.clock = {
      setFixedTime: async (time) => {
        await this.addInitScript({
          content: fixedTimeScript(new Date(time).getTime()),
        });
      },
    };
  }

  /** Opens a tab with this context's emulation and init scripts. */
  async newPage(): Promise<Page> {
    const { root } = this.process;

    const { targetId } = decodeCreatedTarget(
      await root.send("Target.createTarget", {
        url: "about:blank",
        browserContextId: this.contextId,
      })
    );

    const { sessionId } = decodeAttached(
      await root.send("Target.attachToTarget", { targetId, flatten: true })
    );

    const page = new Page(
      this,
      this.process.session(sessionId),
      root,
      targetId,
      this.control
    );

    await page.initialize(this.initScripts);
    this.openPages.push(page);

    return page;
  }

  /** The tabs this context opened. */
  pages(): ReadonlyArray<Page> {
    return this.openPages;
  }

  /** Adds a script that runs in every document of every page, before the document's own code. */
  addInitScript(
    script: PageFunction<void, unknown> | InitSource
  ): Promise<void>;
  addInitScript<A>(script: PageFunction<A, unknown>, arg: A): Promise<void>;
  async addInitScript<A>(
    script: PageFunction<A, unknown> | InitSource,
    arg?: A
  ): Promise<void> {
    const source = initSource(script, argumentSource(arg));

    this.initScripts.push(source);
    await Promise.all(
      this.openPages.map(async (page) => {
        await page.addSource(source);
      })
    );
  }

  /** A raw protocol session on a page, for what the driver does not wrap. */
  async newCDPSession(page: Page): Promise<CdpSession> {
    await Promise.resolve();

    return page.cdp();
  }

  /** Closes every tab and throws the profile away. */
  async close(): Promise<void> {
    await this.process.root.send("Target.disposeBrowserContext", {
      browserContextId: this.contextId,
    });
  }
}

/** A running Chromium. */
export class Browser {
  private readonly process: BrowserProcess;
  private readonly control: BrowserControl | undefined;
  private readonly openContexts: Array<BrowserContext> = [];

  constructor(process: BrowserProcess, control: BrowserControl | undefined) {
    this.process = process;
    this.control = control;
  }

  /** Makes an isolated context. */
  async newContext(
    options: BrowserContextOptions = {}
  ): Promise<BrowserContext> {
    const { browserContextId } = decodeCreatedContext(
      await this.process.root.send("Target.createBrowserContext", {
        disposeOnDetach: true,
      })
    );

    if (options.permissions !== undefined) {
      await this.process.root.send("Browser.grantPermissions", {
        browserContextId,
        permissions: options.permissions.map(
          (permission) => PERMISSIONS.get(permission) ?? permission
        ),
      });
    }

    const context = new BrowserContext(
      this.process,
      browserContextId,
      options,
      this.control
    );

    this.openContexts.push(context);

    return context;
  }

  /** A tab in a context of its own. */
  async newPage(options: BrowserContextOptions = {}): Promise<Page> {
    const context = await this.newContext(options);

    return await context.newPage();
  }

  /** The contexts this browser made. */
  contexts(): ReadonlyArray<BrowserContext> {
    return this.openContexts;
  }

  /** Stops the browser. */
  async close(): Promise<void> {
    await this.process.close();
  }
}

/** The system Chromium (`/usr/bin/chromium`, or the binary `CAIRN_CHROMIUM` names). */
export const chromium = {
  /** Starts it, headless unless told otherwise. Rejects when it cannot start. */
  launch: async (options: LaunchOptions = {}): Promise<Browser> =>
    new Browser(await startBrowser(options.headless ?? true), options.control),
};
