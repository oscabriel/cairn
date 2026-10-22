import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

// oxfmt has no `extends`: an `extends` key is silently ignored, so spread.
export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    ".agents/**",
    ".claude/**",
    // The phase plan and its notes are prose kept as written; oxfmt rewrites markdown inline code.
    "docs/phase-1/**",
    "spikes/**",
    "tools/oxlint/anti-slop/**",
    "pnpm-lock.yaml",
  ],
});
