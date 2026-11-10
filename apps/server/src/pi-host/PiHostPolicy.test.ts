// Judges the allowlist's decisions (ADR 0039) as data: which name and version the brain's policy
// admits, skips by range or never names, and that each range is one vetted minor. The host's own
// tests (`PiHost.test.ts`) load fixture packages along the same three paths; nothing here reads the
// user's pi install.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  decidePackage,
  PI_HOST_POLICY,
  versionInRange,
} from "./PiHostPolicy.ts";

/** What the brain's policy decides for `name` at `version`, as its tag. */
const decision = (name: string, version: Option.Option<string>) =>
  decidePackage(PI_HOST_POLICY, name, version)._tag;

describe("the version range", () => {
  it("admits a release or prerelease of its own minor and nothing else", () => {
    assert.isTrue(versionInRange("0.47.0", "0.47.x"));
    assert.isTrue(versionInRange("0.47.12", "0.47.x"));
    assert.isTrue(versionInRange("0.47.1-beta.2", "0.47.x"));
    assert.isFalse(versionInRange("0.48.0", "0.47.x"));
    assert.isFalse(versionInRange("1.47.0", "0.47.x"));
    assert.isFalse(versionInRange("0.47", "0.47.x"));
  });

  it("an open range admits nothing", () => {
    for (const range of ["0.x", "*", "^0.47.0", ">=0.46.0", "0.47.0"]) {
      assert.isFalse(versionInRange("0.47.0", range), range);
    }
  });
});

describe("the brain's allowlist", () => {
  it("admits pi-web-access at each vetted minor, 0.46 and 0.47", () => {
    for (const version of ["0.46.0", "0.46.4", "0.47.0", "0.47.3"]) {
      assert.strictEqual(
        decision("pi-web-access", Option.some(version)),
        "Allowed",
        version
      );
    }
  });

  it("skips pi-web-access at a minor nobody vetted, or an unreadable version", () => {
    for (const version of ["0.45.0", "0.48.0", "1.0.0"]) {
      assert.strictEqual(
        decision("pi-web-access", Option.some(version)),
        "OutOfRange",
        version
      );
    }

    assert.strictEqual(decision("pi-web-access", Option.none()), "OutOfRange");
  });

  it("admits pi-fff 0.11 only", () => {
    assert.strictEqual(
      decision("@ff-labs/pi-fff", Option.some("0.11.0")),
      "Allowed"
    );
    assert.strictEqual(
      decision("@ff-labs/pi-fff", Option.some("0.12.0")),
      "OutOfRange"
    );
  });

  it("never names the packages it leaves alone", () => {
    for (const name of [
      "pi-claude-bridge",
      "pi-herdr-btw",
      "pi-unslop",
      "pi-skill-stacks",
    ]) {
      assert.strictEqual(decision(name, Option.some("0.46.0")), "NotAllowed");
    }
  });

  it("names each package's versions as one range per vetted minor", () => {
    for (const entry of PI_HOST_POLICY.packages) {
      assert.isNotEmpty(entry.versions, entry.name);

      for (const range of entry.versions) {
        assert.match(range, /^\d+\.\d+\.x$/u, `${entry.name}: ${range}`);
      }
    }
  });
});
