// Spike 5: call Executor's HTTP API with the phase 0 setup token.
//   node api.ts <METHOD> <path under /api/organizations/<org>> ['<json body>']
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const env = Object.fromEntries(
	readFileSync(`${homedir()}/.config/cairn/phase-0.env`, "utf8")
		.split("\n")
		.filter((line) => line.includes("="))
		.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const [method = "GET", path = "", body] = process.argv.slice(2);
const started = performance.now();
const response = await fetch(`https://exec.gneiss.run/api/organizations/${env.EXECUTOR_ORG}${path}`, {
	method,
	headers: { Authorization: `Bearer ${env.EXECUTOR_SETUP_TOKEN}`, "Content-Type": "application/json" },
	...(body === undefined ? {} : { body }),
});
console.error(`${response.status} in ${Math.round(performance.now() - started)} ms`);
console.log(await response.text());
