// Judges the tools-only pi host (ADR 0039) over fixture packages in a throwaway agent dir, with real
// tool calls through pi-durable on the faux model:
//
// - cwd isolation: two threads in two folders calling at once each see the folder their own
//   instance started in. The mutation control runs the same calls on a host that shares one
//   instance between folders and must fail them, which proves the judge can fail.
// - the allowlist: a package no policy names never runs its code, one outside its version range
//   loads nothing, and one that registers a provider is dropped while boot goes on.
// - the pool: concurrent first calls in one folder share one start, the least recently used idle
//   folder is shut down past the limit, and closing the host shuts every instance down.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { ThreadId } from "@cairn/protocol/Ids";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";

import { PiHost } from "./PiHost.ts";
import {
  brainLayer,
  callTool,
  fixturePolicy,
  hostLayer,
  makeFixture,
  STRANGER_MARKER,
} from "./PiHostTestKit.ts";
import type { HostFixture } from "./PiHostTestKit.ts";

const ALL = ["pi-host-fixture", "pi-host-provider", "pi-host-stranger"];

const thread = (n: number) =>
  ThreadId.make(
    `0190f0c0-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`
  );

/** The fixture's lifecycle log, one line each. */
const logLines = (fixture: HostFixture) =>
  readFileSync(fixture.log, "utf-8")
    .split("\n")
    .filter((line) => line !== "");

const count = (lines: ReadonlyArray<string>, line: string) =>
  lines.filter((each) => each === line).length;

/** Two threads in two folders call `fixture_where` at once; returns each one's folder and result. */
const whereAtOnce = (fixture: HostFixture, first: number) =>
  Effect.gen(function* () {
    const a = fixture.folder(`a${String(first)}`);
    const b = fixture.folder(`b${String(first)}`);

    const [inA = "", inB = ""] = yield* callTool(
      [
        { threadId: thread(first), cwd: a },
        { threadId: thread(first + 1), cwd: b },
      ],
      "fixture_where",
      { delayMs: 150 }
    );

    return { a, b, inA, inB };
  });

const isolated = makeFixture(ALL);

layer(
  brainLayer(
    hostLayer(isolated, fixturePolicy(isolated, { scope: "folder" })),
    path.join(isolated.root, "brain")
  ),
  { timeout: 60_000, excludeTestServices: true }
)("one instance per folder", (live) => {
  live.effect("each folder's calls see their own session_start", () =>
    Effect.gen(function* () {
      const { a, b, inA, inB } = yield* whereAtOnce(isolated, 1);

      assert.include(inA, `started in ${a}`);
      assert.include(inB, `started in ${b}`);
      assert.notInclude(inA, b);
      assert.notInclude(inB, a);
    })
  );

  live.effect(
    "loads only the allowed package, and boots without the refused one",
    () =>
      Effect.gen(function* () {
        const host = yield* PiHost;

        assert.deepStrictEqual(
          host.packages.map((loaded) => loaded.name),
          ["pi-host-fixture"]
        );

        const tools = (host.extension.extension.tools ?? []).map(
          (tool) => tool.name
        );

        assert.notInclude(tools, "provider_tool");
        assert.notInclude(tools, "stranger_tool");
        assert.isFalse(
          existsSync(STRANGER_MARKER),
          "the stranger's code never ran"
        );
      })
  );

  live.effect("concurrent first calls in one folder share one start", () =>
    Effect.gen(function* () {
      const shared = isolated.folder("shared");

      const results = yield* callTool(
        [
          { threadId: thread(10), cwd: shared },
          { threadId: thread(11), cwd: shared },
        ],
        "fixture_where",
        { delayMs: 50 }
      );

      for (const result of results) {
        assert.include(result, `started in ${shared}`);
      }

      assert.strictEqual(count(logLines(isolated), `start ${shared}`), 1);
    })
  );
});

// The mutation control: one shared instance, so the same calls cannot both see their own folder.
const shared = makeFixture(ALL);

layer(
  brainLayer(
    hostLayer(shared, fixturePolicy(shared, { scope: "brain" })),
    path.join(shared.root, "brain")
  ),
  { timeout: 60_000, excludeTestServices: true }
)("one instance shared between folders (mutation control)", (live) => {
  live.effect("fails the isolation check", () =>
    Effect.gen(function* () {
      const { a, b, inA, inB } = yield* whereAtOnce(shared, 20);

      assert.isFalse(
        inA.includes(`started in ${a}`) && inB.includes(`started in ${b}`),
        "a shared instance answered both folders correctly, so the isolation judge cannot fail"
      );
    })
  );
});

const pooled = makeFixture(["pi-host-fixture"]);

layer(
  brainLayer(
    hostLayer(
      pooled,
      fixturePolicy(pooled, { scope: "folder", folderInstances: 2 })
    ),
    path.join(pooled.root, "brain")
  ),
  { timeout: 60_000, excludeTestServices: true }
)("the folder pool", (live) => {
  live.effect(
    "shuts the least recently used idle folder down past its limit",
    () =>
      Effect.gen(function* () {
        const host = yield* PiHost;
        const folders = [1, 2, 3].map((n) => pooled.folder(`f${String(n)}`));

        for (const [index, folder] of folders.entries()) {
          yield* callTool(
            [{ threadId: thread(30 + index), cwd: folder }],
            "fixture_where",
            { delayMs: 0 }
          );
        }

        // The shutdown runs after the third call returned its instance.
        yield* Effect.sleep("100 millis");

        assert.deepStrictEqual(
          host.folders("pi-host-fixture"),
          folders.slice(1)
        );
        assert.strictEqual(
          count(logLines(pooled), `shutdown ${folders[0] ?? ""}`),
          1
        );

        const [again = ""] = yield* callTool(
          [{ threadId: thread(40), cwd: folders[0] ?? "" }],
          "fixture_where",
          { delayMs: 0 }
        );

        assert.include(again, `started in ${folders[0] ?? ""}`);
        assert.strictEqual(
          count(logLines(pooled), `start ${folders[0] ?? ""}`),
          2,
          "a folder shut down starts again on its next call"
        );
      })
  );
});

describe("the host's lifecycle and allowlist", () => {
  it.live("closing the host shuts every instance down", () =>
    Effect.gen(function* () {
      const fixture = makeFixture(["pi-host-fixture"]);
      const one = fixture.folder("one");
      const two = fixture.folder("two");

      yield* callTool(
        [
          { threadId: thread(50), cwd: one },
          { threadId: thread(51), cwd: two },
        ],
        "fixture_where",
        { delayMs: 0 }
      ).pipe(
        Effect.provide(
          brainLayer(
            hostLayer(fixture, fixturePolicy(fixture, { scope: "folder" })),
            path.join(fixture.root, "brain")
          )
        )
      );

      const lines = logLines(fixture);

      assert.strictEqual(count(lines, `shutdown ${one}`), 1);
      assert.strictEqual(count(lines, `shutdown ${two}`), 1);
    })
  );

  it.live("a package outside its version range loads nothing", () =>
    Effect.gen(function* () {
      const fixture = makeFixture(["pi-host-fixture"]);

      const host = yield* PiHost.pipe(
        Effect.provide(
          hostLayer(
            fixture,
            fixturePolicy(fixture, { scope: "brain", versions: "2.0.x" })
          )
        )
      );

      assert.deepStrictEqual(host.packages, []);
      assert.deepStrictEqual(host.extension.extension.tools, []);
      assert.deepStrictEqual(logLines(fixture), [], "its code never started");
    })
  );
});
