// The load module's rules: when a page reloads for a new build (once per server build, never
// without boot JSON), what counts as a request before interactive, and the page build read from the
// boot JSON the server inlines.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { socketUrl } from "../connection/Connection.ts";
import { BOOT_ELEMENT_ID } from "../shell/ShellStore.ts";
import { earlySocketUrl } from "./EarlySocket.ts";
import { requestsBefore } from "./LoadMark.ts";
import { readPageBuild, shouldReload } from "./StaleBuild.ts";

describe("stale build", () => {
  it("reloads once for a server build other than the page's", () => {
    assert.isTrue(shouldReload(Option.some("aaa"), "bbb", Option.none()));
    assert.isFalse(shouldReload(Option.some("aaa"), "bbb", Option.some("bbb")));
    assert.isTrue(shouldReload(Option.some("aaa"), "ccc", Option.some("bbb")));
  });

  it("never reloads for the same build or without boot JSON", () => {
    assert.isFalse(shouldReload(Option.some("aaa"), "aaa", Option.none()));
    assert.isFalse(shouldReload(Option.none(), "bbb", Option.none()));
  });

  it.effect("reads the page build from the boot JSON", () =>
    Effect.gen(function* () {
      const element = document.createElement("script");

      element.id = BOOT_ELEMENT_ID;
      element.type = "application/json";
      element.textContent = JSON.stringify({
        shell: { snapshotSequence: 0, projects: [], threads: [] },
        protocol: 2,
        build: "0123456789ab",
        vapidPublicKey: null,
      });
      document.head.append(element);

      const withBoot = yield* readPageBuild;

      element.textContent = "null";

      const withNull = yield* readPageBuild;

      element.remove();

      assert.deepStrictEqual(withBoot, Option.some("0123456789ab"));
      assert.deepStrictEqual(withNull, Option.none());
    })
  );
});

describe("early socket", () => {
  it("dials the URL the connection dials", () => {
    for (const origin of [
      "https://code.gneiss.run",
      "http://127.0.0.1:41234",
    ]) {
      assert.strictEqual(earlySocketUrl(origin), socketUrl(origin));
    }
  });
});

describe("requests before interactive", () => {
  it("counts the document, earlier resources and an early socket", () => {
    assert.strictEqual(requestsBefore([12, 40, 380, 900], 400, true), 5);
    assert.strictEqual(requestsBefore([12, 40, 380, 900], 400, false), 4);
    assert.strictEqual(requestsBefore([], 100, false), 1);
  });
});
