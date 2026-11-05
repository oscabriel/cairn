// The browser judges' wire: system Chromium started with `--remote-debugging-pipe`, one flat CDP
// connection over it, and a session per page. No dependency: `node:child_process` only.
//
// The launch flags are ported from github.com/microsoft/playwright,
// packages/playwright-core/src/server/chromium/chromiumSwitches.ts and chromium.ts, at v1.64.1:
// they are what keeps a judge's browser from throttling a background page, hiding a hover style or
// changing colour profile. Code rewritten for Cairn.
//
// Copyright (c) Microsoft Corporation. Licensed under the Apache License, Version 2.0; you may not
// use this file except in compliance with the License. A copy is at
// http://www.apache.org/licenses/LICENSE-2.0. Software distributed under the License is distributed
// on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Option, Schema } from "effect";

/** What a judge starts unless `CAIRN_CHROMIUM` names another binary. */
const DEFAULT_EXECUTABLE = "/usr/bin/chromium";

const DISABLED_FEATURES = [
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "DestroyProfileOnBrowserClose",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "HttpsUpgrades",
  "LensOverlay",
  "MediaRouter",
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "BlockOriginHeaderModificationOnRedirect",
  "AvoidCorsURLLoaderRestartOnRedirect",
  "Translate",
  "OptimizationHints",
  "NetworkTimeServiceQuerying",
  "AimEnabled",
];

const SWITCHES = [
  "--disable-field-trial-config",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-back-forward-cache",
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--disable-component-extensions-with-background-pages",
  "--disable-component-update",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  `--disable-features=${DISABLED_FEATURES.join(",")}`,
  "--enable-features=CDPScreenshotNewSurface",
  "--allow-pre-commit-input",
  "--disable-hang-monitor",
  "--disable-ipc-flooding-protection",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--force-color-profile=srgb",
  "--metrics-recording-only",
  "--no-first-run",
  "--password-store=basic",
  "--use-mock-keychain",
  "--no-service-autorun",
  "--disable-search-engine-choice-screen",
  "--unsafely-disable-devtools-self-xss-warnings",
  "--disable-infobars",
  "--disable-sync",
  "--no-sandbox",
];

const HEADLESS_SWITCHES = [
  "--headless=new",
  "--hide-scrollbars",
  "--mute-audio",
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];

const Envelope = Schema.Struct({
  id: Schema.optional(Schema.Finite),
  method: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Json),
  result: Schema.optional(Schema.Json),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});

const decodeEnvelope = Schema.decodeUnknownSync(
  Schema.fromJsonString(Envelope)
);

const decodeDetached = Schema.decodeUnknownSync(
  Schema.Struct({ sessionId: Schema.String })
);

interface Pending {
  readonly method: string;
  readonly sessionId: string | undefined;
  readonly resolve: (value: Schema.Json) => void;
  readonly reject: (error: Error) => void;
}

type Listener = (params: Schema.Json) => void;

/** A browser target (or the browser itself) that commands and events go through. */
export class CdpSession {
  private readonly connection: CdpConnection;
  private readonly sessionId: string | undefined;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(connection: CdpConnection, sessionId: string | undefined) {
    this.connection = connection;
    this.sessionId = sessionId;
  }

  /**
   * Sends one command and waits for Chromium's answer; rejects with Chromium's message, or when
   * the target or the browser goes away first. The answer is unparsed JSON: the caller decodes
   * what it reads.
   */
  async send(
    method: string,
    params: Schema.JsonObject = {}
  ): Promise<Schema.Json> {
    return await this.connection.send(this.sessionId, method, params);
  }

  /** Calls `listener` with the raw params of every `method` event on this session. */
  on(method: string, listener: Listener): void {
    const listeners = this.listeners.get(method) ?? new Set<Listener>();

    listeners.add(listener);
    this.listeners.set(method, listeners);
  }

  /** Hands one event to its listeners; the connection's dispatch. */
  emit(method: string, params: Schema.Json): void {
    for (const listener of this.listeners.get(method) ?? []) {
      listener(params);
    }
  }
}

/** The one pipe to a browser process, and the sessions multiplexed over it. */
class CdpConnection {
  readonly root: CdpSession;
  private readonly sessions = new Map<string, CdpSession>();
  private readonly pending = new Map<number, Pending>();
  private readonly write: (frame: string) => void;
  private nextId = 1;
  private closed: Option.Option<string> = Option.none();

  constructor(write: (frame: string) => void) {
    this.write = write;
    this.root = new CdpSession(this, undefined);
    this.root.on("Target.detachedFromTarget", (params) => {
      const { sessionId } = decodeDetached(params);

      this.sessions.delete(sessionId);
      this.rejectPending(
        (entry) => entry.sessionId === sessionId,
        "the page was closed"
      );
    });
  }

  /** The session for a target `Target.attachToTarget` attached. */
  session(sessionId: string): CdpSession {
    const session = new CdpSession(this, sessionId);

    this.sessions.set(sessionId, session);

    return session;
  }

  async send(
    sessionId: string | undefined,
    method: string,
    params: Schema.JsonObject
  ): Promise<Schema.Json> {
    const id = this.nextId;

    this.nextId += 1;

    if (Option.isSome(this.closed)) {
      throw new Error(`${method}: ${this.closed.value}`);
    }

    const { promise, resolve, reject } = Promise.withResolvers<Schema.Json>();

    this.pending.set(id, { method, sessionId, resolve, reject });
    this.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);

    return await promise;
  }

  /** Routes one frame off the pipe: an answer to its command, an event to its session. */
  receive(frame: string): void {
    const message = decodeEnvelope(frame);

    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);

      if (entry === undefined) {
        return;
      }

      this.pending.delete(message.id);

      if (message.error === undefined) {
        entry.resolve(message.result ?? null);
      } else {
        entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      }

      return;
    }

    if (message.method === undefined) {
      return;
    }

    const session =
      message.sessionId === undefined
        ? this.root
        : this.sessions.get(message.sessionId);

    session?.emit(message.method, message.params ?? null);
  }

  /** Fails everything in flight and every later command; the browser is gone. */
  close(reason: string): void {
    this.closed = Option.some(reason);
    this.rejectPending(() => true, reason);
  }

  private rejectPending(
    matches: (entry: Pending) => boolean,
    reason: string
  ): void {
    for (const [id, entry] of this.pending) {
      if (matches(entry)) {
        this.pending.delete(id);
        entry.reject(new Error(`${entry.method}: ${reason}`));
      }
    }
  }
}

/** A running Chromium: its root CDP session, and how it stops. */
export interface BrowserProcess {
  readonly root: CdpSession;
  /** The session for `sessionId`, which `Target.attachToTarget` returned. */
  session(sessionId: string): CdpSession;
  /** Closes the browser, kills it if it lingers, and removes its throwaway profile. */
  close(): Promise<void>;
}

const CLOSE_GRACE_MS = 5000;

/**
 * Starts Chromium with a throwaway profile and connects to it. Rejects, naming the binary and what
 * it printed, when it cannot start.
 */
export const startBrowser = async (
  headless: boolean
): Promise<BrowserProcess> => {
  const executable = process.env.CAIRN_CHROMIUM ?? DEFAULT_EXECUTABLE;
  const profile = mkdtempSync(path.join(os.tmpdir(), "cairn-chromium-"));

  // Without the session bus, Chromium cannot ask systemd for a scope of its own, which would take it
  // out of the judge's cgroup.
  const { DBUS_SESSION_BUS_ADDRESS: _bus, ...env } = process.env;

  const args = [...SWITCHES];

  if (headless) {
    args.push(...HEADLESS_SWITCHES);
  }

  args.push(
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "about:blank"
  );

  const child = spawn(executable, args, {
    env,
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });

  const stopNow = (): void => {
    child.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  };

  process.once("exit", stopNow);

  const [_stdin, _stdout, stderr, input, output] = child.stdio;

  let printed = "";

  stderr?.on("data", (chunk: Buffer) => {
    printed = `${printed}${chunk.toString()}`.slice(-2000);
  });

  if (
    input === null ||
    input === undefined ||
    output === null ||
    output === undefined ||
    !("write" in input)
  ) {
    throw new Error(
      `Chromium started without its debugging pipe: ${executable}`
    );
  }

  // A closed pipe's late write fails with EPIPE; the connection was told it closed by then.
  input.on("error", () => {
    // `connection.close` below rejects whatever was in flight.
  });

  const connection = new CdpConnection((frame) => {
    input.write(frame);
  });

  const chunks: Array<Buffer> = [];

  output.on("data", (chunk: Buffer) => {
    let rest = chunk;
    let end = rest.indexOf(0);

    while (end !== -1) {
      chunks.push(rest.subarray(0, end));
      connection.receive(Buffer.concat(chunks).toString());
      chunks.length = 0;
      rest = rest.subarray(end + 1);
      end = rest.indexOf(0);
    }

    if (rest.length > 0) {
      chunks.push(rest);
    }
  });

  const gone = once(child, "exit");

  child.once("error", (error) => {
    connection.close(`${executable} did not start: ${error.message}`);
  });
  child.once("exit", (code, signal) => {
    connection.close(
      `the browser exited (${String(code ?? signal)}): ${printed || "it printed nothing"}`
    );
  });

  await connection.root.send("Browser.getVersion");

  return {
    root: connection.root,
    session: (sessionId) => connection.session(sessionId),
    close: async () => {
      await connection.root.send("Browser.close").catch(() => null);
      await Promise.race([gone, sleep(CLOSE_GRACE_MS)]);
      stopNow();
      process.off("exit", stopNow);
    },
  };
};
