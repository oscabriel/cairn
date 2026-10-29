---
status: accepted
gate: `judges/pi-host.ts` and the cwd-isolation test with its mutation control
---

# The tools-only pi host is an allowlist, one instance per folder

The brain loads only named, version-pinned pi packages (`pi-web-access`, `@ff-labs/pi-fff`) through pi's own loader from two empty directories, delivers `session_start` and `session_shutdown` only, and refuses providers and MCP servers. It never runs the rest of `settings.json`'s packages, because loading an extension runs arbitrary code in the brain. `pi-fff` searches the folder of its last `session_start`, not the call's (measured), so stateful extensions bound to a folder run one instance per folder, in a pool of four. `ffgrep` and `fffind` sit beside Cairn's `grep` and `find`; the daily-driver week decides whether they replace them. The host shares `~/.pi/exa-usage.json` with the TUI so the Exa count stays true, and `judges/pi-readonly.sh` names it.

Decided by the user on 2026-10-27, from the phase 2 area notes.

Gate evidence (package 3G, 2026-10-28): `judges/pi-host.ts` passed. A judge brain (Cairn's pi-durable Harness over a scratch store, faux model) loaded pi-web-access 0.45.0 (4 tools) and @ff-labs/pi-fff 0.11.0 (2 tools) from the user's installed copies beside the `pi-host-counter` fixture; `ffgrep` found a fresh nonce before the kill and again after it (a new folder instance), and `get_search_content` answered from its own code. With two `kill -9`s mid-call, the safe fixture tool ran 3 times (once per life that reached it) and committed one result, "counter_safe ran 3 times"; the unsafe one ran once and committed one `interrupted` result; a plain reopen read the same results back and ran nothing. The broken control (a replay table that forgets the safe tool) failed by replay alone: the safe tool ran once and came back interrupted. The pi home was identical before and after (62,150 agent dir entries, 4 others). The cwd-isolation test and its shared-instance mutation control (`PiHost.test.ts`, package 1H) pass inside `pnpm check`. `judges/pi-readonly.sh --search` passed with one real `web_search` through the host on opencode-go/minimax-m3: agent dir and pi home identical.

One fact differs from the note: pi-web-access 0.45.0 no longer writes `~/.pi/exa-usage.json` when an Exa key is configured (its README: "any legacy local `exa-usage.json` file is ignored"; Exa's own account limits apply), and the live search left the counter as it was. The judge still allows the counter to change the way the package once changed it, so a version that counts again passes, and anything else under `~/.pi` fails.
