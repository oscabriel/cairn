// The role spec pattern: an alias, or a literal `provider/model` whose model id may hold `@` (a
// Workers AI id such as `@cf/meta/...`), each with an optional thinking suffix.

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { RoleSpec } from "./Roles.ts";

const decodes = Schema.is(RoleSpec);

describe("a role spec", () => {
  it("is an alias or a literal model, with a thinking suffix", () => {
    assert.deepStrictEqual(
      [
        "@worker",
        "@worker:high",
        "opencode-go/gpt-6-luna",
        "cloudflare-workers-ai/@cf/meta/llama-4-scout",
        "cloudflare-workers-ai/@cf/meta/llama-4-scout:low",
      ].map(decodes),
      [true, true, true, true, true]
    );
  });

  it("refuses a model with no provider and an alias outside the name rule", () => {
    assert.deepStrictEqual(
      ["gpt-6-luna", "@a-role-name-longer-than-24", "@Worker"].map(decodes),
      [false, false, false]
    );
  });
});
