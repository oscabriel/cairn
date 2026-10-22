// The web client's build and dev server. Loopback only; `tools/dev.ts` picks an ephemeral port and
// points the proxy at a dev brain through CAIRN_DEV_BRAIN (for example http://127.0.0.1:41234), so
// production's 3774 is never touched (D49).
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const brain = process.env.CAIRN_DEV_BRAIN;

const proxy =
  brain === undefined
    ? {}
    : {
        "/_cairn": { target: brain },
        "/api": { target: brain },
        "/ws": { target: brain, ws: true },
      };

export default defineConfig({
  build: { outDir: "dist", target: "es2023" },
  plugins: [tailwindcss(), foldkit({ devToolsMcpPort: false })],
  server: { host: "127.0.0.1", port: 0, proxy },
});
