// Every Command that calls the brain goes through `withBoundary` (T19): a source check, so a new
// Command cannot reach the client without it. Push's Commands catch every cause themselves.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";

const SOURCE = path.resolve(import.meta.dirname, "..");

/** Command files whose every client call sits inside a `catchCause` instead. */
const CATCH_ALL = new Set(["push/Command.ts"]);

const commandFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      return commandFiles(full);
    }

    return entry.name === "Command.ts" ? [full] : [];
  });

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("the client boundary", () => {
  it("wraps every Command's read of the client", () => {
    const missing = commandFiles(SOURCE).flatMap((file) => {
      const relative = path.relative(SOURCE, file);
      const text = readFileSync(file, "utf-8");

      const reads =
        count(text, "CairnConnection.get") -
        count(text, "typeof CairnConnection.get");

      if (reads === 0 || CATCH_ALL.has(relative)) {
        return [];
      }

      return count(text, "withBoundary") - 1 >= reads ? [] : [relative];
    });

    expect(missing).toStrictEqual([]);
  });
});
