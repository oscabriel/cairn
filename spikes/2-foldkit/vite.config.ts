// Spike 2's dev server: Tailwind v4 over t3code's index.css, and Foldkit's plugin. Cairn's spike port, loopback only.
// Through Caddy (cairn-s2.gneiss.run) every request needs runs/page.key, as `?key=` once and then a cookie: the
// tailnet includes other people's devices, and the page shows thread titles.
import { existsSync, readFileSync } from "node:fs"

import { foldkit } from "@foldkit/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, type Plugin } from "vite"

const keyGate = (): Plugin => ({
	name: "spike-key-gate",
	configureServer: (server) => {
		server.middlewares.use((request, response, next) => {
			if (request.headers["x-forwarded-for"] === undefined) return next()
			const key = existsSync("runs/page.key") ? readFileSync("runs/page.key", "utf8").trim() : undefined
			const url = new URL(request.url ?? "/", "http://localhost")
			const cookie = /(?:^|; )s2key=([^;]+)/.exec(request.headers.cookie ?? "")?.[1]
			const given = url.searchParams.get("key") ?? cookie
			if (key === undefined || given !== key) {
				response.statusCode = 403
				response.end("forbidden")
				return
			}
			if (cookie !== key) response.setHeader("set-cookie", `s2key=${key}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400`)
			next()
		})
	},
})

export default defineConfig({
	plugins: [keyGate(), tailwindcss(), foldkit()],
	server: { host: "127.0.0.1", port: 3774, strictPort: true, allowedHosts: ["cairn-s2.gneiss.run"], hmr: process.env.CADDY_DEV_HOST ? { host: process.env.CADDY_DEV_HOST, protocol: "wss", clientPort: 443 } : undefined },
	preview: { host: "127.0.0.1", port: 3774, strictPort: true, allowedHosts: ["cairn-s2.gneiss.run"] },
})
