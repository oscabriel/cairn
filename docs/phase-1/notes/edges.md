# Phase 1 edge requirements: attachments, phone, load, sign-in, skills, unit, durability

Written 2026-10-22 on the Beelink against pi 1.4.0, Effect 4.0.5, Foldkit 0.169.0, Node 26.11.1, Caddy 2.11.2, systemd 262, t3code `fe27e8e3`. Nothing under `apps/`, `packages/` or `spikes/` was changed. Probes ran in `/tmp/edges-probe` (unpdf, pi-coding-agent 1.4.0, Photon through pi-durable's image processor) and one Foldkit build of spike 2 into `/tmp`. Paths marked "port" are sources to re-cut to Cairn's standards (`docs/coding-standards.md`) with a header naming the repo, path and commit; v1 is `~/Developer/projects/cairn-v1` at `1a5cd4a`.

## Summary

1. **Attachments.** Port t3code's signed one-shot raw POST (`apps/server/src/assets/AttachmentUpload.ts`), not v1's unsigned content-addressed `POST /api/files`. Images are prepared by pi-durable's Photon processor at upload time (measured 270 to 360 ms for a 1170x2532 PNG), documents are turned into text at upload time, and a send only assembles content. PDF text comes from `unpdf` 1.9.1 (MIT, pure JS, no native dependency, 24 to 93 ms for 2 and 33 pages). DOCX comes from `mammoth` (pure JS, BSD-2, not exercised here). A scanned PDF has no text layer and says so.
2. **The wire must not carry image bytes.** A prepared screenshot is about 2.7 MB of base64 inside the pi.user entry, and every reconnect snapshot would resend it. Cairn's protocol projects entries before they leave the brain (image data replaced by a reference), and the entry's `data.attachments` carries what the UI shows.
3. **Phone PWA.** v1's service worker (push and notificationclick only, no fetch handler), manifest and WebCrypto-only VAPID sender are the best versions that exist; port them. iOS needs an installed PWA, a tap for the permission prompt, and a visible notification for every push. Sending is gated on presence so a visible client suppresses the push.
4. **Load under 1 s.** Spike 2's Foldkit bundle is 138 KB gzip of JS and 27 KB of CSS, and the iPhone is 3 to 8 ms away on the LAN, so the budget is about round trips, not bytes. Inline the shell snapshot into `index.html`, serve hashed assets as immutable, lazy-load the transcript, and prove it with a client-side timing report the phone posts back (the Beelink cannot see paint).
5. **Sign-in.** Use Tailscale's LocalAPI over `/var/run/tailscale/tailscaled.sock` (mode 0666) instead of spawning `tailscale whois`: 0.13 ms median against v1's 6.8 ms. The owner is `UserProfile.LoginName == "oscabriel@github"` on an untagged node, which makes the Beelink's own tailnet address admitted with no special case. The judge enumerates every tailnet node (7 peers today, 4 belong to other users) and asserts admit-iff-owner.
6. **Serving.** `code.gneiss.run` already resolves to the Beelink's tailnet IP (the Pi-hole override from v1 survives), has no Caddy route yet, and Caddy reloads without sudo through the docker group (`ops/executor/caddy-route.sh` is the precedent). Port 3774 is free.
7. **Skills.** `loadSkills` and `formatSkillsForPrompt` are in `@earendil-works/pi-coding-agent`, which the catalog does not pin yet. Measured on 1.4.0: 140 unfiltered skills, 30,266 characters, 20 to 36 ms. The user's `settings.json` uses `+`/`!` filters, so use `DefaultPackageManager.resolve` (fenced, as v1 did) and render inside a deterministic pi-durable `section`. Changes reach Claude only as `<system-reminder>` text.
8. **Unit.** `KillMode=mixed` with SIGTERM to the brain only, so the brain closes the Harness and the bridge closes its queries before systemd kills leftovers. A SIGKILL fallback counts as a crash toward 1.4.0's five-crash park. `StartLimitIntervalSec=0` plus `RestartSteps` keeps `kill -9` judges from tripping systemd's own limiter.
9. **Durability judge.** `judges/durability.ts` drives a real brain in a transient systemd unit through nine kill windows (streaming, mid tool, approval parked, mid commit, send in flight, bridge variants), against two clients (Node protocol client and Chromium), and compares each to an oracle snapshot within 2 s of the first 101. It must exist before the features it judges.
10. **Open calls made here** (details under "Risks and open questions"): keep ADR 0008's `forward_auth`; no service-worker fetch handler in Phase 1; approvals as a judge-only tool in Phase 1, product UI in Phase 2; PDF, DOCX and plain text only; client-side image fit to 1568 px.

## Facts with evidence

### Kickoff text these edges answer

`~/Developer/agent-artifacts/cairn/v2/KICKOFF.md`, "What the user asked for" (screenshots, copy and paste, links, document attachments from any device including the phone), Phase 1 bullets "Attachments", "Phone", "Skills and tools", and Targets "Durability", "Paste to model", "Load". ADR 0007 (uploads over signed HTTP POST), ADR 0008 (sign-in), ADR 0012 and the spike 3 and 4 notes (1.4.0 restart limit).

### Attachments

- **t3code's signed upload** (all at `fe27e8e3`):
  - `apps/server/src/assets/AttachmentUpload.ts` (242 lines). `issueAttachmentUploadUrl` returns `{ attachmentId, relativeUrl: "/api/attachments/upload/<base64url claims>.<hmac>", expiresAt }`. Claims are `{ version: 1, kind: "attachment-upload", type: "image" | "file", attachmentId, name, mimeType, sizeBytes, expiresAt }`. The secret is `ServerSecretStore.getOrCreateRandom("asset-access-signing-key", 32)`; signing is `signPayload` and `timingSafeEqualBase64Url` in `apps/server/src/auth/utils.ts`. `storeAttachmentUpload` streams the body to `<id><ext>.<uuid>.part` with `Stream.takeWhile` capped at `sizeBytes`, requires an exact byte count, renames, and the route answers 204.
  - `apps/server/src/http.ts` around L459 to 496 is `layerAttachmentUploadRoute` (`POST /api/attachments/upload/*`, `Content-Length` must equal `sizeBytes`).
  - `apps/web/src/lib/attachmentUploadQueue.ts` (649 lines): XHR with progress, eager upload, 3 at a time.
  - `apps/server/src/orchestration-v2/AttachmentClaims.ts` (145 lines): `claimPendingAttachments` rebinds pending uploads at send. Pending files are swept after 24 h (`sweepStalePendingAttachments` in `apps/server/src/attachmentStore.ts`).
  - Limits, `packages/contracts/src/chatAttachment.ts`: 120,000 input chars, 100 attachments, 10 MiB per image, 80 MiB of images per turn, 50 MiB per file, images gif/jpeg/png/webp. `packages/client-runtime/src/textPaste.ts`: a paste of 32 KiB or more becomes a file unless mod+shift+V. `apps/web/src/lib/imageCompression.ts` (467 lines) fits images to a 2000 px edge client-side.
  - `packages/provider-core/src/server/attachmentPrompt.ts` (217 lines): non-image files reach the agent as `[Attached ... is saved at: <abs path>]` only. PDFs are therefore path-only in t3code, which the kickoff says Cairn must beat.
- **v1's version** (`apps/server/src/Files.ts`, 188 lines; `apps/web/src/attachments.ts`, 140 lines, already adapted from t3code `c079503d`): unsigned `POST /api/files`, content-addressed at `<dataDir>/files/<sha256>`, type decided from magic bytes never from the client, images prepared at upload into `<sha>.image.json`, text wrapped by `attachmentText(name, mime, text)` from `packages/protocol/src/attachment.ts`. Limits 20 MiB upload, 512 KiB text, 10 attachments. Good ideas to keep: sniffing, upload-time preparation, atomic write through a private `.tmp`, boot-time sweep of orphaned scratch files. What it lacked: signing, size claims, documents.
- **pi-durable surface** (`spikes/3-workflows/node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts`): `UserInput = UserMessage["content"]`; `SubmissionDraft = { requestId?, type: "input", content, whenBusy?, entry?: { kind, data? } }`. An `entry.kind` must not start with `pi.` and the input's `model` message is still the user message, so `{ kind: "cairn.user", data: { attachments } }` is legal (spec §6: context, compaction and events go by `model`). `requestId` deduplicates within a conversation.
- **Image limits** (spec §7.3, `tools/image-processor.d.ts`): `DEFAULT_IMAGE_LIMITS` is measured as `{ maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592 }` (4.5 MiB of base64). `@earendil-works/pi-durable/images/node` exports `createNodePhotonImages()`; Photon runs in a worker thread that exits after 30 s idle. A model that takes no images gets a placeholder from pi-ai.
- **Measured Photon cost** (`/tmp/edges-probe/img.mjs`, synthetic noisy 1170x2532 RGBA PNG of 1,369,981 bytes): processor creation 0 ms; `prepare` 364 ms first, then 268 to 275 ms; output stayed PNG at 2,714,228 base64 characters. A real screenshot compresses far better than this noise, so this is an upper bound on cost and on size.
- **PDF extractors:**
  - `unpdf` 1.9.1: MIT, Node >=22, 2.6 MB installed, no `.node` files, `@napi-rs/canvas` is an optional peer used only for page rendering. Measured with `getDocumentProxy` plus `extractText({ mergePages: true })`: 1-page PDF 66 ms (cold), 2-page resume 24 ms, 33-page spec 93 ms and 55,166 characters. `getDocumentProxy` transfers the buffer it is given (the input's `length` read 0 afterwards), so pass a copy.
  - `pdfjs-dist` 6.4.299 (Apache-2.0) is what unpdf wraps; `pdf-parse` 2.4.5 has `@napi-rs/canvas` as a hard dependency, so it fails the "no native deps" requirement.
  - `mammoth` 1.13.0 (BSD-2): dependencies `jszip`, `@xmldom/xmldom`, `lop`, `underscore`, `argparse`, `base64-js`, `xmlbuilder`, `dingbat-to-unicode`; all pure JS. Not run here.
  - `/usr/bin/pdftotext` and `/usr/bin/pdftoppm` (poppler) exist on the Beelink, but not in stones; usable only as an optional host fallback.
- **iPhone paste reality**, from v1 `attachments.ts`: iOS converts HEIC to JPEG when a photo is picked or pasted, so no HEIC decoder is needed; a pasted screenshot arrives as `image/png`.

### Phone PWA and Web Push

- v1 files worth porting: `apps/web/public/sw.js` (67 lines: `install` calls `skipWaiting`, `activate` claims clients, `push` always shows a notification and sets the app badge from `data.pending`, `notificationclick` focuses an open window and `postMessage`s the path or opens one, `pathOf` accepts only same-origin paths), `apps/web/public/manifest.webmanifest` (standalone, `start_url: "/"`, 192/512/maskable icons, `id: "/"`), `apps/web/src/push.ts` (65 lines: `isPushSupported`, `currentSubscription(publicKey)` which unsubscribes a subscription bound to another key, `setBadge`), `apps/server/src/webpush.ts` (120 lines, WebCrypto only: RFC 8291 `aes128gcm`, RFC 8292 VAPID ES256, `generateVapidKeys`, 15 s fetch timeout), `apps/server/src/Push.ts` (292 lines: `isPushEndpoint` allowlist of Apple, FCM, Mozilla and Windows hosts, `loadVapid` writing `push.json` mode 0600 with `wx`, retry on 429/5xx/network with doubling delay, delete on 404/410, CAS claim on `notified_at` so a replayed row never pushes twice).
- v1 spike 5 results (`spikes/05-signin/NOTES.md`): Apple answered 201 in 310 ms (unlocked) and 273 ms (locked) and the notification arrived both times; the subscription endpoint was `web.push.apple.com`; push leaves the Beelink outbound and never crosses Caddy. v1's `sw.js` header records why there is no fetch handler: a deploy must never leave a stale shell behind, and iOS drops a subscription that receives pushes it does not show.
- Today's state: the user's iPhone is on the tailnet and reachable direct over the LAN (`tailscale ping` 8 ms and 3 ms). The other iPhone and the iPad are offline.

### Load

- Spike 2 baseline, rebuilt now with `vite build --outDir /tmp/...` from `spikes/2-foldkit`: `index.html` 1.25 kB, CSS 164.51 kB (26.61 kB gzip), JS 569.93 kB (137.74 kB gzip), one chunk. That is the composer, sidebar and a generated t3code view, with no RPC client, no transcript, no markdown.
- Caddy's wildcard block already has `encode zstd gzip` (`~/caddy/conf/Caddyfile`). Caddy runs in Docker with host networking.
- v1 measured 0.3 s on the Beelink; the MacBook's slow loads were DERP warm-up (kickoff Targets, `research/08-homelab-local.md`).
- Brain restart time matters to convergence: measured import cost in the spike 3 environment is effect 119 ms, pi-ai 209 ms, pi-durable 233 ms, codemode 240 ms cumulative (RSS 124 MB against 43 MB for bare Node); `@earendil-works/pi-coding-agent` adds another 257 to 361 ms and about 95 MB. `NODE_COMPILE_CACHE` trimmed the first set from 265 to 189 ms and the second from 361 to 257 ms.

### Sign-in and serving

- ADR 0008 and the kickoff: Caddy `forward_auth` passes `{remote_host}`, Cairn runs `tailscale whois`, admits `oscabriel@`, the Beelink's own requests included, and every state-changing request and WebSocket upgrade must carry Cairn's own Origin.
- v1's gate: `apps/server/src/Gate.ts` (166 lines): `makeDecide` with injectable `whois` and `session` (tests need no tailscaled), a 30 s cache per peer address, a `NO_DEVICE` header so a route never rests on Caddy deleting a client header, a generic 403 body because reasons name other people's devices. v1's Origin rule is `apps/server/src/Http.ts` line 54: `(upgrade || !SAFE_METHODS.has(request.method)) && request.headers["origin"] !== config.origin` gives 403. v1's static routes and CSP are in the same file (`contentSecurityPolicy`, `staticRoutes`, `cross-origin-opener-policy: same-origin`).
- v1 spike 5's `verify.sh` is a 37-check script; its structure is the template for the new judge. Its lessons: `header_up X-Cairn-Peer {remote_host}` replaces anything the client sent, `copy_headers` replaces a forged copied header, `Upgrade` and `Connection` are hop-by-hop so the auth subrequest cannot see a WebSocket upgrade (the Origin rule must live in the app), and one first load after joining Wi-Fi reached the gate with an empty peer and failed closed (unexplained, did not recur; the gate logs all headers on `no-peer`).
- Measured now:
  - `tailscale whois --json <own tailnet ip>` returns `Node.StableID`, `Node.Name`, no `Tags`, and `UserProfile.LoginName == "oscabriel@github"`. Loopback and LAN addresses return "peer not found".
  - LocalAPI: `/var/run/tailscale/tailscaled.sock` is `srw-rw-rw-`. `GET http://local-tailscaled.sock/localapi/v0/whois?addr=<ip>:1` with `Host: local-tailscaled.sock` returns the same JSON; 30 requests, median 0.13 ms, max 0.41 ms.
  - `tailscale status --json`: 7 peers, 3 with the owner's `UserID`, 4 with other users, none tagged.
  - DNS from the Beelink: `code.gneiss.run` resolves to `100.84.155.69` (the tailnet IP; v1's Pi-hole Local DNS override is still in place), `plans.gneiss.run` to `192.168.4.20`.
  - `~/caddy/conf/Caddyfile` has no `code.gneiss.run` handle. It does have `exec.gneiss.run`, `plans.gneiss.run`, the dev `map`, and eight timestamped backups. `ops/executor/caddy-route.sh` is a working validate, back up, reload script that uses `docker exec caddy caddy ...` (no sudo).
  - Listeners now: 3773 (t3code, loopback), 3775 (headless Chrome CDP), 3776 (stdio relay on `172.17.0.1`), 4400 (Executor). 3774 is free; spikes 3 and 4 used it for throwaway brains.
- Effect 4.0.5 pieces to use, from installed source (`node_modules/effect/dist`): `HttpRouter.middleware(fn, { global: true })` for guards (HttpRouter.d.ts L593), `RpcServer.layerProtocolWebsocket({ path })` and `toHttpEffectWebsocket` (RpcServer.d.ts L246 and L311), `HttpServerRequest.upgrade`, `HttpMiddleware.cors` (not wanted: no cross-origin access at all), `HttpServerRequest.stream` for raw bodies.

### Skills

- pi API (`git show origin/main:packages/coding-agent/src/core/skills.ts`): `loadSkills({ cwd, agentDir, skillPaths, includeDefaults }) -> { skills, diagnostics }`, `formatSkillsForPrompt(skills, fileReadTool = "read" | "bash" | "indirect")`, `Skill = { name, description, filePath, baseDir, sourceInfo, disableModelInvocation }`. It dedupes by canonical path (so `~/.claude/skills` symlinks into `~/.agents/skills` collapse) and reports name collisions as diagnostics. Exported from the package index with `DefaultPackageManager`, `DefaultResourceLoader`, `SettingsManager`, `ModelRuntime`, `getAgentDir` (confirmed by import on 1.4.0).
- Measured on 1.4.0: `loadSkills({ cwd, agentDir: <empty>, skillPaths: [~/.agents/skills, ~/.pi/agent/skills], includeDefaults: false })` gives 140 skills, no diagnostics, 30,266 characters, 36 ms cold then 20 to 24 ms; the same 140 and 30,266 as v1 spike 4.
- The user's `~/.pi/agent/settings.json` has `skills` with `+` and `!` entries (it disables `pstack/*` and `remotion-*`, enables `install-anti-slop` and `domain-modeling`) and packages `pi-unslop` and `pi-skill-stacks` that contribute skills. Plain `loadSkills` ignores those filters. v1 resolved them with `SettingsManager.create(cwd, agentDir, { projectTrusted: false })` and `new DefaultPackageManager({...}).resolve(onMissing)` in `apps/server/src/PiConfig.ts` L314 to 440 (about 400 ms, cached on file mtimes), after fencing every spawn path (`fencePackageManager`, `fenceSettings`) because a resolve can run `npm root -g`.
- pi-durable prompt sections (spec §7.4, `dist/harness/define.d.ts`): `section(key, render, { tag })`; `render` gets `PromptInput` including `env` (so `env.cwd` for project skills); a section whose output changes appends a `pi.system` delta and misses the provider cache, so output must be deterministic.
- v1 spike 4: 140 skills rendered in 13 to 66 ms per model call; a changed section never reached Claude through the bridge because Claude Code stores the system prompt at session start. The port must send each later change as a `<system-reminder>` block on the next user message (kickoff, "Claude runs through the bridge").
- `@earendil-works/pi-coding-agent` is not in `pnpm-workspace.yaml`'s catalog. npm shows 1.4.0 with dependencies `diff`, `jiti`, `yaml`, `chalk`, `ignore`, `minimatch`, `undici`, `typebox`, `quickjs-wasi`, `@silvia-odwyer/photon-node`, `@earendil-works/pi-tui` and others (152 MB installed). The installed `pi` CLI is still 1.3.0.

### Unit and shutdown

- Existing user units (`~/.config/systemd/user`): `executor.service` (Docker), `cairn-bridges.service` (`KillMode=control-group`, `Restart=always`, `RestartSec=2`), `t3code.service` (`KillMode=mixed`, `OOMPolicy=continue`, `Restart=always`). Lingering is on (`Linger=yes`), so user units run without a login. State convention: `~/.local/state/cairn`, config `~/.config/cairn` (`executor-grant.json`, `bridges.key`, `phase-0.env`).
- pi-durable 1.4.0 (spike 3 notes, "Rerun on pi-durable 1.4.0"): a task cut off by 5 crashes in a row without committing is parked until `retryTask()`. Five `kill -9`s during a long job parked the script, two agent nodes and the job wait; six SIGTERM stops parked nothing, because `harness.close()` writes tasks back without counting a restart. The first clean-stop attempt crashed on an unhandled "Harness is closed" rejection from the brain's own `waitForIdle()`: every promise the host holds on the Harness must handle that rejection. Spike 4: a parked approval wait commits nothing, so the guard parks it after 5 crashes; the brain calls `retryTask()` at boot for tasks whose approval record is still `pending`.
- `spikes/3-workflows/brain.ts` L224: the SIGTERM pattern is `process.once("SIGTERM", () => void harness.close(context).finally(() => process.exit(0)))`.
- Spec §12: "Non-cooperative code at close: close joins every invocation. A task handler, tool, or hook that ignores its signal keeps `close()` pending and Storage open until it returns." "Objects outliving the Harness: close the Chord objects and links that expose Harness state before closing the Harness."
- Spike 0: a `claude` child exits when its stdin closes, so a killed brain leaves no children, and parked children cost about 232 MB each.

### Durability

- Spec §12, "Durable progress cadence": clients see only committed progress; a crash may lose the current uncommitted throttle window. v1 spike 9: pi-durable commits the partial reply every `partialIntervalMs` (100 ms); a reconnecting page converged in 102 ms of which 100 ms was the client's own backoff; a 40-turn conversation snapshot was 260 KB.
- v1 spike 1 (`kill.sh <name> parked|answer`): with native resume of Claude Code's transcript, a `kill -9` while a tool was parked and during the answer ran the tool once each and kept a 130x cache read to write ratio.
- Spike 4's judge (`spikes/4-approvals/judge.sh`) and spike 3's judge (`spikes/3-workflows/judge.sh`) are the working pattern: a fresh store per case, an events log outside pi-durable's store, an effects log the judge counts, `kill -9` driven by pid, and a verdict line per case. `judges/relay-orphans.sh` shows the systemd cgroup approach (`systemctl --user show -P ControlGroup`) and the escaped-process check.

## What Cairn should build

Placement follows `docs/coding-standards.md` S5 (module files PascalCase after the main export, scripts kebab-case) and S6 (apps are composition roots, shared schemas in `packages/protocol`). Reconcile paths with the sibling notes in this folder.

### 1. Attachments

**Protocol** (`packages/protocol/src/Attachments.ts`):

- `UploadClaims` (Schema.Struct, field order = encoded order): `version: 1`, `kind: "attachment-upload"`, `attachmentId`, `name`, `mimeType`, `sizeBytes`, `expiresAt`. No `type` field: the server decides image, text, pdf or docx from bytes.
- RPC `attachments.createUploadUrl({ name, mimeType, sizeBytes }) -> { attachmentId, uploadPath, expiresAt }`, RPC `attachments.discard({ attachmentId })`.
- `AttachmentRef = { id, name, mime, size, kind: "image" | "text" | "document", width?, height?, pages?, textChars?, truncated? }`. The send RPC takes `attachments: ReadonlyArray<AttachmentId>` plus its `requestId`.
- Limits as constants, one source: `MAX_ATTACHMENTS = 20`, `MAX_IMAGE_BYTES = 10 MiB` uploaded, `MAX_FILE_BYTES = 50 MiB`, `MAX_INLINE_TEXT_CHARS = 40_000` per attachment and `MAX_TURN_INPUT_CHARS = 120_000` (t3code's `PROVIDER_SEND_TURN_MAX_INPUT_CHARS`). Port the shape of `chatAttachment.ts`, trimmed.

**Server** (`apps/server/src/attachments/`):

| File | Job | Source |
| --- | --- | --- |
| `UploadTokens.ts` | HMAC sign and verify claims; secret read or created (`wx`, mode 0600) at `~/.config/cairn/upload-signing.key`; TTL 10 min; time from `Clock`, never `Date.now()` (S8) | port `AttachmentUpload.ts` + `auth/utils.ts` (t3code `fe27e8e3`, MIT header) |
| `UploadRoute.ts` | `POST /api/attachments/upload/:token`, raw body, `Content-Length === sizeBytes`, stream to `<dataDir>/attachments/.tmp/<id>.<uuid>.part` while hashing sha256, reject on overflow, rename to `<dataDir>/attachments/<id>`, then run `Sniff` and `Prepare`, answer `200` with the `AttachmentRef` JSON (not 204) so the chip is ready without a second call | port `layerAttachmentUploadRoute`; response shape is new |
| `Sniff.ts` | type from the first 4 KB: PNG, JPEG, GIF, WebP, `%PDF-`, ZIP with `word/document.xml` for DOCX, otherwise strict UTF-8 without NUL as text; `ftyp` (HEIC/video) refused with a plain message | port v1 `Files.ts` `sniff` |
| `ImagePrepare.ts` | pi-durable `createNodePhotonImages()` once, lazily; `prepare(bytes, mime, limits)` with Cairn limits `{ maxWidth: 1568, maxHeight: 1568, maxBytes: DEFAULT_IMAGE_LIMITS.maxBytes }`; store the prepared bytes as `<id>.prepared` plus `<id>.meta.json`, never base64 on disk | v1 `Files.ts` `prepare`, changed to binary |
| `TextExtract.ts` | `extract(bytes, kind) -> Effect<ExtractedText, ExtractFailure>`; PDF through `unpdf` (`getDocumentProxy(copy)`, `extractText({ mergePages: false })` to keep page boundaries), DOCX through `mammoth.extractRawText`, text as is. Runs in a `node:worker_threads` worker (`ExtractWorker.ts`), 15 s timeout, 500 page cap, 2 M character cap; result written to `<id>.txt` so an agent can page through it with `read` | new |
| `AttachmentStore.ts` | SQLite table `attachments(id PK, name, mime, size, sha256, kind, pages, text_chars, created_at)` and `attachment_claims(attachment_id PK, thread_id, request_id, claimed_at)`; boot sweep removes `.tmp/*` and unclaimed rows older than 24 h; `INSERT OR IGNORE` on claim so a retried send is idempotent | table design new; sweep from t3code `sweepStalePendingAttachments` |
| `AttachmentContent.ts` | `content(refs) -> ReadonlyArray<TextContent \| ImageContent>`: image to `{ type: "image", data: base64(prepared), mimeType }`; text and documents to one text block `attachmentText(name, mime, text, path)` carrying the saved path and, past the inline cap, the first `MAX_INLINE_TEXT_CHARS` plus "truncated, full text at <path>.txt"; a document with no text says "no text layer; the original is at <path>" | block format from v1 `packages/protocol/src/attachment.ts` |

**The send path** (in the thread-command handler, not the upload route): decode the `attachments` ids from the RPC, build `content` from the files (read only), call `root.submit({ type: "input", requestId, content, entry: { kind: "cairn.user", data: { attachments: refs } } })`, then insert the claims. A crash between submit and claim is safe: the retry carries the same `requestId`, pi-durable returns the same submission, and the claim runs. Files are never moved or deleted by a send.

**Wire projection** (`apps/server/src/wire/ProjectView.ts`, shared with the protocol work): before a `snapshot` or an `ops` batch leaves the brain, any `ImageContent.data` inside `entries[*].model` is replaced by `""` plus a `ref` to `GET /api/attachments/<id>/image`, and `pi.provider.*`/`pi.usage` docs follow the filtering decision in the protocol notes. The transcript renders `entry.data.attachments`, never the model message. `GET /api/attachments/:id/:variant` serves prepared image, original, or thumbnail with `Cache-Control: private, max-age=31536000, immutable` (ids are random) and the Origin/identity guard like everything else.

**Web** (`apps/web/src/attachments/`): re-port v1 `attachments.ts` from t3code `composerAttachmentFiles.ts` (`classifyFile`, `shouldClaimPaste`, `admitFiles`) and `textPaste.ts` (32 KiB fold, mod+shift+V); `UploadQueue` after `attachmentUploadQueue.ts` (XHR progress, 3 at a time, abort on remove); `FitImage.ts` after `imageCompression.ts` (decode with `createImageBitmap`, scale the long edge to 1568, encode JPEG 0.85 unless the source is a small PNG, skip when already small), so a 1170x2532 screenshot uploads well under 500 KB. The composer needs an Attach button with `<input type="file" multiple accept="image/*,application/pdf,.docx,text/*">` as well as paste, because the iOS paste menu is unreliable. A send with an upload still running waits on a pending-work counter (t3code `pendingDraftWork`) and fires the moment the last upload answers.

**Diagnostics events** (structured log lines, not telemetry): `attachment.url_issued`, `attachment.stored`, `attachment.prepared`, `attachment.extracted`, `turn.submitted` and `provider.request` (id, kind, bytes, sha256 of the exact base64 handed to the provider). These are what the paste judge reads.

### 2. Phone PWA and Web Push

- `apps/web/public/sw.js`: port v1 as is (push, notificationclick, no fetch handler), plus nothing else in Phase 1. `manifest.webmanifest`, `apple-touch-icon.png` and icons: v1's placeholder art is reusable until the branding pass. `index.html` carries `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, `theme-color`, `apple-mobile-web-app-capable`, and a `<link rel="manifest">`.
- Static serving rules (`apps/server/src/http/Static.ts`, after v1 `staticRoutes`): `index.html`, `sw.js` and the manifest `Cache-Control: no-cache`; `/assets/*` (hashed) `public, max-age=31536000, immutable`; CSP and `cross-origin-opener-policy: same-origin` from v1 `contentSecurityPolicy`.
- `apps/web/src/push.ts`: port v1. Settings has one toggle, "Notify me on this device". On iOS Safari outside an installed PWA it shows "Add Cairn to your Home Screen first" (detected by `!("PushManager" in window)` and `navigator.standalone === false`). The permission request fires only from the tap. At every app start `currentSubscription(publicKey)` re-checks the key binding and re-posts the endpoint if it changed (iOS does not reliably fire `pushsubscriptionchange`).
- `apps/server/src/push/`:
  - `WebPush.ts`: port v1 `webpush.ts`; take the clock from Effect (S8) instead of `Date.now()` for the JWT `exp`; keep `exp` at 12 h.
  - `Vapid.ts`: `loadVapid` from v1 `Push.ts`, file `~/.config/cairn/push.json` (0600). Subject `mailto:admin@gneiss.run`.
  - `PushSubscriptions.ts`: table `push_subscriptions(endpoint PK, p256dh, auth, created_at, last_ok_at)`; `subscribe` refuses endpoints outside `isPushEndpoint`; the owner is implicit (one user), so v1's `device` column goes.
  - `Notifier.ts`: reads the shell event log (`afterSequence`) with a durable cursor in `push_cursor`, turns `thread.run-settled` events into pushes. Rule: send only if no client reported the thread visible in the last 30 s and the run took longer than 20 s or ended in an error. Exactly-once per run through `INSERT OR IGNORE INTO notified_runs(run_id)` before sending (v1's `notified_at` CAS, applied to runs). Payload `{ title, body, tag: threadId, url: "/t/<threadId>", pending }` stays under 3.5 KB; `ttl` 3600; a body holds the thread title and the last assistant sentence cut to 80 characters.
  - `Presence.ts`: RPC `presence.report({ threadId?, visible })` every 15 s and on `visibilitychange`; held in memory only.
- Approvals will reuse `Notifier` in Phase 2 with the same CAS; Phase 1 only needs `thread.run-settled`, `thread.run-failed` and the Executor-needs-sign-in push from v1.

### 3. Load

- **Shell inlined in the HTML.** `Static.ts` serves `index.html` through a template step that inserts `<script id="cairn-boot" type="application/json">{shell snapshot, protocol version, vapid public key}</script>` read from the shell store (a few KB for a few hundred thread rows). The Foldkit `init` reads it, so the thread list renders on the first frame and the `/ws` snapshot only confirms it. The boot JSON is gated by the same identity guard as the page. `</script` inside the JSON is escaped.
- **Budgets** (enforced by a size check in `pnpm check`'s test step reading the Vite manifest): entry JS at most 200 KB gzip, entry CSS at most 35 KB gzip, everything else (transcript renderer, markdown, diff viewer, settings) dynamic `import()`. `<link rel="modulepreload">` for the entry chunk and `<link rel="stylesheet">` for the CSS in `index.html`; no web fonts from other origins (CSP forbids them anyway).
- **Connection order:** the page opens `/ws` as the first statement of `main.ts`, before Foldkit mounts, so the TLS-warm connection is ready when the first RPC is queued.
- **Client report:** the app records `performance.mark("cairn:interactive")` when the thread list has rendered rows and the first Foldkit update loop turn has run, then sends `navigator.sendBeacon("/api/diagnostics/load", {...})` with `PerformanceNavigationTiming` fields (`domainLookupEnd`, `connectEnd`, `responseEnd`, `transferSize`), the interactive mark, `deviceMemory` if present, `effectiveType` if present, and `standalone`. `apps/server/src/diagnostics/LoadReports.ts` keeps the last 200 in SQLite and serves `GET /api/diagnostics/load?since=<id>`. This is a permanent feature, shown in Settings, so the user sees regressions without a judge run.
- **Restart-time contribution:** the brain binds its port and serves `/` and static files before it opens pi-durable; `/ws` upgrades are accepted once the shell store is open (the shell store is Cairn's SQLite, a few ms), and pi-coding-agent is imported lazily inside the skills and model-auth services so it is off the critical path. `NODE_COMPILE_CACHE=%h/.cache/cairn/node` in the unit.

### 4. Sign-in and serving

- `apps/server/src/http/Tailscale.ts`: a `Tailscale` service with `whois(ip) -> Effect<Option<Peer>>` over `node:http` with `socketPath: "/var/run/tailscale/tailscaled.sock"`, `Host: local-tailscaled.sock`, path `/localapi/v0/whois?addr=<ip>:1` (the address is validated with `node:net` `isIP` and URL-encoded), 1 s timeout, a 30 s `Cache` per address that also caches "not found" for 5 s, and `Peer = { stableId, loginName, tags, nodeName }`. A test layer `Tailscale.fixed(table)` replaces it in unit tests and in the judge's composition root.
- `apps/server/src/http/Identity.ts`: `admit(peer: unknown-from-header) -> Effect<Admitted, Refused>`: `isIP`, whois, `tags` empty, `loginName === config.owner` (`"oscabriel@github"`, the exact login, not a prefix). Config key `owner` lives in `~/.config/cairn/cairn.json` and is decided at install by the wizard from `tailscale whois` of the Beelink itself, never typed.
- `apps/server/src/http/Guard.ts`: one global `HttpRouter.middleware(..., { global: true })` that runs on every route, WebSocket upgrades included:
  1. `Host` must equal the configured host (`code.gneiss.run`); otherwise 421.
  2. Requests must carry `X-Cairn-User` equal to the owner (set by Caddy's `copy_headers`, absent on a direct loopback request); otherwise 403 with a generic body.
  3. For any method other than GET, HEAD, OPTIONS, and for any request with `Upgrade: websocket`, `Origin` must equal the configured origin exactly (`https://code.gneiss.run`); otherwise 403.
  4. `Sec-Fetch-Site: cross-site` on any `/api/*` GET is refused (extra, costs nothing).
  5. Responses get `Cache-Control: no-store` on `/api` and the headers v1 set.
  `GET /_cairn/auth` is the only route outside rule 2: it reads `X-Cairn-Peer`, calls `Identity.admit`, answers 200 with `X-Cairn-User` or a generic 403, and logs the reason (never in the body) and, on an empty peer, all request headers (`event: no-peer`).
- **Why a header and not a fresh whois per request in the app:** the app keeps ADR 0008's `forward_auth` as written, and rule 2 only checks the copied header. The one-hop alternative is under the open questions.
- `ops/cairn/caddy-route.sh [--check]`: copy of `ops/executor/caddy-route.sh` inserting before the `# Agent-generated HTML plans/reports` marker:

  ```caddyfile
  	# Cairn brain (local to Beelink; ops/cairn in the cairn repo)
  	@cairn host code.gneiss.run
  	handle @cairn {
  		forward_auth 127.0.0.1:3774 {
  			uri /_cairn/auth
  			header_up X-Cairn-Peer {remote_host}
  			copy_headers X-Cairn-User
  			lb_try_duration 3s
  			lb_try_interval 250ms
  		}
  		reverse_proxy 127.0.0.1:3774 {
  			lb_try_duration 3s
  			lb_try_interval 250ms
  		}
  	}
  ```

  This block was validated on 2026-10-22 against the live Caddyfile with `docker exec caddy caddy validate` ("Valid configuration") and is `caddy fmt` clean; the candidate file was removed and the live file untouched. `lb_try_*` hides a one-second brain restart from page loads and uploads (Caddy retries the connection instead of answering 502). The script validates with `caddy validate`, checks `caddy fmt` cleanliness, backs up with a timestamp, and reloads with `docker exec caddy caddy reload`; it is idempotent on `@cairn host code.gneiss.run`.
- **DNS:** nothing to do; the override exists. The wizard prints `dig +short code.gneiss.run` and fails the stage if it is not the tailnet IP.

### 5. Skills

- Add `"@earendil-works/pi-coding-agent": 1.4.0` to the `pnpm-workspace.yaml` catalog (same group as the other `@earendil-works/*` pins). The sibling notes on `ModelRuntime` need the same package.
- `apps/server/src/skills/PiResolve.ts`: port the skills half of v1 `PiConfig.ts` (fences, `SettingsManager.create(cwd, agentDir, { projectTrusted: false })` from an empty host-owned cwd, `DefaultPackageManager.resolve` with `onMissing` answering "skip"), drop v1's sandbox mount roots, extension handling and mcp.json parsing. Cache the resolved path list against the mtimes of `settings.json`, `~/.agents/skills`, `~/.pi/agent/skills` and each package root; a `skills.reload` RPC forces it. `agentDir` is `getAgentDir()`; Cairn never writes there.
- `apps/server/src/skills/SkillCatalog.ts`: `forCwd(cwd) -> Effect<ReadonlyArray<SkillSummary>>`. Order: project roots first (`<cwd>/.agents/skills` up to the repo root, found with the thread's project root; `.pi/skills` is not read because project `.pi/` is untrusted), then the resolved user skills; first name wins; sort by name; dedupe by `realpath`. Hidden (`disableModelInvocation`) skills stay in the list for `$`/`/` completion and out of the prompt.
- `apps/server/src/skills/SkillsSection.ts`: `section("skills", (input) => formatSkillsForPrompt(visible(catalog.forCwdSync(input.env.cwd))), { tag: false })` inside `defineExtension({ name: "cairn-skills", sections: [...] })`. `formatSkillsForPrompt(skills, "read")` is correct because threads get pi-durable's `read` tool on the host. Rendering is synchronous from the cached snapshot (no filesystem walk per model call) so it stays under 1 ms and is byte-stable between turns.
- **Claude delivery:** the bridge port (sibling notes) turns each `pi.system` section delta after the first into one `<system-reminder>` text block on the next user message, one line per changed skill. This note's judge asserts it; it is not built here.
- **`$name` and `/skill:name` in the composer:** the web client keeps a `skills.list` result (name, description, source; no bodies). Sending with a chosen skill passes `skillRefs: ["name"]`; the server expands to pi's inline form `<skill name="..." location="...">body</skill>` (pi `agent-session.ts` around L2178) and appends the user text. Project skills outside the checkout are not readable by path in a stone; Phase 3 routes skill reads to the host (kickoff decision 1).
- RPCs: `skills.list({ threadId? })`, `skills.reload`.

### 6. The systemd unit

`ops/cairn/cairn.service` (linked into `~/.config/systemd/user` by `ops/cairn/install.sh`, patterned on `ops/executor/install.sh`):

```ini
[Unit]
Description=Cairn brain
StartLimitIntervalSec=0

[Service]
Type=exec
WorkingDirectory=%h/Developer/projects/cairn
Environment=NODE_COMPILE_CACHE=%h/.cache/cairn/node
EnvironmentFile=-%h/.config/cairn/brain.env
ExecStartPre=/usr/bin/mkdir -p %h/.cache/cairn/node %h/.local/share/cairn %h/.local/state/cairn
ExecStart=/usr/bin/node apps/server/src/main.ts
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=30
Restart=always
RestartSec=250ms
RestartSteps=4
RestartMaxDelaySec=8
OOMPolicy=continue

[Install]
WantedBy=default.target
```

- `KillMode=mixed`: SIGTERM goes to the main process only; after it exits (or after `TimeoutStopSec`) systemd SIGKILLs whatever is left in the cgroup. With `control-group` (the bridges unit's mode, right for supergateway) SIGTERM would hit the `claude` children first and the brain would see its queries die mid-close and record `model_error` instead of leaving the tasks pending.
- `StartLimitIntervalSec=0` removes systemd's own 5-starts-in-10-s limit, which a `kill -9` judge would trip; `RestartSteps`/`RestartMaxDelaySec` (systemd 262) give a back-off for a brain that cannot boot. pi-durable's park-after-5-crashes is the loop guard for tasks.
- `main.ts` shutdown (`apps/server/src/Shutdown.ts`, one finalizer in the root `Layer`): on SIGTERM and SIGINT, in order: stop accepting upgrades (close the HTTP server's listeners, 1001 to WebSocket clients so they reconnect at once), abort bridge queries by their conversation signal, close Chord objects and links that expose Harness state, `await harness.close(context)`, close SQLite, exit 0. Every promise the brain holds on the Harness (`waitForIdle`, `watch`) has a handler that treats "Harness is closed" as a normal end, which is the bug spike 3 hit. A watchdog logs `shutdown_slow` at 20 s so the journal shows which tool ignored its signal before `TimeoutStopSec` fires SIGKILL.
- Boot sequence (`apps/server/src/Boot.ts`): open SQLite, sweep `.tmp` and stale uploads, bind and serve HTTP, open the Harness, `harness.resume()`, `retryTask()` for tasks parked with `reason: "restart_limit"` whose approval record is still `pending` (spike 4), count `claude` processes whose parent is gone and log them (spike 0's boot check), then mark the brain ready. Readiness goes to `GET /_cairn/health` (loopback, no identity; returns `{ ready, startedAt, pid }`).
- Parked tasks: the shell stream carries `parked` tasks with a Retry action (spike 3 decision). The UI work lives in the sibling notes; the edge requirement is that SIGTERM restarts never produce one and the durability judge's `kill-six` case does.

### 7. Judges and where they live

See the "Judges" section; the files are `judges/gate.sh`, `judges/durability.ts`, `judges/paste.ts`, `judges/load.ts`, `judges/push.ts`, `judges/shutdown.sh`, `judges/skills.ts`, test files beside the modules, and `ops/wizards/phase-1.sh` for the steps only the user can do.

### 8. New words, ADRs, wizard

- **Glossary additions** (same change as the code, per CLAUDE.md): **Attachment** (a file or image uploaded for a turn; avoid "upload" for the stored thing), **Upload URL** (the signed, expiring, size-bound path for one attachment), **Presence** (the visibility report that suppresses a push), **Shell snapshot** (if the protocol notes do not already name it), **Guard** (the middleware that checks Host, identity and Origin).
- **ADRs:** 0016 "Attachments are prepared at upload and reach the model as content" (signed one-shot POST, upload-time preparation, `unpdf`, wire projection), 0017 "The service worker only shows pushes" (no fetch handler, why, revisit rule), 0018 "The brain runs with KillMode=mixed and closes the Harness on SIGTERM". Amend ADR 0008 only if the one-hop alternative is chosen.
- **Wizard** `ops/wizards/phase-1.sh` (steps only the user can do; the Caddy reload and unit install are done by scripts without sudo): (1) `./ops/cairn/install.sh` then `./ops/cairn/caddy-route.sh`, prints the DNS check; (2) on the iPhone: open `https://code.gneiss.run`, Share, Add to Home Screen, open it from the icon; (3) in the app: Settings, "Notify me on this device", allow; the wizard polls `GET /api/diagnostics/push` for the new subscription; (4) run `node judges/push.ts --send` and confirm the notification on the locked phone; (5) cold-load runs: force-quit the PWA, clear website data once, open three times, the wizard prints the collected reports and `tailscale ping iphone` path; (6) paste run: take a screenshot of the nonce page `judges/paste.ts --page` shows, paste it into a thread, send, the judge prints the timeline.

## Risks and open questions

Each item ends with the recommended answer.

1. **Images in the transcript weigh megabytes and ride every snapshot.** A prepared screenshot is about 2.7 MB of base64 (upper bound measured above). Without a wire projection, a reconnect resends it and the 1 s load and 2 s convergence targets fail on a long thread. *Recommend:* the projection in `ProjectView.ts`; fit images to 1568 px on the long edge on the client and in `prepare` (to my knowledge Claude downscales above roughly that size anyway, so nothing is lost; verify against the Anthropic vision docs via the `claude-api` skill before fixing the number); keep `entry.data.attachments` as the only thing the UI reads. Risk if skipped: the first thread with ten screenshots makes the phone unusable.
2. **The wire projection must also rewrite `ops`.** A committed entry arrives as an append or splice op whose value contains the image. *Recommend:* project at the one place both snapshot and ops are produced (the protocol encoder), with a test that a 3 MB image never appears in any frame (`wire.test.ts` greps frames for the base64 prefix).
3. **ADR 0008 as written versus a one-hop design.** `reverse_proxy { header_up X-Cairn-Peer {remote_host} }` would let the app admit every request, WebSocket upgrades included, with no subrequest and no copied identity header. *Recommend:* keep `forward_auth` per the ADR for now (unauthenticated requests never reach the app, matching v1's proven spike) with the app checking the copied header; revisit only if `forward_auth` misbehaves with the phone. The Origin rule lives in the app either way because the auth subrequest cannot see the upgrade.
4. **Anything on the Beelink is admitted as the owner.** A process that connects to `code.gneiss.run` resolves to the tailnet IP and arrives from the Beelink's own node, whose login is the owner's. Agents run on the host with full access by default, so this adds no power; it matters only when permission modes restrict a thread. *Recommend:* accept, write it in ADR 0008's consequences, and do not admit loopback or the LAN address (they are "peer not found" today and the judge pins that).
5. **LocalAPI is not a documented stable interface.** The `whois` endpoint is what Tailscale's own Go client uses, and the socket is world-accessible here. *Recommend:* use it, keep `tailscale whois --json` as an automatic fallback behind the same `Tailscale` service when the socket call errors, and make the judge run both and compare.
6. **Unexplained empty `X-Cairn-Peer` in v1.** One refusal on first load after joining Wi-Fi. *Recommend:* log all headers on `no-peer`; the client treats a 403 on the very first document load as retryable once after 300 ms; the load judge counts such retries.
7. **Pi-hole: Tailscale off at home.** `code.gneiss.run` resolves to the tailnet IP, so a phone with Tailscale off at home cannot connect at all (it does not get a 403). *Recommend:* accept; say it on the error page the PWA shows when the shell cannot load ("Open Tailscale").
8. **Scanned PDFs have no text layer.** `unpdf` returns empty text. *Recommend:* report `textChars: 0` to the model as "no text layer; original at <path>" and let the model use a tool; as an optional host-only extra, rasterize the first 5 pages with `/usr/bin/pdftoppm -r 100 -png` and attach them as images when `pdftoppm` exists. Do not add `@napi-rs/canvas` (native).
9. **Malicious documents.** pdf.js has had script-execution bugs (CVE-2024-4367 in `isEvalSupported`); a DOCX is a ZIP and can be a bomb. *Recommend:* extraction in a worker thread with a 15 s timeout and `--max-old-space-size=512` via `resourceLimits`; pass `isEvalSupported: false` to `getDocumentProxy` if the option is forwarded (check `unpdf/dist/index.mjs` L58 to 79, which sets `useSystemFonts` and `disableFontFace`); cap DOCX uncompressed size at 50 MiB by reading the ZIP central directory before `mammoth`. Never write extracted text anywhere but the attachments directory.
10. **DOCX and spreadsheets.** The kickoff says "PDF and document text". *Recommend:* PDF, DOCX and plain text/markdown/CSV/JSON/source files in Phase 1; XLSX and PPTX arrive as a path with a note until a pure-JS reader is chosen in Phase 2 (check the maintenance and licence of the candidates then; none was evaluated here).
11. **Approval-parked window in the Phase 1 durability judge.** Approvals are Phase 2 (decision 4) but the durability target names them. *Recommend:* port spike 4's `cairn.approvals` document and gated-tool shape as a Cairn extension used only by the judge (`judges/fixtures/JudgeTools.ts` loaded through the Cairn extension seam, which also proves the seam), and leave product UI and permission modes for Phase 2. Phase 1 therefore proves the mechanism at the protocol level and Phase 2 proves it from the phone.
12. **Approval parked on the bridge.** Combining spike 1's native resume with a parked, replay-safe tool that waits for a human has not been run. Claude Code's own tool timeout for an MCP tool call is long but unverified here. *Recommend:* the durability judge includes `bridge-approval-parked` (kill, restart, accept, tool runs once, Claude's answer continues) in the default run, and a `--slow` case that parks for 20 minutes first (nightly, not per check).
13. **Brain restart time eats the 2 s.** Imports alone are about 0.24 s, plus 0.26 to 0.36 s for pi-coding-agent, plus `RestartSec`. *Recommend:* judge budget is 2 s from the first `101` (the kickoff's wording: "within 2 s of reconnecting"), with a reported, soft 5 s budget from the kill to the first `101`; serve before opening pi-durable; lazy-import pi-coding-agent; compile cache.
14. **Client reconnect policy.** Backoff 0, 100, 200, 400, 800, then 1000 ms with 20% jitter; immediate attempt on `online`, `pageshow` and `visibilitychange` to visible; a watchdog that reconnects after 25 s without a frame (server pings every 15 s). Every reconnect starts with a fresh thread snapshot (kickoff) and a shell `afterSequence` resume. *Recommend:* put this in `apps/web/src/Reconnect.ts` and test it with a fake clock.
15. **Streaming loss window.** After `kill -9` the last uncommitted throttle window of a reply is lost and the generation restarts; the client sees the partial text change. *Recommend:* acceptable and documented; the judge compares against the server's state after restart, never against what was shown before the kill.
16. **Send in flight at the kill.** A user hits send; the RPC dies with the socket. *Recommend:* the client keeps the outgoing message in an outbox keyed by `requestId` until the server acknowledges its submission, resends after reconnect, and shows it as "sending" meanwhile. The judge's `send-in-flight` window asserts exactly one user entry afterwards.
17. **Service worker and warm loads.** v1 chose no fetch handler for safety. *Recommend:* keep it for Phase 1; if the cold-load p50 misses 1 s because of asset transfer on cellular, add a precache of hashed assets only (cache-first for `/assets/*`, network-only for everything else, versioned cache name pruned on `activate`), which cannot serve a stale `index.html`.
18. **The load target cannot be judged from the Beelink alone.** Paint happens on the phone, and WebKit does not run on this Linux box (no sudo for system libraries; spike 2 ran WebKit on the MacBook). *Recommend:* three tiers: Chromium with CDP throttling in `pnpm check`-adjacent CI, WebKit from the MacBook through the wizard (the typing judge precedent), and the phone's own reports collected by `/api/diagnostics/load`. Define "cold" as an empty HTTP cache with the Tailscale path already direct (`tailscale ping` first), and report DERP-warmup runs separately.
19. **pi-coding-agent weight.** 152 MB installed, +95 MB RSS, +0.26 to 0.36 s import. *Recommend:* accept (ModelRuntime, skills and settings all come from it; research 01 §8 anticipated this), import lazily, and record the number in the Phase 1 notes. Copying `skills.ts` (MIT) is the fallback if the footprint becomes a problem.
20. **Skills tree walks and `settings.json` changes mid-turn.** A changed `settings.json` or a new skill changes the section and adds a `pi.system` delta (spec §12, "Moving default selections"). *Recommend:* refresh the catalog only at thread start and on `skills.reload`, not on every model call, so a running turn's prompt stays stable.
21. **Date and time rules.** Coding standard S8 forbids `Date.now()`. The v1 push code uses it for the JWT `exp`, `created_at` and TTLs. *Recommend:* take time from `Clock`/`DateTime` everywhere in the port, and a `TestClock` test for token expiry and cache TTL.
22. **iPhone permission and subscription churn.** iOS can drop a subscription silently. *Recommend:* delete on 404/410, re-register at app start, show "Notifications are off on this device" in Settings when the stored subscription is missing, and let the wizard's stage 4 prove delivery end to end.
23. **Port 3774 is the spikes' port.** No process holds it now, but spike 3 and 4 brains use it. *Recommend:* the brain takes it as `CAIRN_PORT` default 3774; judges use `CAIRN_PORT=0` and read the bound port from the events file; nothing else in Phase 1 claims 3775 or 3776.
24. **Cleaning the upload directory during a crash.** A `kill -9` mid-upload leaves a `.part`. *Recommend:* the boot sweep removes `.tmp` and `*.part`, and the judge's `kill-mid-upload` case asserts none remain and the client's retry (new signed URL, same file) succeeds.

## Judges

All judges follow `judges/typing.ts`'s convention: one JSON line per case on stdout, exit status equals the number of failed cases, and a control case that proves the judge can fail.

### Gate: identity and Origin (`judges/gate.sh`, plus `Identity.test.ts`)

Runs on the Beelink against the live `code.gneiss.run` route and brain. Port the structure of `spikes/05-signin/verify.sh` in cairn-v1.

- **Every tailnet node, asked of the auth endpoint:** for each node in `tailscale status --json` (`Self` and `Peer`), `curl -H "X-Cairn-Peer: <ip>" http://127.0.0.1:3774/_cairn/auth` must give 200 exactly when the node's `UserID` equals `Self.UserID` and the node has no tags, else 403. Today that is the Beelink and 3 others admitted, 4 refused. A new family device joining makes the judge cover it with no edit.
- **Refused paths to `code.gneiss.run`:** `curl --resolve code.gneiss.run:443:127.0.0.1`, `:192.168.4.20` (LAN), each GET and POST with the right Origin, with `X-Cairn-Peer`, `X-Forwarded-For`, `X-Real-IP`, `Forwarded` and `X-Cairn-User` forged: 403 each (loopback and LAN are "peer not found").
- **Admitted path:** `curl` over the Beelink's tailnet IP (default DNS) returns 200 with the app shell.
- **Direct hits on port 3774 without the copied header:** 403 on `/`, `/api/*` and `/ws`; `/_cairn/auth` without `X-Cairn-Peer` 403.
- **Origin matrix** (POST and DELETE, plus WebSocket upgrades with `curl --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' ...`): none, `https://evil.example`, `https://code.gneiss.run.evil.example`, `http://code.gneiss.run`, `https://plans.gneiss.run`, and the correct origin (200 and 101). Plus a wrong `Host` (421) and `Sec-Fetch-Site: cross-site` on a GET `/api` route (403).
- **Unit test (`Identity.test.ts`, `@effect/vitest`):** `Tailscale.fixed` table with owner, other user, tagged node, shared-in node, malformed address, IPv6, "not found"; `TestClock` for the 30 s cache and the 5 s negative cache. Asserts `loginName` is compared exactly (`"oscabriel@githubx"` and `"oscabriel@"` alone are refused).
- **Control:** the same run with `config.owner` changed to another login must flip the admitted rows to 403 (proves the judge reads identity).

### Durability (`judges/durability.ts`, kept code)

`node judges/durability.ts [--window <name>...] [--bridge] [--slow] [--runs N]`. Needs Chromium via Playwright (already a devDependency) and optionally the real `claude` for `--bridge`.

- **Setup per case:** a fresh data dir under `/tmp` (or `runs/`); the real brain entry point run as a transient unit: `systemd-run --user --collect --unit=cairn-judge-<n> -p Restart=always -p RestartSec=100ms -p StartLimitIntervalSec=0 -p KillMode=mixed node apps/server/src/judge-main.ts` with `CAIRN_PORT=0`. `judge-main.ts` is the same composition as `main.ts` with `Tailscale.fixed` and the judge extension (below); no production flag disables identity. The model is pi-ai's faux provider with `tokensPerSecond` set so a reply streams for several seconds, so a window can be hit on purpose.
- **Judge extension** (`judges/fixtures/JudgeTools.ts`, loaded through the Cairn extension seam): `mark` (writes a line to `effects.log` outside the store, replay-safe with a memo as in spike 3), `slow` (holds 5 s after `started`), `gate` (spike 4's approval record and wait). The events log (`events.log`) carries `listening`, `partial N`, `tool_started`, `approval_waiting`, `committed` lines so the judge can aim.
- **Clients:** (1) a Node protocol client from `packages/protocol` (the same code a GPUI client would use) and (2) a Playwright Chromium page at the test origin. Both follow the thread and the shell stream. The page exposes nothing for testing; the judge reads its transcript text from the DOM and the shell rows from `[data-testid=thread-row]`.
- **Windows** (each `kill -9`s the unit's main PID with `systemctl --user kill --kill-whom=main -s KILL`, waits for the first new `101`, and measures): `streaming` (after the 5th partial), `mid-tool` (during `slow`), `approval-parked` (`gate` pending), `between-tool-and-result` (killed 20 ms after the tool's `committed`), `mid-commit` (aim with a hold env var inside a Cairn commit, as spike 4's `SPIKE_HOLD_*`), `send-in-flight` (client sends and the kill lands before the ack), `mid-upload` (kill during a 20 MB upload), `kill-six` (five kills in a row, then retry parked tasks, mirroring spike 3 and 1.4.0's guard), `sigterm-six` (six clean restarts, nothing parked).
- **Bridge windows** (`--bridge`, real `claude` on Haiku, cost a few cents): `bridge-streaming`, `bridge-tool-parked` (spike 1's shape: tool `mark` called once), `bridge-approval-parked`; `--slow` adds a 20 minute park.
- **Assertions per window:**
  - Committed work is not lost: every entry present in the pre-kill oracle snapshot with status committed is present afterwards.
  - Unsafe tools do not rerun: `effects.log` counts equal 1 for each `mark` token, or 0 with the tool result reading "may have run" (spike 4's rule); a replay-safe tool may rerun.
  - Convergence: within 2 s of the first `101` after the restart, each client's materialized state equals the oracle, where the oracle is a third, fresh Node client's snapshot taken after the system is quiescent (for a streaming window the judge lets the turn finish first). Equality is exact for thread entries (canonical JSON hash of the projected view) and for shell rows (`sequence` equal, rows hash equal). The page's DOM text must equal the text rendered from the oracle by the same renderer in a test harness.
  - Exactly one user entry for the `send-in-flight` request; the approval accepted after restart runs once.
  - No orphans: `claude` processes alive after each kill are zero within 2 s (reuse `judges/relay-orphans.sh`'s cgroup method).
  - Reported, not asserted: kill to first `101` (soft 5 s), snapshot bytes, time to first frame.
- **Control:** `--sabotage skip-snapshot` makes the server omit the snapshot on reconnect; the judge must fail every window.
- Output: one JSON line per window with `{ window, pass, killToUp, upToConverged, effects, entries }`.

### Paste to model (`judges/paste.ts`)

- **Automated (Chromium and, on the MacBook, WebKit at iPhone width):** generate a screenshot-like PNG (1170x2532) containing a random nonce word rendered as text. Playwright dispatches a real `ClipboardEvent("paste")` carrying the file in `clipboardData`, then clicks send without waiting. Brain events provide the timeline: `attachment.url_issued`, `attachment.stored`, `attachment.prepared`, `turn.submitted`, `provider.request`. Pass when the client's paste-to-chip-ready is at most 1.5 s p95 over 20 runs, send-to-`turn.submitted` is at most 0.5 s, the paste-and-send-at-once path is at most 2 s end to end, and the `provider.request` record's image sha256 equals the sha256 of the prepared bytes (the model's input really contains the pasted image, not a different one). Network shaping with CDP presets: LAN (no shaping) and 10 Mbps up with 60 ms RTT.
- **Real model correctness:** one run with Haiku through the bridge and one through OpenCode Go asks "what word is in the image?" and the reply must contain the nonce, which a model cannot guess.
- **Phone (wizard stage 6):** the page `judges/paste.ts --page` (served as a dev route while the judge runs) shows a new nonce; the user screenshots it on the iPhone, pastes into a thread in the PWA and sends; the judge prints the same timeline from the brain events plus the client's paste-to-ready value, which the composer reports in the `createUploadUrl` request as `pasteToRequestMs` (monotonic clock on the phone) so no cross-device clock is trusted.
- **Document variant:** upload a generated 3-page PDF whose pages each hold a nonce; the reply must contain all three (proves multi-page text reached the model as content, not a path); a scanned-style PDF (an image saved as PDF) must produce the "no text layer" note and a tool-assisted answer; a DOCX with a nonce; a 50 MB PDF is refused with the plain message.
- **Unit tests:** `Sniff.test.ts` (magic bytes, renamed extension lies, HEIC refusal), `UploadTokens.test.ts` (expiry via `TestClock`, tampered payload, wrong length body, overflow body, replayed token after claim), `TextExtract.test.ts` (fixture PDFs: text, two columns, empty; zip bomb DOCX; timeout), `AttachmentContent.test.ts` (inline cap and truncation text), `wire.test.ts` (no image bytes in any frame).

### Load (`judges/load.ts`)

- `node judges/load.ts https://code.gneiss.run --browser chromium --profile lan|4g --runs 20`: fresh context per run, HTTP cache empty, `Network.emulateNetworkConditions` for `4g` (60 ms RTT, 10 Mbps), measures navigation start to `cairn:interactive` (read with `performance.getEntriesByName`). Pass: p50 below 1000 ms for both profiles, p95 below 1500 ms; also records transferred bytes and request count (budget: at most 6 requests before interactive, `index.html` + entry JS + CSS + sw registration + `/ws`).
- `--browser webkit` is run from the MacBook by the wizard (same file, like `typing.mts`).
- **Phone:** `node judges/load.ts --collect --device phone --runs 3` waits for `GET /api/diagnostics/load` rows tagged with the phone's user agent and standalone flag, after the wizard has run `tailscale ping <phone>` to confirm a direct path. Pass: median `interactive` below 1000 ms. Rows from a DERP path are reported separately.
- **Budget test in `pnpm check`:** a vitest that reads the Vite build manifest and fails if the entry chunk exceeds 200 KB gzip or the CSS 35 KB gzip.
- **Control:** a `?slow=1500` flag in the judge's dev build delays `index.html`; the judge must fail it.

### Push (`judges/push.ts`, `WebPush.test.ts`)

- **Crypto conformance (unit):** RFC 8291 Appendix A fixes the user agent key, auth secret, salt and application server key; `WebPush.encrypt` takes injectable randomness and must reproduce the RFC's ciphertext byte for byte; a second test decrypts Cairn's output with a small independent receiver implementation and with the `web-push` package as a dev-only oracle. VAPID: verify the produced JWT with the public key (`aud` equals the endpoint origin, `exp` within 24 h, `sub` present).
- **Sender behaviour (unit, fake push service on a local server via `allowEndpoint`):** 201 delivers once; 429 and 5xx retry with doubling delay; 404 and 410 delete the row; the same `run_id` replayed twice sends once; a visible-client presence report suppresses the push; payload under 3.5 KB.
- **Live (wizard stage 4):** `node judges/push.ts --send` sends to every stored subscription and prints the push service's status and latency (Apple 201 in about 300 ms in v1); the user confirms the notification on the locked phone, and tapping it opens `/t/<id>`.
- **iOS requirements checked in the PWA test:** Playwright asserts the manifest fields, the service worker registration at `/sw.js` with scope `/`, and that `sw.js` contains no `fetch` listener (a regex test, so the safety rule in ADR 0017 cannot regress).

### Skills (`judges/skills.ts`, `SkillCatalog.test.ts`)

- **Loader parity:** against a fixture agent dir and home (`judges/fixtures/pi-home/`) the section text equals `formatSkillsForPrompt(loadSkills({...}))` for the same roots; with `+`/`!` filters it equals what pi's own `DefaultResourceLoader.getSkills()` returns for the same settings (the outside oracle is pi itself). On the Beelink, `judges/skills.ts` runs the same comparison against the real `~/.pi/agent` and prints counts and diagnostics; the name sets must be equal and the user's `!skills/pstack/...` exclusions must not appear.
- **Stability:** three consecutive renders are byte-identical; a conversation of three turns has exactly one `pi.system` entry carrying `skills`; editing one `SKILL.md` description then starting the next turn produces exactly one delta.
- **Project override:** a fixture project with `.agents/skills/<name>` of the same name as a user skill wins; `.pi/skills` in the project is not read.
- **Claude delivery:** with the bridge, change one skill description between turns; the next user message sent to Claude contains one `<system-reminder>` naming it (read from the bridge's outgoing prompt log), and the cache read to write ratio stays above 10x on the turn after.
- **Model behaviour:** one cheap real-model call is given only the section and asked which skill it would read for a named task; the answer must be the matching skill's name.
- **Cost:** catalog snapshot render under 1 ms warm, resolve under 600 ms cold (v1 saw 400 ms).

### Shutdown (`judges/shutdown.sh`)

- With the real unit `cairn.service` (or a transient copy): start a faux-model turn that streams and a `slow` tool; `systemctl --user restart` six times during one long tool; assert `journalctl --user -u cairn` shows `closing` then `closed <ms>` each time with `<ms>` under 5000, zero `shutdown_slow`, `systemctl --user show -P NRestarts` unchanged (a restart is not a crash), no task `blocked` with `restart_limit` afterwards (read through the debug-free `GET /_cairn/health?tasks=1` on loopback, or `harness.inspect` in a test composition), and zero `claude` processes outside the unit. Then five `kill -9`s: tasks parked, shell stream lists them with Retry, `retry` completes the turn with each effect once. Control: a tool that ignores its signal (`JudgeTools.stubborn`) makes `close()` exceed `TimeoutStopSec`; the judge must see SIGKILL and a counted crash.

### Steps only the user can do

Listed under "Wizard" above. Everything else (unit install, Caddy route, judges on the Beelink) runs without them. The rest of the edge requirements have no user step.

### Suggested order inside Phase 1 for these edges

1. Guard, Identity, Tailscale service, unit, Caddy route, `judges/gate.sh` (everything else is reachable only after this).
2. `judges/durability.ts` skeleton with the faux model and the `streaming` and `mid-tool` windows, before the web client exists (it uses the Node client).
3. Boot, Shutdown and `judges/shutdown.sh`.
4. Attachments server side with `paste.ts` automated tier; then the web composer pieces.
5. Skills section and `skills.ts`.
6. Static serving with budgets, boot JSON, diagnostics reports, `load.ts` automated tiers.
7. Push and the PWA files; wizard stages 2 to 6 on the phone.
8. Bridge windows of the durability judge once the bridge lands.
