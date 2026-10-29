// The boot JSON as the page receives it: rendered by `BootData`, injected by `Static.ts`, then read
// back the way a browser reads a script element's text. A project titled with `</script>` must not
// close the element, and an unreadable shell store must inject nothing rather than fail the page.

import { ProjectId } from "@cairn/protocol/Ids";
import { PROTOCOL_VERSION } from "@cairn/protocol/Rpc";
import type { ShellSnapshot as ShellSnapshotValue } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Schema } from "effect";

import { BootJson, injectBootJson } from "../http/Static.ts";
import { FALLBACK_DEFAULTS, SessionHello } from "../rpc/SessionHandlers.ts";
import { ShellSnapshot } from "../shell/ShellSnapshot.ts";
import { ShellStoreError } from "../shell/ShellStoreError.ts";
import { BootData, BootDataJson } from "./BootData.ts";

const VAPID = "B".repeat(87);

const at = DateTime.makeUnsafe("2026-10-22T12:00:00.000Z");

const SNAPSHOT: ShellSnapshotValue = {
  snapshotSequence: 42,
  projects: [
    {
      id: ProjectId.make("prj_boot"),
      title: "a </script><script>alert(1)</script> project",
      kind: "folder",
      workspaceRoot: "/home/owner/boot",
      repository: Option.none(),
      defaultModel: Option.none(),
      projectThreadId: Option.none(),
      createdAt: at,
      updatedAt: at,
    },
  ],
  threads: [],
};

const Hello = Layer.succeed(
  SessionHello,
  SessionHello.of({
    build: "abc123def456",
    defaults: Effect.succeed(FALLBACK_DEFAULTS),
    vapidPublicKey: Effect.succeedSome(VAPID),
  })
);

const shellWith = (load: ShellSnapshot["Service"]["load"]) =>
  Layer.succeed(ShellSnapshot, ShellSnapshot.of({ load }));

const renderWith = (shell: Layer.Layer<ShellSnapshot>) =>
  BootJson.use((boot) => boot.render).pipe(
    Effect.provide(BootData.pipe(Layer.provide([shell, Hello])))
  );

/** What a browser's `textContent` of the injected element gives back. */
const scriptText = (html: string) => {
  const match =
    /<script id="cairn-boot" type="application\/json">(?<json>.*?)<\/script>/su.exec(
      html
    );

  return Option.fromNullishOr(match?.groups?.json);
};

const decodeBoot = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(BootDataJson))
);

describe("boot data", () => {
  it.effect("injects the shell, protocol, build and push key", () =>
    Effect.gen(function* () {
      const json = yield* renderWith(shellWith(Effect.succeed(SNAPSHOT)));

      assert.isTrue(Option.isSome(json));

      const html = injectBootJson(
        "<!doctype html><html><head></head><body></body></html>",
        Option.getOrThrow(json)
      );

      // The title's `</script>` did not end the element early: the first close tag is ours.
      const text = Option.getOrThrow(scriptText(html));
      const boot = decodeBoot(text);

      assert.strictEqual(boot.protocol, PROTOCOL_VERSION);
      assert.strictEqual(boot.build, "abc123def456");
      assert.deepStrictEqual(boot.vapidPublicKey, Option.some(VAPID));
      assert.strictEqual(boot.shell.snapshotSequence, 42);
      assert.strictEqual(
        boot.shell.projects[0]?.title,
        "a </script><script>alert(1)</script> project"
      );
      assert.notInclude(text, "</script");
    })
  );

  it.effect("injects nothing when the shell store cannot be read", () =>
    Effect.gen(function* () {
      const json = yield* renderWith(
        shellWith(
          Effect.fail(
            new ShellStoreError({
              message: "The shell store failed in ShellSnapshot.load.",
              operation: "ShellSnapshot.load",
              cause: new Error("disk I/O error"),
            })
          )
        )
      );

      assert.isTrue(Option.isNone(json));
    })
  );
});
