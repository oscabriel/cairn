---
status: proposed
gate: `judges/pi-host.ts` and the cwd-isolation test with its mutation control
---

# The tools-only pi host is an allowlist, one instance per folder

The brain loads only named, version-pinned pi packages (`pi-web-access`, `@ff-labs/pi-fff`) through pi's own loader from two empty directories, delivers `session_start` and `session_shutdown` only, and refuses providers and MCP servers. It never runs the rest of `settings.json`'s packages, because loading an extension runs arbitrary code in the brain. `pi-fff` searches the folder of its last `session_start`, not the call's (measured), so stateful extensions bound to a folder run one instance per folder, in a pool of four. `ffgrep` and `fffind` sit beside Cairn's `grep` and `find`; the daily-driver week decides whether they replace them. The host shares `~/.pi/exa-usage.json` with the TUI so the Exa count stays true, and `judges/pi-readonly.sh` names it.

Decided by the user on 2026-10-27, from the phase 2 area notes.
