import { defineConfig } from "vitest/config";

// Add `projects: ["apps/*", "packages/*"]` once the first package exists; vitest refuses a glob that matches nothing.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "spikes/**"],
    passWithNoTests: true,
  },
});
