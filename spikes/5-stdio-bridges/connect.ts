// Spike 5: connect the Cairn bridges app's own account with the bridge key, without printing it.
// The key goes over Executor's HTTP API only, never as a tool argument, so no trace records it.
//   node connect.ts <app-id>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const env = Object.fromEntries(
	readFileSync(`${homedir()}/.config/cairn/phase-0.env`, "utf8")
		.split("\n")
		.filter((line) => line.includes("="))
		.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const token = readFileSync(`${homedir()}/.config/cairn/bridges.key`, "utf8").trim();
const base = `https://exec.gneiss.run/api/organizations/${env.EXECUTOR_ORG}`;
const app = process.argv[2];

const send = async (method: string, path: string, body?: unknown) => {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: { Authorization: `Bearer ${env.EXECUTOR_SETUP_TOKEN}`, "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	console.error(`${method} ${path.replace(/con_[\w-]+/, "con_…")}: ${response.status}`);
	if (!response.ok) throw new Error(text.replaceAll(token, "<key>"));
	return JSON.parse(text);
};

const request = await send("POST", `/apps/${app}/accounts/app/bridges/connections`, {});
const connection: string = request.connection ?? request.id ?? JSON.stringify(request).match(/con_[\w-]+/)?.[0];
const account = await send("POST", `/connections/${connection}/submit`, {
	method: "apiKey",
	label: "Bridge key",
	fields: { token },
});
console.log(`account ${account.id}`);
console.log(JSON.stringify(await send("GET", `/connections/${connection}`)).slice(0, 400));
