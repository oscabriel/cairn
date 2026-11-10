// Cairn's own Effect discipline rules, written from the intent of rules in typeonce-dev/ai-automation
// as adapted by humanlayer/fold (see UPSTREAM.md). The rule ids match Fold's `automation/*` ids;
// `no-bare-effect-run` is Cairn's own.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { noAmbientNondeterminismRule } from "./rules/no-ambient-nondeterminism.ts";
import { noBareEffectRunRule } from "./rules/no-bare-effect-run.ts";
import { noSilentErrorSwallowRule } from "./rules/no-silent-error-swallow.ts";

/**
 * Rules that keep time, randomness and failures inside Effect, where tests can see them, and keep
 * Effects on the app's context, where the events log and the tracer see them.
 */
const automationPlugin = eslintCompatPlugin({
  meta: { name: "automation" },
  rules: {
    "no-ambient-nondeterminism": noAmbientNondeterminismRule,
    "no-bare-effect-run": noBareEffectRunRule,
    "no-silent-error-swallow": noSilentErrorSwallowRule,
  },
});

export default automationPlugin;
