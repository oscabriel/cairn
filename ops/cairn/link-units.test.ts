// The deploy's unit links (ADR 0054): `link-units.sh` over a scratch live worktree and a scratch
// systemd user folder. A unit the deployed commit ships beside cairn.service (the nightly, its timer,
// its failure push) is linked when it has no link yet, so a new unit such as
// cairn-nightly-failed.service is known to systemd from the deploy that ships it; a link the user
// pointed elsewhere is left as it is, and --check changes nothing.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const script = path.join(import.meta.dirname, "link-units.sh");

const root = mkdtempSync(path.join(tmpdir(), "cairn-link-units-"));

const UNITS = [
  "cairn-nightly.service",
  "cairn-nightly.timer",
  "cairn-nightly-failed.service",
];

/** A live worktree carrying `units`, and an empty systemd user folder. */
const setup = (name: string, units: ReadonlyArray<string>) => {
  const live = path.join(root, name, "live");
  const systemd = path.join(root, name, "systemd");

  mkdirSync(path.join(live, "ops", "cairn"), { recursive: true });
  mkdirSync(systemd, { recursive: true });

  for (const unit of units) {
    writeFileSync(path.join(live, "ops", "cairn", unit), "[Unit]\n");
  }

  return { live, systemd };
};

const linkUnits = (systemd: string, args: ReadonlyArray<string>) => {
  const done = spawnSync("bash", [script, ...args], {
    encoding: "utf-8",
    env: { ...process.env, CAIRN_SYSTEMD_USER_DIR: systemd },
  });

  return { status: done.status, out: `${done.stdout}${done.stderr}` };
};

const linkOf = (systemd: string, unit: string) => {
  const link = path.join(systemd, unit);

  return existsSync(link) ? readlinkSync(link) : null;
};

describe("link-units.sh", () => {
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("links a unit the live worktree ships that has no link, and keeps the links it has", () => {
    const { live, systemd } = setup("new-unit", UNITS);

    for (const unit of UNITS.slice(0, 2)) {
      symlinkSync(
        path.join(live, "ops", "cairn", unit),
        path.join(systemd, unit)
      );
    }

    const result = linkUnits(systemd, [live]);

    expect(result.status).toBe(0);
    expect(result.out).toContain("linked");
    expect(result.out).toContain("cairn-nightly-failed.service");

    for (const unit of UNITS) {
      expect(linkOf(systemd, unit)).toBe(path.join(live, "ops", "cairn", unit));
    }
  });

  it("links nothing the live worktree does not carry", () => {
    const { live, systemd } = setup("old-commit", UNITS.slice(0, 2));

    const result = linkUnits(systemd, [live]);

    expect(result.status).toBe(0);
    expect(linkOf(systemd, "cairn-nightly-failed.service")).toBeNull();
    expect(result.out).toContain("cairn-nightly-failed.service");
  });

  it("leaves a link that points elsewhere, and says so", () => {
    const { live, systemd } = setup("elsewhere", UNITS);
    const other = path.join(root, "elsewhere", "mine.service");

    writeFileSync(other, "[Unit]\n");
    symlinkSync(other, path.join(systemd, "cairn-nightly-failed.service"));

    const result = linkUnits(systemd, [live]);

    expect(result.status).toBe(0);
    expect(linkOf(systemd, "cairn-nightly-failed.service")).toBe(other);
    expect(result.out).toContain("left as it is");
  });

  it("changes nothing with --check, and says what a deploy would link", () => {
    const { live, systemd } = setup("check", UNITS);

    const result = linkUnits(systemd, ["--check", live]);

    expect(result.status).toBe(0);
    expect(result.out).toContain("would link");

    for (const unit of UNITS) {
      expect(linkOf(systemd, unit)).toBeNull();
    }
  });
});
