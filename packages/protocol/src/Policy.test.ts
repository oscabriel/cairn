import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { PROGRAM_CODE_LIMIT_BYTES, ProgramPayload } from "./Policy.ts";
import { WIRE_STRING_LIMIT_BYTES } from "./Thread.ts";

const fits = Schema.is(ProgramPayload);

describe("a program record's code", () => {
  it("holds a program only as long as the thread stream sends whole", () => {
    assert.strictEqual(PROGRAM_CODE_LIMIT_BYTES, WIRE_STRING_LIMIT_BYTES);
  });

  it("counts UTF-8 bytes, so a program the wire would cut is refused at ask time", () => {
    const ascii = "x".repeat(WIRE_STRING_LIMIT_BYTES);
    // Three bytes each: 10,922 of them fit, 10,923 do not, far below the character count.
    assert.deepStrictEqual(
      [
        fits({ type: "program", code: ascii }),
        fits({ type: "program", code: `${ascii}x` }),
        fits({ type: "program", code: "€".repeat(10_922) }),
        fits({ type: "program", code: "€".repeat(10_923) }),
        fits({ type: "program", code: "😀".repeat(8192) }),
        fits({ type: "program", code: "😀".repeat(8193) }),
      ],
      [true, false, true, false, true, false]
    );
  });
});
