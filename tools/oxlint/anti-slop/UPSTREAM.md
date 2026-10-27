# Upstream

## The base install

- Source: the `install-anti-slop` skill at `~/.agents/skills/install-anti-slop/assets/anti-slop`, a snapshot dated 2026-09-26. The skill's upstream repository and commit are not recorded on this machine, so the source commit is unknown.
- Snapshot identity: sha256 of the sorted file hashes of that asset tree, first 16 hex characters: `2cf66fa1be860828`.
- Installed on 2026-10-20 with `node ~/.agents/skills/install-anti-slop/scripts/install.mjs`, to `tools/oxlint/anti-slop/` (generic plugin `index.ts`, Effect plugin `effect/index.ts`).
- Vendored Stylistic code keeps its own `vendor/eslint-stylistic/LICENSE` and `UPSTREAM.md`.
- Deviations: none.

Cairn's own three rules, which neither source below has, stay as installed: `no-array-filter-map`, `no-reduce-accumulator-copy` and `require-readable-spacing`.

## The 2026-10-27 refresh

Four rules added on 2026-10-27, each file copied byte for byte and registered in `index.ts`. The rest of the tree was not re-synced, so the older rules still differ from these sources.

| Rule | Source | Path | Commit |
| --- | --- | --- | --- |
| `max-ternary-depth` | [K-Mistele/anti-slop](https://github.com/K-Mistele/anti-slop) (a fork of dmmulroy/anti-slop) | `src/rules/max-ternary-depth.ts` | `3abfdfb3ce1f0aa3c692a7b4c7520bbfd87ccd9c` |
| `no-conditional-spread` | K-Mistele/anti-slop | `src/rules/no-conditional-spread.ts` | `3abfdfb3ce1f0aa3c692a7b4c7520bbfd87ccd9c` |
| `no-reprovide-ambient-service` | K-Mistele/anti-slop | `src/rules/no-reprovide-ambient-service.ts` | `3abfdfb3ce1f0aa3c692a7b4c7520bbfd87ccd9c` |
| `no-conditional-empty-array-spread` | [humanlayer/fold](https://github.com/humanlayer/fold), a local rule of Fold's anti-slop copy | `tools/oxlint/anti-slop/rules/no-conditional-empty-array-spread.ts` | `4bd8c58c4c644ad43df573c156ecdf8bddedd04d` |

`oxlint.config.ts` enables all four. It kept `no-conditional-spread` and `no-conditional-empty-array-spread` off until the 86 and 63 spreads they flagged were rewritten, later on 2026-10-27. `judges/lint-rules.test.ts` probes every rule.

Both sources are MIT licensed:

```
MIT License

Copyright (c) 2026 Dillon Mulroy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

```
MIT License

Copyright (c) 2026 HumanLayer

(The permission notice and disclaimer are word for word the ones above.)
```
