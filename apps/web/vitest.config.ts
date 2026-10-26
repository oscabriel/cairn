// Web tests run in happy-dom with Foldkit's Scene matchers registered. Foldkit ships ESM that Vite
// must transform, so it is inlined rather than handed to Node.

import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    environment: "happy-dom",
    name: "web",
    server: { deps: { inline: ["foldkit", "@foldkit/ui"] } },
    setupFiles: ["./vitest.setup.ts"],
  },
});
