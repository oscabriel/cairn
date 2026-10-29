// Scene tests for the `next` input and textarea shells: the label names the control, typing sends
// its message, a hint describes the control until an error replaces it, an invalid field says so on
// the control and the shell, and a disabled one is disabled.

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import * as Scene from "foldkit/scene";

import { fieldDefaults, inputField, textareaField } from "./Field.ts";
import { appOf, expectSent, given, sent } from "./SceneFixture.ts";
import type { Message } from "./SceneFixture.ts";

const app = appOf((h) => [
  inputField(
    h,
    {
      ...fieldDefaults<Message>("budget", "Budget"),
      hint: Option.some("In dollars."),
    },
    {
      value: "",
      placeholder: Option.some("$5.00"),
      onInput: Option.some((value: string) => sent(value)),
    }
  ),
  inputField(
    h,
    {
      ...fieldDefaults<Message>("bad", "Bad"),
      hint: Option.some("Never shown with an error."),
      error: Option.some("A budget is a dollar amount."),
    },
    { value: "five", placeholder: Option.none(), onInput: Option.none() }
  ),
  textareaField(
    h,
    { ...fieldDefaults<Message>("note", "Send back with"), isDisabled: true },
    { value: "", placeholder: Option.none(), onInput: Option.none() },
    3
  ),
]);

describe("the next field", () => {
  it("is named by its label, sends what is typed, and is described by its hint", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.label("Budget")).toHaveId("budget"),
      Scene.expect(Scene.label("Budget")).toHaveAttr(
        "aria-describedby",
        "budget-hint"
      ),
      Scene.expect(Scene.label("Budget")).toHaveAccessibleDescription(
        "In dollars."
      ),
      Scene.expect(Scene.placeholder("$5.00")).toExist(),
      Scene.type(Scene.label("Budget"), "4"),
      expectSent("4"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("says an error on the control and the shell, in place of the hint", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.label("Bad")).toHaveAttr("aria-invalid", "true"),
      Scene.expect(Scene.label("Bad")).toHaveAttr(
        "aria-describedby",
        "bad-error"
      ),
      Scene.expect(Scene.selector("#bad-error")).toHaveText(
        "A budget is a dollar amount."
      ),
      Scene.expect(Scene.selector("#bad-hint")).not.toExist(),
      Scene.expect(
        Scene.selector('[data-slot="field-shell"][data-invalid]')
      ).toHaveClass("data-invalid:border-tone-failed"),
      Scene.expect(
        Scene.selector('[data-slot="field-shell"][aria-invalid]')
      ).not.toExist(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("draws a multi-line field, disabled when asked, with the shell's focus ring", () => {
    Scene.scene(
      app,
      given,
      Scene.expect(Scene.label("Send back with")).toHaveAttr("rows", "3"),
      Scene.expect(Scene.label("Send back with")).toBeDisabled(),
      Scene.expect(
        Scene.selector('[data-slot="field-shell"][data-disabled]')
      ).toExist(),
      Scene.expect(
        Scene.selector('[data-slot="field-shell"][aria-disabled]')
      ).not.toExist(),
      Scene.expect(Scene.selector('[data-slot="field-shell"]')).toHaveClass(
        "has-[:focus-visible]:outline-stroke-focus"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
