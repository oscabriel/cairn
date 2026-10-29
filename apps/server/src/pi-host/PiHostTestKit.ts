// What the tools-only host's tests share: a throwaway pi agent dir holding copies of the fixture
// packages, a policy that allows the fixture, the host over that agent dir, and a brain on the faux
// model with the host's extension installed, so a test runs real tool calls through pi-durable.
// Never the user's ~/.pi/agent.

import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectId, RequestId } from "@cairn/protocol/Ids";
import type { ThreadId } from "@cairn/protocol/Ids";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { Effect, Fiber, Layer, Option, Predicate, Stream } from "effect";

import { BrainConfig } from "../brain/BrainConfig.ts";
import { ExtensionSet } from "../brain/ExtensionSet.ts";
import { FauxModels } from "../brain/FauxModels.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "../brain/ModelSource.ts";
import { PiDurableHarness } from "../brain/PiDurableHarness.ts";
import { ExecutorLink } from "../executor/ExecutorLink.ts";
import { ModelHealth } from "../models/ModelHealth.ts";
import { PiConfig } from "../models/PiConfig.ts";
import { PiHost } from "./PiHost.ts";
import type { InstanceScope, PiHostPolicy } from "./PiHostPolicy.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

/** One throwaway agent dir with the fixture packages installed, and the files the fixtures write. */
export interface HostFixture {
  readonly root: string;
  readonly agentDir: string;
  /** The fixture's `fixture-log`: a line per `session_start` and `session_shutdown`. */
  readonly log: string;
  /** A fresh empty folder for a thread to run in. */
  folder(name: string): string;
}

/**
 * `PI_HOST_STRANGER_MARKER` for every test in the process: the file exists only if the stranger's
 * code ever ran.
 */
export const STRANGER_MARKER = path.join(
  mkdtempSync(path.join(tmpdir(), "cairn-pi-host-stranger-")),
  "stranger.marker"
);

process.env.PI_HOST_STRANGER_MARKER = STRANGER_MARKER;

/**
 * A new agent dir whose settings.json names `packages` (fixture directory names), each installed
 * under `npm/node_modules`.
 */
export const makeFixture = (packages: ReadonlyArray<string>): HostFixture => {
  const root = mkdtempSync(path.join(tmpdir(), "cairn-pi-host-"));
  const agentDir = path.join(root, "agent");

  for (const name of packages) {
    cpSync(
      path.join(FIXTURES, name),
      path.join(agentDir, "npm", "node_modules", name),
      { recursive: true }
    );
  }

  writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ packages: packages.map((name) => `npm:${name}`) })
  );

  const log = path.join(root, "fixture.log");

  writeFileSync(log, "");

  return {
    root,
    agentDir,
    log,
    folder: (name) => {
      const dir = path.join(root, "folders", name);

      mkdirSync(dir, { recursive: true });

      return dir;
    },
  };
};

/** The fixture's flag value, as the host sets it. */
export const FIXTURE_FLAG = "set-by-host";

/**
 * A policy that allows `pi-host-fixture` (at `versions`, in `scope`) and `pi-host-provider`, with
 * `fixture_where` replay-safe and `fixture_disabled` dropped. `pi-host-stranger` is never named.
 */
export const fixturePolicy = (
  fixture: HostFixture,
  options: {
    readonly scope: InstanceScope;
    readonly versions?: string;
    readonly folderInstances?: number;
  }
): PiHostPolicy => ({
  packages: [
    {
      name: "pi-host-fixture",
      versions: options.versions ?? "1.2.x",
      scope: options.scope,
      flags: () =>
        new Map([
          ["fixture-flag", FIXTURE_FLAG],
          ["fixture-log", fixture.log],
        ]),
      env: () => new Map(),
      dropped: ["fixture_disabled"],
    },
    {
      name: "pi-host-provider",
      versions: "1.0.x",
      scope: "brain",
      flags: () => new Map(),
      env: () => new Map(),
      dropped: [],
    },
  ],
  safeTools: new Set(["fixture_where"]),
  folderInstances: options.folderInstances ?? 4,
});

/** The host over `fixture`'s agent dir, under `policy`. */
export const hostLayer = (fixture: HostFixture, policy: PiHostPolicy) =>
  PiHost.layerWith({ policy, root: path.join(fixture.root, "host") }).pipe(
    Layer.provide(
      PiConfig.layerWith({
        agentDir: fixture.agentDir,
        cwd: path.join(fixture.root, "pi-cwd"),
        home: path.join(fixture.root, "home"),
      })
    )
  );

/**
 * A brain on the faux model with the production set, whose `cairn.pi-tools` extension comes from
 * `host`, and the host itself.
 */
export const brainLayer = <E>(
  host: Layer.Layer<PiHost, E>,
  dataDir: string
) => {
  const extensions = ExtensionSet.layer.pipe(
    Layer.provide(ExecutorLink.layerDisabled),
    Layer.provide(ModelHealth.layerTest)
  );

  return PiDurableHarness.layer.pipe(
    Layer.provideMerge(extensions),
    Layer.provideMerge(
      ModelSource.layerFaux({
        tokensPerSecond: 4000,
        settings: { retry: { enabled: false } },
      })
    ),
    Layer.provide(BrainConfig.layerFrom(dataDir)),
    Layer.provideMerge(host)
  );
};

const isRunEnd = Predicate.isTagged("RunTerminal");

/** One thread's turn: where it runs and what its model calls. */
export interface ToolTurn {
  readonly threadId: ThreadId;
  readonly cwd: string;
}

/**
 * A faux model step that asks for `tool` first and answers once its result is in, whichever
 * thread's request reaches the faux model first.
 */
const stepFor =
  (tool: string, args: Record<string, number | string>): FauxResponseFactory =>
  (context) =>
    context.messages.at(-1)?.role === "toolResult"
      ? fauxAssistantMessage("done")
      : fauxAssistantMessage([fauxToolCall(tool, args, { id: "c1" })], {
          stopReason: "toolUse",
        });

/**
 * Runs one turn on every thread of `turns` at once; each model calls `tool` with `args`, then
 * answers. Returns each thread's tool result entry as JSON, in `turns` order.
 */
export const callTool = (
  turns: ReadonlyArray<ToolTurn>,
  tool: string,
  args: Record<string, number | string>
) =>
  Effect.gen(function* () {
    const seam = yield* HarnessSeam;
    const { faux } = yield* FauxModels;

    const step = stepFor(tool, args);

    faux.setResponses(turns.flatMap(() => [step, step]));

    for (const turn of turns) {
      yield* seam.ensureThread({
        threadId: turn.threadId,
        projectId: ProjectId.make("pi-host"),
        model: FAUX_MODEL,
        thinkingLevel: "off",
        cwd: turn.cwd,
        instructions: Option.none(),
        runtimeMode: "full-access",
      });
    }

    const ended = yield* Effect.forEach(turns, (turn) =>
      seam.events.pipe(
        Stream.filter(
          (event) => isRunEnd(event) && event.threadId === turn.threadId
        ),
        Stream.runHead,
        Effect.forkChild
      )
    );

    yield* Effect.sleep("20 millis");

    yield* Effect.forEach(
      turns,
      (turn) =>
        seam.submit(turn.threadId, {
          requestId: RequestId.make("r1"),
          content: [{ type: "text", text: "go" }],
          entry: Option.none(),
          whenBusy: "followUp",
        }),
      { concurrency: "unbounded", discard: true }
    );

    yield* Fiber.joinAll(ended);

    return yield* Effect.forEach(turns, (turn) =>
      Effect.gen(function* () {
        const [snapshot] = yield* seam
          .watch(turn.threadId)
          .pipe(Stream.take(1), Stream.runCollect);

        const result =
          snapshot?._tag === "Snapshot"
            ? snapshot.view.entries.find(
                (entry) => entry.kind === "pi.tool-result"
              )
            : undefined;

        return JSON.stringify(result ?? null);
      })
    );
  });
