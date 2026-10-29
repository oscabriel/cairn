// Spike 10, second question: what one "is this uuid written yet" check costs on a large transcript.
//   node cost.ts <session id> <cwd>
// Times `getSessionMessages` (what the bridge's `ClaudeSdk.entries` calls) three times.
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

const [sessionId = "", dir = ""] = process.argv.slice(2);
for (let i = 0; i < 3; i++) {
	const start = performance.now();
	const messages = await getSessionMessages(sessionId, { dir });
	console.log(JSON.stringify({ entries: messages.length, ms: Math.round(performance.now() - start) }));
}
