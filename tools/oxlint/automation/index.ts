// Cairn's own Effect discipline rules, written from the intent of rules in typeonce-dev/ai-automation
// as adapted by humanlayer/fold (see UPSTREAM.md). The rule ids match Fold's `automation/*` ids;
// `no-bare-effect-run` and `no-raw-test-limit` are Cairn's own.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { noAmbientNondeterminismRule } from "./rules/no-ambient-nondeterminism.ts";
import { noBareEffectRunRule } from "./rules/no-bare-effect-run.ts";
import { noRawTestLimitRule } from "./rules/no-raw-test-limit.ts";
import { noSilentErrorSwallowRule } from "./rules/no-silent-error-swallow.ts";

/**
 * Rules that keep time, randomness and failures inside Effect, where tests can see them, keep
 * Effects on the app's context, where the events log and the tracer see them, and keep a test's own
 * limits scaled by the test slack.
 */
const automationPlugin = eslintCompatPlugin({
  meta: { name: "automation" },
  rules: {
    "no-ambient-nondeterminism": noAmbientNondeterminismRule,
    "no-bare-effect-run": noBareEffectRunRule,
    "no-raw-test-limit": noRawTestLimitRule,
    "no-silent-error-swallow": noSilentErrorSwallowRule,
  },
});

export default automationPlugin;
