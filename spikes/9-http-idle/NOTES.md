# Spike 9: does Node's default HTTP timeout cut a quiet provider stream?

Result: **yes for every HTTP stream, at 301.9 s, the same as pi's own default; no for codex's default WebSocket transport. Decision: no change.** In the brain, a provider stream over HTTP (opencode-go's `openai-completions` and `anthropic-messages` models, codex over SSE) that goes quiet for longer than 300 s, before its headers or mid-body, is cut 301.9 s after its last byte. pi-durable then retries the generation three times and fails the run. pi-coding-agent's own dispatcher uses the same 300 s by default, so pi's TUI cuts at the same point, and the user's `settings.json` changes nothing. Codex with the default transport (`auto`) streams over a WebSocket, which no undici timeout touches once it is open. It held a 330 s silence.

Run on 2026-10-27 on the Beelink with `/usr/bin/node` v26.11.1 (bundled undici 8.11.2), which is what `cairn.service` runs. pi 1.4.0 (pi-ai, pi-coding-agent and pi-durable, with npm undici 8.10.2 under pi-coding-agent). No real provider and no credentials: a fake server on an ephemeral loopback port, and a codex token made up as a JWT carrying only an account id claim.

The question comes from HazAT/ultimate at `8b263386`. Its `server/http.ts` copies pi-coding-agent 1.4.0's unexported `src/core/http-dispatcher.ts`, and `server/harness.ts` calls `configureHttpDispatcher(settings.getHttpIdleTimeoutMs())`, saying this "prevents early provider stream termination".

## What the brain's HTTP client is (from source)

- **Every non-bridge provider uses the global `fetch`.** `openai-completions` goes through the openai SDK 7.19.0 and `anthropic-messages` through the Anthropic SDK. Neither is given a `fetch` by pi-ai or pi-durable, so both use the global one. Codex (`openai-codex-responses`) calls `options.fetch ?? globalThis.fetch` for SSE, and Node's global `WebSocket` (undici's) for its default transport. pi-ai has no undici `Agent` of its own.
- **The global dispatcher is a default npm undici `Agent`.** `PiModelSource` imports pi-coding-agent when its layer is built. That import loads npm undici 8.10.2 (`core/http-dispatcher.js` imports it), and undici's `lib/global.js` installs `new Agent()` as the global dispatcher when it loads, if none is set yet. Node's bundled `fetch` then runs on that `Agent` (checked: `globalThis[Symbol.for("undici.globalDispatcher.2")] instanceof Agent` from undici 8.10.2 is true after the import, and is still the same object after a fetch). Its options are empty, so undici's client defaults apply: `headersTimeout` and `bodyTimeout` are both 300,000 ms (`client.js`: `bodyTimeout != null ? bodyTimeout : 300e3`). If something fetched before that import, the bundled undici's own default `Agent` would be installed instead, with the same 300 s timeouts. Both are measured below (`brain` and `node`).
- **`bodyTimeout` is an idle timeout, not a total one.** It restarts on every chunk. After a WebSocket upgrade, undici destroys the HTTP parser and its timers (`client-h1.js`, `onUpgrade`), so a WebSocket that is open has no undici timeout.
- **pi's own timeouts in the brain.** Cairn passes no `timeoutMs` (pi's `retry.provider.timeoutMs` is unset), so the SDKs keep their 10-minute request timeout. That timeout covers only the wait for headers, and undici's 300 s fires first. Codex's WebSocket idle timer is `timeoutMs` too, so it is off. Codex's WebSocket connect timeout is pi-ai's default of 15 s, and a WebSocket that fails before its first event falls back to SSE. Provider-level retries are 0 (`maxRetries` unset).
- **pi's setting exists.** pi-coding-agent 1.4.0 has `httpIdleTimeoutMs` in its settings schema ("HTTP header or body idle timeout in milliseconds; 0 or \"disabled\" disables it"), `SettingsManager.getHttpIdleTimeoutMs()` defaults it to `DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000`, and its `/settings` offers 30 s, 1 min, 2 min, 5 min and disabled. `main.js` calls `configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs())`. That function builds an `EnvHttpProxyAgent` with both timeouts set to the value, `allowH2: false`, a 2 s `autoSelectFamilyAttemptTimeout` and an error listener, and then calls `undici.install()` so `fetch` comes from the same undici. pi's `origin/main` (`7c22a93d0`, 2026-10-22) still defaults to 300 s. `configureHttpDispatcher` is not exported from pi-coding-agent's index, which is why ultimate copied the file. The user's `~/.pi/agent/settings.json` sets neither `httpIdleTimeoutMs` nor `retry`.

So with defaults, ultimate's dispatcher sets the same 300 s that Node already applies. What it changes: npm undici's `fetch` in place of Node's, proxy support, the 2 s connection-attempt timeout, and whatever the user sets in `httpIdleTimeoutMs`. Separately, ultimate's `stream` getter maps the idle setting onto `timeoutMs` when pi's provider timeout is unset. That gives codex's WebSocket a 300 s idle cut it does not have in Cairn.

## What the spike does

`idle.ts` starts the fake server and drives pi-ai's own provider code against it, with the stream options pi-durable passes in the brain (`transport: "auto"`, `maxRetryDelayMs: 60000`, a session id, no `timeoutMs`, no `maxRetries`). The model objects are the real catalog entries (opencode-go's first `openai-completions` model and its `claude-haiku-5-5` through `withOpenCodeSessionHeader`, codex's first model) with only `baseUrl` moved to the fake server. The one step it skips is pi-ai's `Models` dispatcher and Cairn's credential lookup above the provider's `streamSimple`. That step adds no HTTP behaviour.

Cases, all started at once:

- `-body`: headers and a first chunk ("hello ") at once, then silence for `--quiet`, then the rest.
- `-headers`: silence for `--quiet` before the headers (for `codex-ws`, before the `101` handshake).
- `completions-trickle`: one chunk every 200 s, three gaps, 600 s in all.
- Paths: `raw` (plain `fetch`, to name undici's error), `completions`, `anthropic`, `codex-sse` (transport `sse`) and `codex-ws` (transport `auto`, the user's setting).

Dispatchers: `brain` (import pi-coding-agent first, as the brain does), `node` (nothing extra) and `pi:0` (pi's `configureHttpDispatcher(0)`, that is, pi's setting at "disabled"). A short run with `pi:3000` and a 6 s silence checked the harness before the long runs.

`thread.ts` runs one `completions-body` case through a bare pi-durable Harness (as `judges/claude-live.ts` opens one) with the brain's retry policy (pi's defaults: enabled, 3 retries, 2 s base) and Cairn's stream settings. It uses a 3 s dispatcher timeout so that a 300 s cut repeats in seconds. `idle.ts` shows the cut and its message are the same at 300 s.

```
node spikes/9-http-idle/idle.ts --quiet=330000 --trickle=200000 --dispatcher=brain
node spikes/9-http-idle/thread.ts --timeout=3000 --quiet=6000
```

## Numbers

A 330 s silence. Time is from the request to the end of the stream. The message is the assistant message's `errorMessage`, and "retryable" is pi-ai's `isRetryableAssistantError`. The server saw the client close its socket at 301,925 ms (`brain`) and 301,912 ms (`node`) for every cut case.

| Case | `brain` (default `Agent`) | `node` (bundled default) | `pi:0` (timeouts off) |
| --- | --- | --- | --- |
| `raw-body` | cut at 301,933 ms: `TypeError: terminated`, cause `BodyTimeoutError` `UND_ERR_BODY_TIMEOUT` | cut at 301,916 ms, same error | completed at 330,131 ms |
| `raw-headers` | cut at 301,935 ms: `TypeError: fetch failed`, cause `HeadersTimeoutError` `UND_ERR_HEADERS_TIMEOUT` | cut at 301,914 ms, same error | completed at 330,129 ms |
| `completions-body` | error at 301,924 ms: `terminated` (retryable), partial text "hello " kept | 301,907 ms, same | stop at 330,132 ms |
| `completions-headers` | error at 301,934 ms: `Request timed out. Node.js fetch timed out waiting for response headers; configure a matching undici fetch and fetchOptions.dispatcher with an Agent whose headersTimeout is at least the SDK timeout.` (retryable) | 301,912 ms, same | stop at 330,129 ms |
| `anthropic-body` | error at 301,925 ms: `terminated` (retryable), "hello " kept | 301,908 ms, same | stop at 330,127 ms |
| `anthropic-headers` | error at 301,922 ms: `Request timed out.` (retryable) | 301,905 ms, same | stop at 330,126 ms |
| `codex-sse-body` | error at 301,929 ms: `terminated` (retryable), "hello " kept | 301,908 ms, same | stop at 330,124 ms |
| `codex-sse-headers` | error at 301,925 ms: `fetch failed` (retryable) | 301,906 ms, same | stop at 330,124 ms |
| `codex-ws-body` | **stop at 330,033 ms, whole answer** | stop at 330,026 ms | stop at 330,124 ms |
| `codex-ws-headers` | WebSocket connect timeout after 15,000 ms, fell back to SSE, stop at 15,014 ms | 15,013 ms, same | 15,013 ms, same |
| `completions-trickle` (3 gaps of 200 s) | **stop at 600,045 ms, whole answer** | stop at 600,036 ms | stop at 600,286 ms |

The cut lands at 301.9 s, not 300.0 s, because undici checks its timeouts on a coarse timer (about 1 s ticks).

The short run with `pi:3000` cut each HTTP case at 3.5 s with the same messages. Under that dispatcher, `codex-ws-headers` fell back to SSE at 3.5 s instead of 15 s, because the WebSocket handshake goes through the dispatcher's `headersTimeout`.

What a thread records (`thread.ts`, 3 s timeout, a provider that goes quiet on every attempt):

| Attempt | Request at | Cut at | Entry |
| --- | --- | --- | --- |
| 1 | 66 ms | 3,572 ms | `pi.assistant`, `stopReason: error`, `errorMessage: terminated`, text "attempt 1 says hello " |
| 2 | 5,586 ms | 9,094 ms | same, "attempt 2 ..." |
| 3 | 13,105 ms | 16,611 ms | same, "attempt 3 ..." |
| 4 | 24,642 ms | 28,153 ms | same, "attempt 4 ..." |

The submission settled `unanswered`, reason `model_error`, detail `terminated`. The gaps between attempts are pi's 2 s, 4 s and 8 s backoff. At the real timeout, the same run takes 4 × 301.9 s plus 14 s, about 20 minutes, before it fails.

## Answers

1. **Client and timeouts.** The global `fetch` (openai and Anthropic SDKs, codex SSE) and the global `WebSocket` (codex `auto`), on a default undici `Agent` with `headersTimeout` and `bodyTimeout` of 300 s, both idle timeouts. pi-coding-agent configures the same 300 s by default through `httpIdleTimeoutMs`, which exists in pi's settings and which the user has not set.
2. **When and how a quiet stream ends.** A silence before the headers or mid-body ends an HTTP stream at 301.9 s. Mid-body, it ends with `TypeError: terminated` (cause `BodyTimeoutError`, `UND_ERR_BODY_TIMEOUT`), which pi-ai reports as `terminated` and keeps the partial text. Before the headers, it ends with `TypeError: fetch failed` (cause `HeadersTimeoutError`, `UND_ERR_HEADERS_TIMEOUT`), which pi-ai reports as `fetch failed` (codex), `Request timed out.` (Anthropic SDK) or the openai SDK's longer message above. Gaps shorter than 300 s never cut, however long the stream: 600 s held. Codex over its default WebSocket held 330 s of silence. A stalled handshake falls back to SSE after pi-ai's own 15 s connect timeout, not after 300 s.
3. **Retries and what the user sees.** pi-ai itself does not retry: provider retries are 0, and a cut mid-body is past the SDK's retry point anyway. pi-durable does: every message above matches pi-ai's retryable patterns (`terminated`, `fetch failed`, `timed out`), so the generation runs up to three more times. From the timeline code (not a screenshot), the thread shows each attempt's partial text followed by a red error row reading `terminated`, four times about five minutes apart. The run then fails, the last error row offers Retry, and the thread's `lastError` reads "The model provider refused the request. Send again to retry.", because `RunFailure.ts`'s transport pattern does not match `terminated` (see "Found on the way"). A provider that really stays quiet for more than 300 s fails the same way on every attempt.

## Decision: no change

Cairn configures no dispatcher, and `HarnessSettings.ts` stays as it is.

- The brain already cuts where pi does. With no `httpIdleTimeoutMs` in the user's settings, pi's TUI builds its dispatcher with 300 s for both timeouts, the same values the brain gets from undici's default. Configuring pi's dispatcher at its default would change no number in the table above.
- The user's providers are not exposed in the case that matters most. Codex, the one long-reasoning provider the user has logged in (`openai-codex` OAuth), streams over the WebSocket with the `auto` transport, and an open WebSocket has no undici timeout. opencode-go streams over HTTP and would be cut only by a silence of more than five minutes between two events, which this spike cannot measure without a real provider.
- A cut is not lost silently. pi-durable retries it, and the run fails visibly, with the user's queue kept.
- Turning the timeout off (`pi:0`) would trade a five-minute cut for a stream that waits forever on a dead connection, and nothing in the bridge-free path has a stall watchdog to replace it.

If a real provider is ever seen going quiet for more than 300 s, the change is this: read pi's `httpIdleTimeoutMs` (it is already in pi's settings, so the TUI and Cairn would agree, as `HarnessSettings.ts`'s header asks) and install a dispatcher once at boot with both timeouts at that value. It does not belong in `HarnessSettings.ts`, because that is a per-request getter pi-durable reads at each use, while the dispatcher is process-wide and set once. It would sit beside `PiModelSource`'s layer, as a port of intent of pi's `configureHttpDispatcher`, since that function is not exported. Two cautions for that change: do not map the idle setting onto `stream.timeoutMs` as ultimate does, because that adds a 300 s idle cut to codex's WebSocket; and keep the bridge out of it (it is a subprocess with its own HTTP client).

## Found on the way

1. **A cut stream is reported as a refusal.** `apps/server/src/brain/RunFailure.ts`'s `TRANSPORT_PATTERN` matches `fetch failed` and `timed out` but not `terminated`. So a body timeout, or any connection that drops mid-stream, is classified `provider_error`, and the thread says "The model provider refused the request." instead of "could not be reached". Adding `terminated` to that pattern would fix it. I did not change it here (outside this task).
2. **Compressed responses decode under the brain's mixed setup.** pi's dispatcher comment warns that Node 26.0's bundled `fetch` over npm undici's dispatcher can skip decompression. On Node 26.11, with pi-coding-agent imported, the bundled `fetch` decoded gzip, br and zstd JSON bodies correctly (checked once, outside the spike folder).
3. **Codex's WebSocket handshake follows the dispatcher.** Under a shorter dispatcher timeout, the handshake gives up at that timeout instead of pi-ai's 15 s connect timeout. This matters only if a dispatcher below 15 s is ever configured.
