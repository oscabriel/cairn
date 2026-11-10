# Upstream

Cairn's own Effect rules, under the plugin name `automation` so their ids match the Fold rules they come from. Unlike `../anti-slop/`, this folder is Cairn code: it is formatted, linted and typechecked, and each rule has a RuleTester test beside it.

## Sources

| Rule | Idea from | Path | Commit |
| --- | --- | --- | --- |
| `no-ambient-nondeterminism` | [typeonce-dev/ai-automation](https://github.com/typeonce-dev/ai-automation), as adapted in [humanlayer/fold](https://github.com/humanlayer/fold) | `rules/oxlint/src/rules/no-ambient-nondeterminism.ts`; Fold's `tools/oxlint/automation/rules/no-ambient-nondeterminism.ts` | ai-automation `0bca096fe6fe9878cd15303a623dd2cd85915ddd`; Fold `4bd8c58c4c644ad43df573c156ecdf8bddedd04d` |
| `no-silent-error-swallow` | the same | `rules/oxlint/src/rules/no-silent-error-swallow.ts`; Fold's `tools/oxlint/automation/rules/no-silent-error-swallow.ts` | the same |
| `no-bare-effect-run` | none: Cairn's own (coding standard S43) |  |  |
| `no-raw-test-limit` | none: Cairn's own (glossary: Test slack) |  |  |

Fold took the rules from humanlayer/channels `e499a74`, which took them from ai-automation. Checked on 2026-10-27: Fold is MIT (HumanLayer), but ai-automation has no license (GitHub reports none, and the repository has no `LICENSE` file or `license` field). Fold's copies carry no header and are adaptations of that unlicensed code. So no text was taken from either: the rules were written for Cairn from their intent, and each file's header says so (coding standard S65).

## What Cairn's rules do differently

- `no-ambient-nondeterminism` decides what is ambient from the global scope's unresolved references, so a local binding (`const crypto = yield* Crypto.Crypto`, a parameter called `Math`) passes. It flags `Date.now()`, `Date()`, a bare `new Date()`, `Math.random` and the `crypto` global, also through `globalThis`. It adds the random exports of `node:crypto` (`randomUUID`, `randomBytes`, `randomInt`, `getRandomValues`, `randomFill`, `randomFillSync`, `webcrypto`), named or through a namespace import. It lets `crypto.subtle` through: WebCrypto's signing and key agreement have no Effect service.
- `no-silent-error-swallow` covers every `Effect.catch*` combinator (`catchCause`, `catchIf` and the rest, not only `catch`, `catchTag`, `catchTags` and the reason pair), resolves `Effect` from its import (`effect` or `effect/Effect`) and drops Effect 3's `Effect.unit`.

- `no-bare-effect-run` flags `Effect.runPromise`, `runPromiseExit`, `runFork`, `runSync`, `runSyncExit` and `runCallback`, through the `effect` barrel (renamed or not), the `effect/Effect` namespace or a named import. Their `*With` forms take a context and pass.
- `no-raw-test-limit` flags every Vitest limit that does not scale by the test slack: the limit argument of `it`, `test`, `describe`, `suite`, `bench` or a hook, through any modifier or `each`, called or tagged (`it.live(name, body, limit)`), and the `timeout` of an options object passed to one or to `@effect/vitest`'s `layer(X, { timeout })`. Only `testLimit(...)`, or a `const` of the same file holding one, passes. Anything else is reported, whatever its value: a number, arithmetic such as `120_000 * TEST_SLACK`, a `const` holding them, an imported constant (even one a test kit scaled), a `let` or a parameter, since nothing in the file shows that it scales.

## Scope

The first two rules apply to every linted file, tests included, with one exception. `no-ambient-nondeterminism` is off under `judges/`: judges watch the real system from outside, wait on wall-clock deadlines and name their probes with real randomness. `spikes/` is not linted at all.

`no-raw-test-limit` applies to the test files of the server (`apps/server/src`), the judges' library (`judges/lib`) and `tools/`.

`no-bare-effect-run` applies to the server's and the bridge's source only, and not to what runs outside the app's layers: entry points (`main.ts`, `dev-main.ts`, `judge-main.ts`, the extraction worker), fixtures, tests and test kits, and the conformance suite.

Effect's default `Random` is `Math.random`, so the few places that need a CSPRNG (the upload signing key and attachment ids in `UploadTokens.ts`, RFC 8291's salt in `WebPush.ts`) keep the platform source behind an `oxlint-disable-next-line` that gives the reason.
