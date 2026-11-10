// The thread stream's `cairn.*` documents (`STREAM_DOCUMENTS`) are exactly the `cairn.*` kinds a
// client may see (`VISIBLE_DOCUMENTS`), each with its protocol schema (`DOCUMENT_SCHEMAS`): a
// visible document with no token here would never reach a client, and one here that is not visible
// would leak a brain-only document onto the wire.

import { DOCUMENT_SCHEMAS } from "@cairn/protocol/JsonSchema";
import { VISIBLE_DOCUMENTS } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";

import { STREAM_DOCUMENTS } from "./PiDurableHarness.ts";

describe("the thread stream's documents", () => {
  it("are every cairn.* kind a client may see, each with its protocol schema", () => {
    const streamed = STREAM_DOCUMENTS.map((token) => token.definition.kind);

    assert.sameMembers(
      streamed,
      VISIBLE_DOCUMENTS.filter((kind) => kind.startsWith("cairn."))
    );
    assert.lengthOf(new Set(streamed), streamed.length);

    const described = new Set(DOCUMENT_SCHEMAS.map(([kind]) => kind));

    assert.deepStrictEqual(
      streamed.filter((kind) => !described.has(kind)),
      []
    );
  });
});
