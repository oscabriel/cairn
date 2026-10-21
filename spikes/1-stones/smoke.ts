// node smoke.ts <stoneId>: start, one exec, status.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { control, stoneEnv } from "./stone.ts";
const id = process.argv[2] ?? "a1a1a1a1a1a1";
let t = Date.now();
console.log("status", await control(id));
console.log("start", await control(id, "start"), Date.now() - t, "ms");
const env = stoneEnv(id);
t = Date.now();
const out: string[] = [];
const r = await env.exec("uname -a; id; cat /proc/sys/kernel/random/boot_id; nproc; free -m | head -2", { onOutput: (s: string) => out.push(s) } as never, context);
console.log("first exec", Date.now() - t, "ms", JSON.stringify(r), out.join(""));
console.log("status", await control(id));
env.connection.close();
