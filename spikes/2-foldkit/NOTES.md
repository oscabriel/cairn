# Spike 2: Foldkit composer and sidebar

Result: **passed.**
- **Typing.** The composer dropped zero keystrokes in every run: Chromium on the Beelink (throttled 4x and 6x included) and WebKit at iPhone size on the MacBook. IME composition worked in Chromium and, by hand, on the iPhone.
- **Parity.** The sidebar, draft hero and composer render pixel-identical to t3code at 1440 and 390 px.
- **Judges.** GPT 6 Luna judged every checklist row "same as t3code", and so did the user.

Run on 2026-10-21 on the Beelink: Foldkit 0.169.0 (`@foldkit/ui` 0.169.0, vite plugin 0.28.0), Effect 4.0.5 (Foldkit's exact `4.0.0` peer overridden), Tailwind 4.3.3 (t3code's version), Vite 8.3.5, Playwright 1.64.1 with Chromium 1248, against the t3code nightly at `fe27e8e3` served at `t3.gneiss.run`.

## Shape

- **The markup is t3code's.** `gen/capture.mjs` saves t3code's rendered new-thread page at 1440 px, 390 px, and 390 px with the sidebar open.
  - `gen/dom2foldkit.py` turns those DOM trees into Foldkit view code (`src/t3/`) with the same tags, classes and attributes.
  - Slots replace the parts that change: the thread list, the composer's editor, the draft project and the monogram tones.
  - Rows come from two templates, a working row and an idle row.
- **The CSS is t3code's.** `src/styles.css` is t3code's `index.css`, with a header, compiled by the same Tailwind. Identical class strings give identical CSS. Project tones arrive as data, so an `@source inline()` names t3code's palette.
- **Live parts:** the composer (a textarea, the parity plan's decision 3), the rows, the draft project, the phone sidebar toggle, and a streaming transcript for the typing test (`?stream=1`, about 40 tokens a second).
- **Not built:** menus, hover actions, search, the model picker, footer controls folding by width. The markup is there; the behaviour is Phase 1's port.

## Typing

`judges/typing.ts` (kept code) types at a fixed rate into `[data-testid=composer-editor]` while the transcript streams, each key on its own schedule. It then composes `日本` between plain keys through CDP IME events (Chromium only) and compares.

| Run (60 s) | Sent | Received | Late keys (max) | IME |
| --- | --- | --- | --- | --- |
| Chromium 1440 px, 20/s (three runs) | 1,200 | 1,200 | 1 (0 ms) | ok |
| Chromium iPhone size, 20/s | 1,200 | 1,200 | 1 (0 ms) | ok |
| Chromium, 4x CPU throttle, 20/s | 1,200 | 1,200 | 1 (0 ms) | ok |
| Chromium iPhone size, 4x throttle, 20/s | 1,200 | 1,200 | 1 (0 ms) | ok |
| Chromium, 6x throttle, 30/s | 1,800 | 1,800 | 50 (29 ms) | ok |
| WebKit on the MacBook, iPhone size, 20/s | 1,200 | 1,200 | 1 (0 ms) | ok, by hand on the iPhone |

**The judge can fail.** `?busy=<ms>` adds work to every update, the load behind Foldkit's keystroke-loss bug (#1697, fixed in 0.169.0 on 2026-10-20). The same 20 s runs:

| Load | Foldkit 0.168.0 | Foldkit 0.169.0 |
| --- | --- | --- |
| 6 ms per update | 400 of 400; IME garbled (`abnにほ日本cd`) | 400 of 400; IME ok |
| 10 ms, 30/s | 600 of 600; IME garbled | 600 of 600; IME ok |
| 20 ms | **337 of 400** (first loss at key 5); IME garbled | 400 of 400; IME ok |
| 6 ms, 4x throttle | 400 of 400; IME garbled | 400 of 400; IME ok |

So 0.169.0 is required, and composition was broken on 0.168.0 under any load, not only the dropped keys the issue describes.

## Parity

`judges/parity.ts` (kept code) renders both apps in one headless Chromium with the same viewport, scale and colour scheme. It copies t3code's rows and draft project into Cairn's `#fixture=`, and closes t3code's thread details panel, which is outside this gate. Then it diffs the pixels (a colour delta over 24 counts).

| View | Pixels that differ |
| --- | --- |
| 1440 x 900 | 0% |
| 390 x 844 | 0% |
| 390 x 844, sidebar open | 0% to 0.011% (the working thread's age ticking over between shots) |

Control: with Cairn's phone sidebar wrongly open, the 390 view differs by 71.3%.

`judges/parity-review.sh` sends the six screenshots, with no tools, to a model from another family. It checks them against the parity plan's checklist rows (sidebar, new thread, composer, look). GPT 6 Luna through pi and the OpenCode Go key judged every row "same as t3code". It listed what screenshots can't show: hover actions, search, the project picker's search, footer controls folding by width, animations. The Codex CLI's own login was revoked, and pi's `openai-codex` login refuses every GPT model "with a ChatGPT account". OpenCode Go's GPT works.

The t3code side needs a session. The harness pairs read-only (`t3 pair --scope orchestration:read --label cairn-parity-harness`, a five-minute single-use token, used at once) and keeps the storage state in `runs/` (ignored). The pairing shows in t3code's connections list.

## Decisions

- **Foldkit passes the composer and sidebar gate.** ADR 0011 is accepted.
- **Pin Foldkit 0.169.0 or later.** 0.168.0 drops keys and garbles IME under load.
- **Parity baselines come from t3code's DOM.** Capturing a state and generating its markup gives exact parity for that state, and the harness proves it. Phase 1 keeps this for baselines, one state at a time. It writes the views by hand from them, with behaviour ported from t3code's logic files: generated views are not maintainable code.
- **The brand.** The spike still says "T3 Code" with t3code's logo, because pixels were compared. Cairn's name and mark are the user's call in Phase 1.
- **How close to t3code.** The user's verdict was "same", with the note that the copy is eerily exact and may not be what they want. Parity here proves Foldkit can render t3code's surfaces; how far Cairn's look departs from t3code is a Phase 1 question.

## Noticed

- Foldkit's dev runtime warns once per load: "Slow patch: 9.4ms (budget: 8ms), triggered by init". The generated tree is large and unmemoized.
- Vite's first load after `--force` reloads the page while it optimizes dependencies. A test that starts then times out once.
- Playwright's WebKit can't run on CachyOS without system libraries (no sudo), so WebKit runs on the MacBook.
- `npx tsx` needs a `.mts` name for top-level await when `package.json` is CommonJS. The wizard saves the typing judge as `typing.mts`.

## Files

- `src/main.ts`, `src/model.ts`: the app. `src/t3/`: generated. `src/styles.css`: t3code's `index.css`.
- `gen/capture.mjs`, `gen/dom2foldkit.py`, `gen/gen.sh`: capture and generate.
- `public/typing.ts`: a link to `judges/typing.ts`, served at `https://cairn-s2.gneiss.run/typing.ts` for the MacBook.
- `vite.config.ts`: port 3774, and a key gate for requests through Caddy (`runs/page.key`).
- `runs/` (ignored): captures, the t3code session, screenshots, typing results, the user's verdict.
