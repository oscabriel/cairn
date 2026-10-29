// The web client's build and dev server. Loopback only; `tools/dev.ts` picks an ephemeral port and
// points the proxy at a dev brain through CAIRN_DEV_BRAIN (for example http://127.0.0.1:41234), so
// production's 3774 is never touched (D49).

import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const brain = process.env.CAIRN_DEV_BRAIN;

/** The look catalogue's page, which `/__look` serves. */
const LOOK_CATALOGUE = "/src/next/ui/catalogue/index.html";

/**
 * Serves the look catalogue at `/__look` (with its query) from the dev server only: `apply:
 * "serve"` keeps the plugin out of `vite build`, whose single entry is index.html.
 */
const lookCatalogue = (): Plugin => ({
  name: "cairn-look-catalogue",
  apply: "serve",
  configureServer: (server) => {
    server.middlewares.use((request, _response, next) => {
      const url = request.url ?? "";

      if (/^\/__look\/?(?:\?|$)/u.test(url)) {
        request.url = `${LOOK_CATALOGUE}${url.slice(url.search(/\?|$/u))}`;
      }

      next();
    });
  },
});

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
  plugins: [
    tailwindcss(),
    foldkit({ devToolsMcpPort: false }),
    lookCatalogue(),
  ],
  server: { host: "127.0.0.1", port: 0, proxy },
});
