import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

// oxfmt has no `extends`: an `extends` key is silently ignored, so spread.
export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    ".agents/**",
    ".claude/**",
    "spikes/**",
    "tools/oxlint/anti-slop/**",
    "pnpm-lock.yaml",
  ],
});
