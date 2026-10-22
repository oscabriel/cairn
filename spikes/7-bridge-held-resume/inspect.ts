// Prints the shape of Claude Code transcripts: each request's agent line, each reply's cache read
// and write, the prompt snapshot's recorded agent line, and user entries in short.
//   node inspect.ts <transcript.jsonl>...
import { readFileSync } from "node:fs";

const short = (value: unknown) => JSON.stringify(value).slice(0, 110);

for (const file of process.argv.slice(2)) {
	console.log(`== ${file}`);
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		const entry = JSON.parse(line);
		if (entry.type === "api-request-shape") console.log("request  ", short(entry.shape?.system?.[0]?.text));
		if (entry.type === "attachment" && entry.attachment?.type === "prompt_snapshot")
			console.log("snapshot ", short(entry.attachment.cliPrefix ?? null));
		if (entry.type === "assistant") {
			const usage = entry.message?.usage ?? {};
			const kinds = (entry.message?.content ?? []).map((block: { type: string }) => block.type);
			console.log("assistant", usage.cache_read_input_tokens, usage.cache_creation_input_tokens, kinds.join(","));
		}
		if (entry.type === "user") {
			const content = entry.message?.content;
			const parts = Array.isArray(content)
				? content.map((block: { type: string; text?: string; content?: unknown }) => `${block.type}:${short(block.text ?? block.content).slice(0, 70)}`)
				: [short(content).slice(0, 70)];
			console.log("user     ", parts.join(" | "));
		}
	}
}
