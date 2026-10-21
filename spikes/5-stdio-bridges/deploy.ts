// Spike 5: create or redeploy the Cairn bridges app from executor-app/, sending every file.
//   node deploy.ts            create the app, then deploy it
//   node deploy.ts <app-id>   deploy the directory as the app's whole source
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const env = Object.fromEntries(
	readFileSync(`${homedir()}/.config/cairn/phase-0.env`, "utf8")
		.split("\n")
		.filter((line) => line.includes("="))
		.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const base = `https://exec.gneiss.run/api/organizations/${env.EXECUTOR_ORG}`;
const dir = new URL("./executor-app/", import.meta.url);
const files = readdirSync(dir).map((path) => ({ path, content: readFileSync(new URL(path, dir), "utf8") }));

const post = async (path: string, body: unknown) => {
	const started = performance.now();
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${env.EXECUTOR_SETUP_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	console.error(`POST ${path}: ${response.status} in ${Math.round(performance.now() - started)} ms`);
	if (!response.ok) throw new Error(text);
	return JSON.parse(text);
};

let app = process.argv[2];
if (app === undefined) {
	const created = await post("/apps", { name: "Cairn bridges", files });
	app = created.app?.id ?? created.id;
	console.log(`created ${app}`);
}
const deployed = await post(`/apps/${app}/deploy`, { files });
console.log(JSON.stringify(deployed).slice(0, 600));
