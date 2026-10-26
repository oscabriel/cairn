// The PWA's static half: the manifest Cairn installs from, the service worker that only shows
// pushes (ADR 0021: no `fetch` listener, so a deploy never leaves a stale shell), and the toggle's
// rule that "off" stays off while the permission stays granted.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { vi } from "vitest";

import manifestText from "../../public/manifest.webmanifest?raw";
import worker from "../../public/sw.js?raw";
import { Message } from "./Message.ts";
import { loadDeviceId, loadPushWanted } from "./PushDevice.ts";
import { canPush, inform, init, update } from "./Update.ts";

/** The files under `public/icons/`, as `/icons/<name>` paths. */
const iconFiles = Object.keys(import.meta.glob("../../public/icons/*")).map(
  (file) => file.replace("../../public", "")
);

const Icon = Schema.Struct({
  src: Schema.String,
  sizes: Schema.String,
  type: Schema.String,
  purpose: Schema.String,
});

const Manifest = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  short_name: Schema.String,
  start_url: Schema.String,
  scope: Schema.String,
  display: Schema.String,
  icons: Schema.Array(Icon),
});

const manifest = Schema.decodeSync(Schema.fromJsonString(Manifest))(
  manifestText
);

describe("the web app manifest", () => {
  it("installs a standalone app at scope / with 192 and 512 icons and a maskable one", () => {
    assert.strictEqual(manifest.name, "Cairn");
    assert.strictEqual(manifest.start_url, "/");
    assert.strictEqual(manifest.scope, "/");
    assert.strictEqual(manifest.display, "standalone");

    const sizes = manifest.icons.map((icon) => icon.sizes);

    assert.include(sizes, "192x192");
    assert.include(sizes, "512x512");
    assert.isTrue(manifest.icons.some((icon) => icon.purpose === "maskable"));
  });

  it("names only icons that exist", () => {
    for (const icon of manifest.icons) {
      assert.include(iconFiles, icon.src);
    }
  });
});

describe("the service worker", () => {
  it("has no fetch listener", () => {
    assert.notMatch(worker, /addEventListener\(\s*["'`]fetch["'`]/u);
    assert.notMatch(worker, /\bonfetch\b/u);
  });

  it("handles install, activate, push and notificationclick", () => {
    for (const type of ["install", "activate", "push", "notificationclick"]) {
      assert.match(worker, new RegExp(`addEventListener\\(\\s*"${type}"`, "u"));
    }
  });

  it("shows every push", () => {
    assert.match(worker, /showNotification\(/u);
  });
});

const checked = (wanted: boolean) =>
  update(
    init().model,
    Message.CheckedDevice({
      support: "supported",
      permission: "granted",
      deviceId: "device-0001",
      wanted,
    })
  ).model;

describe("the push toggle", () => {
  it("re-checks the subscription at start only when the user turned push on here", () => {
    const wanted = checked(true);
    const notWanted = checked(false);

    assert.isTrue(canPush(wanted));
    assert.isFalse(wanted.synced);
    assert.isTrue(notWanted.synced);
    assert.strictEqual(notWanted.status._tag, "Off");
  });

  it("hands a tapped notification's path to the root", () => {
    const result = update(
      checked(true),
      Message.ReceivedOpenRequest({ path: "/t/abc" })
    );

    assert.deepStrictEqual(
      Option.fromNullishOr(result.outMessage).pipe(
        Option.map((out) => out.path)
      ),
      Option.some("/t/abc")
    );
  });
});

describe("the app badge at load", () => {
  it("is written once the device is checked, clearing one the service worker left", () => {
    const early = inform(init().model, { ...init().model.context, badge: 0 });

    const device = update(
      early.model,
      Message.CheckedDevice({
        deviceId: "device-0001",
        permission: "granted",
        support: "supported",
        wanted: true,
      })
    );

    const again = inform(device.model, { ...device.model.context, badge: 0 });
    const raised = inform(again.model, { ...again.model.context, badge: 2 });

    assert.lengthOf(early.commands ?? [], 0);
    assert.deepStrictEqual(
      device.commands?.map((command) => command.name),
      ["ShowBadge"]
    );
    assert.lengthOf(again.commands ?? [], 0);
    assert.deepStrictEqual(
      raised.commands?.map((command) => command.name),
      ["ShowBadge"]
    );
  });
});

describe("push device storage", () => {
  it.effect("gives a device id when storage throws", () =>
    Effect.gen(function* () {
      const getItem = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(() => {
          throw new Error("SecurityError");
        });

      const id = yield* loadDeviceId;
      const wanted = yield* loadPushWanted;

      getItem.mockRestore();

      assert.match(id, /^[A-Za-z0-9_-]{8,64}$/u);
      assert.isFalse(wanted);
    })
  );
});
