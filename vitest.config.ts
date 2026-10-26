import { defineConfig } from "vitest/config";

// One project per app and package; the `root` project holds tests that live beside judges and ops
// scripts (judges/lib, for example). An app or package without its own config runs in Node.
export default defineConfig({
  test: {
    passWithNoTests: true,
    globalSetup: ["./tools/vitest-tmpdir.ts"],
    projects: [
      "apps/*",
      "packages/*",
      {
        test: {
          name: "root",
          include: [
            "judges/**/*.test.ts",
            "ops/**/*.test.ts",
            "tools/**/*.test.ts",
          ],
          exclude: ["**/node_modules/**", "spikes/**", "judges/fixtures/**"],
        },
      },
    ],
  },
});
