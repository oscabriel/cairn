// Spike 2: capture t3code's rendered new-thread page for gen/gen.sh: runs/t3/{1440,390,390-sidebar}.html.
//   node gen/capture.mjs [runs/t3-session.json]
// The session is a read-only pairing: `t3 pair --scope orchestration:read --label cairn-parity-harness`, then open
// https://t3.gneiss.run/pair#token=<token> once in Playwright and save its storage state (see NOTES.md).
import { mkdirSync, writeFileSync } from "node:fs"

import { chromium } from "playwright"

const session = process.argv[2] ?? "runs/t3-session.json"
mkdirSync("runs/t3", { recursive: true })
const browser = await chromium.launch()
for (const [name, viewport, mobile, sidebar] of [
	["1440", { width: 1440, height: 900 }, false, false],
	["390", { width: 390, height: 844 }, true, false],
	["390-sidebar", { width: 390, height: 844 }, true, true],
]) {
	const context = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: "dark", storageState: session })
	const page = await context.newPage()
	await page.goto("https://t3.gneiss.run/", { waitUntil: "networkidle" })
	await page.waitForTimeout(2500)
	const dismiss = page.getByRole("button", { name: "Dismiss" })
	if (await dismiss.count()) await dismiss.first().click()
	if (sidebar) await page.getByRole("button", { name: "Toggle main sidebar" }).click()
	await page.waitForTimeout(800)
	writeFileSync(`runs/t3/${name}.html`, await page.content())
	await context.close()
}
await browser.close()
