// Ported from cairn-v1 at 1a5cd4a, apps/web/src/markdown/highlight.ts. Kept: shiki's JavaScript
// regex engine (no WASM); nothing loads until a code block mounts, then the core and both GitHub
// themes come with the first grammar and each grammar is its own lazily imported chunk; the view
// reads tokens synchronously and only for a language the Model lists as loaded, so a block shows
// plain text first and the same text, colored, after, without a layout shift; colors are checked
// to be plain hex; a failed load is forgotten so a later block tries again. Changed: async
// functions and a typed failure instead of promise chains, and a smaller grammar list. The token
// cache is an LRU refreshed on a hit and bounded by entries and approximate bytes, with the sizes of
// t3code's highlight cache (github.com/pingdotgg/t3code, apps/web/src/lib/lruCache.ts and
// apps/web/src/components/ChatMarkdown.tsx at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92).
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { Duration, Effect, Option, Schema, Stream } from "effect";
import type { HighlighterCore, LanguageRegistration } from "shiki/core";

interface GrammarModule {
  readonly default: ReadonlyArray<LanguageRegistration>;
}

const GRAMMARS = {
  bash: async () => await import("shiki/langs/bash.mjs"),
  c: async () => await import("shiki/langs/c.mjs"),
  cpp: async () => await import("shiki/langs/cpp.mjs"),
  css: async () => await import("shiki/langs/css.mjs"),
  diff: async () => await import("shiki/langs/diff.mjs"),
  dockerfile: async () => await import("shiki/langs/dockerfile.mjs"),
  go: async () => await import("shiki/langs/go.mjs"),
  html: async () => await import("shiki/langs/html.mjs"),
  java: async () => await import("shiki/langs/java.mjs"),
  javascript: async () => await import("shiki/langs/javascript.mjs"),
  json: async () => await import("shiki/langs/json.mjs"),
  jsonc: async () => await import("shiki/langs/jsonc.mjs"),
  jsx: async () => await import("shiki/langs/jsx.mjs"),
  markdown: async () => await import("shiki/langs/markdown.mjs"),
  nix: async () => await import("shiki/langs/nix.mjs"),
  python: async () => await import("shiki/langs/python.mjs"),
  ruby: async () => await import("shiki/langs/ruby.mjs"),
  rust: async () => await import("shiki/langs/rust.mjs"),
  sql: async () => await import("shiki/langs/sql.mjs"),
  swift: async () => await import("shiki/langs/swift.mjs"),
  toml: async () => await import("shiki/langs/toml.mjs"),
  tsx: async () => await import("shiki/langs/tsx.mjs"),
  typescript: async () => await import("shiki/langs/typescript.mjs"),
  xml: async () => await import("shiki/langs/xml.mjs"),
  yaml: async () => await import("shiki/langs/yaml.mjs"),
} satisfies Readonly<Record<string, () => Promise<GrammarModule>>>;

type Language = keyof typeof GRAMMARS;

const ALIASES = new Map([
  ["sh", "bash"],
  ["shell", "bash"],
  ["shellscript", "bash"],
  ["zsh", "bash"],
  ["console", "bash"],
  ["c++", "cpp"],
  ["docker", "dockerfile"],
  ["golang", "go"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["json5", "jsonc"],
  ["md", "markdown"],
  ["patch", "diff"],
  ["py", "python"],
  ["rb", "ruby"],
  ["rs", "rust"],
  ["ts", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["yml", "yaml"],
  ["svg", "xml"],
]);

const isLanguage = (name: string): name is Language =>
  Object.hasOwn(GRAMMARS, name);

/** The grammar a fence's language names, when Cairn ships one. */
export const languageOf = (fenceLanguage: string): Option.Option<Language> => {
  const name = fenceLanguage.trim().toLowerCase();
  const canonical = ALIASES.get(name) ?? name;

  return isLanguage(canonical) ? Option.some(canonical) : Option.none();
};

/** A grammar or the highlighter core could not be loaded. */
export class HighlightLoadError extends Schema.TaggedError<HighlightLoadError>()(
  "HighlightLoadError",
  { language: Schema.String, cause: Schema.Defect() }
) {}

const LIGHT_THEME = "github-light-default";

const DARK_THEME = "github-dark-default";

/** What the views read of shiki's highlighter: which grammars are loaded, and a synchronous tokenizer. */
export type Highlighter = Pick<
  HighlighterCore,
  "codeToTokens" | "getLoadedLanguages"
>;

/** The highlighter once loaded, and the loads in flight; one page-wide cache, like the grammars. */
const cores = new Map<"core", Promise<HighlighterCore>>();

const ready = new Map<"core", Highlighter>();

/** Makes `highlighter` the one the views tokenize with; tests pass a stub that counts its calls. */
export const setHighlighter = (highlighter: Highlighter): void => {
  ready.set("core", highlighter);
};

const grammarLoads = new Map<Language, Promise<void>>();

const createCore = async (): Promise<HighlighterCore> => {
  const [core, engine, light, dark] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-light-default.mjs"),
    import("shiki/themes/github-dark-default.mjs"),
  ]);

  const highlighter = await core.createHighlighterCore({
    themes: [light.default, dark.default],
    langs: [],
    engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
  });

  ready.set("core", highlighter);

  return highlighter;
};

const loadCore = async (): Promise<HighlighterCore> => {
  const existing = cores.get("core");

  if (existing !== undefined) {
    return await existing;
  }

  const created = createCore();

  cores.set("core", created);

  try {
    return await created;
  } catch (error) {
    cores.delete("core");

    throw error;
  }
};

const loadGrammarOnce = async (language: Language): Promise<void> => {
  const [core, grammar] = await Promise.all([loadCore(), GRAMMARS[language]()]);

  await core.loadLanguage(...grammar.default);
};

const loadGrammar = async (language: Language): Promise<void> => {
  const existing = grammarLoads.get(language);

  if (existing !== undefined) {
    await existing;

    return;
  }

  const load = loadGrammarOnce(language);

  grammarLoads.set(language, load);

  try {
    await load;
  } catch (error) {
    grammarLoads.delete(language);

    throw error;
  }
};

/** How long a grammar (and the core, the first time) may take to load (T14). */
export const GRAMMAR_LOAD_TIMEOUT = Duration.seconds(30);

/**
 * Forgets a load that never settled, so a later block asks again instead of waiting on it forever.
 * The core is forgotten too unless it finished.
 */
const forgetLoad = (language: Language) => {
  grammarLoads.delete(language);

  if (!ready.has("core")) {
    cores.delete("core");
  }
};

/** Loads the core and one grammar; a later call after a failure or a timeout tries again. */
export const loadLanguage = (
  language: string
): Effect.Effect<void, HighlightLoadError> =>
  Option.match(languageOf(language), {
    onNone: () =>
      Effect.fail(
        new HighlightLoadError({
          language,
          cause: "Cairn ships no grammar for it.",
        })
      ),
    onSome: (known) =>
      Effect.tryPromise({
        try: async () => {
          await loadGrammar(known);
        },
        catch: (cause) => new HighlightLoadError({ language, cause }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: GRAMMAR_LOAD_TIMEOUT,
          orElse: () =>
            Effect.sync(() => {
              forgetLoad(known);
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new HighlightLoadError({
                    language,
                    cause: "The grammar did not load within 30 seconds.",
                  })
                )
              )
            ),
        })
      ),
  });

/** One colored piece of a line. */
export interface Token {
  readonly content: string;
  readonly light: Option.Option<string>;
  readonly dark: Option.Option<string>;
}

/** Highlighted lines. */
export type TokenLines = ReadonlyArray<ReadonlyArray<Token>>;

const COLOR = /^#[0-9a-fA-F]{3,8}$/u;

const colorOf = (value: string | undefined): Option.Option<string> =>
  value !== undefined && COLOR.test(value) ? Option.some(value) : Option.none();

/** The most highlighted blocks kept; t3code keeps the same number. */
const TOKEN_CACHE_ENTRIES = 500;

/** The most bytes of tokens kept, by `approximateBytes`; t3code's figure. */
const TOKEN_CACHE_BYTES = 50 * 1024 * 1024;

/** A token's own object, its two Options and its string header, beside the characters. */
const TOKEN_OVERHEAD_BYTES = 96;

interface Cached {
  readonly language: string;
  readonly lines: TokenLines;
  readonly bytes: number;
}

/**
 * Tokens by the code they color, least recently used first: a hit moves its entry to the end.
 * Keyed by the code string itself, which views hold from one render to the next, so a lookup
 * hashes no new string. `bytes` sums the entries' sizes.
 */
const tokenCache = { entries: new Map<string, Cached>(), bytes: 0 };

const approximateBytes = (lines: TokenLines): number => {
  let bytes = 0;

  for (const line of lines) {
    for (const token of line) {
      bytes += TOKEN_OVERHEAD_BYTES + token.content.length * 2;
    }
  }

  return bytes;
};

const recall = (code: string, language: string): Option.Option<TokenLines> => {
  const cached = tokenCache.entries.get(code);

  if (cached?.language !== language) {
    return Option.none();
  }

  tokenCache.entries.delete(code);
  tokenCache.entries.set(code, cached);

  return Option.some(cached.lines);
};

const remember = (code: string, language: string, lines: TokenLines): void => {
  const bytes = approximateBytes(lines);
  const replaced = tokenCache.entries.get(code);

  if (bytes > TOKEN_CACHE_BYTES) {
    return;
  }

  if (replaced !== undefined) {
    tokenCache.entries.delete(code);
    tokenCache.bytes -= replaced.bytes;
  }

  for (const [oldest, cached] of tokenCache.entries) {
    if (
      tokenCache.entries.size < TOKEN_CACHE_ENTRIES &&
      tokenCache.bytes + bytes <= TOKEN_CACHE_BYTES
    ) {
      break;
    }

    tokenCache.entries.delete(oldest);
    tokenCache.bytes -= cached.bytes;
  }

  tokenCache.entries.set(code, { language, lines, bytes });
  tokenCache.bytes += bytes;
};

type GrammarState = NonNullable<
  ReturnType<Highlighter["codeToTokens"]>["grammarState"]
>;

/**
 * The most characters tokenized, and drawn, in one go. In Chromium a slice this size of dense
 * TypeScript takes 3 to 5 ms warm (25 ms when it first meets rules the grammar has not compiled);
 * a 300-line, 15 KB module at once takes 45 ms to tokenize and as long again to draw.
 */
export const SLICE_CHARS = 1000;

/** The pause before each slice: a timer, so the page paints and takes input (a zero sleep only yields to other fibers). */
const SLICE_PAUSE = Duration.millis(1);

/** Tokenized lines and the grammar state after the last of them, to go on from. */
interface Slice {
  readonly lines: TokenLines;
  readonly state: Option.Option<GrammarState>;
}

const tokenizeSlice = (
  highlighter: Highlighter,
  code: string,
  language: string,
  state: Option.Option<GrammarState>
): Option.Option<Slice> =>
  Option.liftThrowable(() => {
    const options = {
      lang: language,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false as const,
    };

    const result = highlighter.codeToTokens(
      code,
      Option.match(state, {
        onNone: () => options,
        onSome: (grammarState) => ({ ...options, grammarState }),
      })
    );

    return {
      state: Option.fromUndefinedOr(result.grammarState),
      lines: result.tokens.map((line) =>
        line.map((token) => ({
          content: token.content,
          light: colorOf(token.htmlStyle?.["--shiki-light"]),
          dark: colorOf(token.htmlStyle?.["--shiki-dark"]),
        }))
      ),
    };
  })();

/** Where the slice of `lines` from `start` ends: at least one line, else at most `SLICE_CHARS`. */
const sliceEnd = (lines: ReadonlyArray<string>, start: number): number => {
  let end = start + 1;
  let chars = (lines[start] ?? "").length;

  while (
    end < lines.length &&
    chars + (lines[end] ?? "").length < SLICE_CHARS
  ) {
    chars += (lines[end] ?? "").length + 1;
    end += 1;
  }

  return end;
};

const loadedHighlighter = (language: string): Option.Option<Highlighter> =>
  Option.filter(Option.fromUndefinedOr(ready.get("core")), (highlighter) =>
    highlighter.getLoadedLanguages().includes(language)
  );

/** Code part way through its slices, and its language. */
interface Progress extends Slice {
  readonly language: string;
}

/** A block whose slices stop when its element unmounts goes on from here when it mounts again. */
const PROGRESS_ENTRIES = 32;

/** Keyed by code, as the cache is. */
const inProgress = new Map<string, Progress>();

const progressOf = (code: string, language: string): Option.Option<Progress> =>
  Option.filter(
    Option.fromUndefinedOr(inProgress.get(code)),
    (progress) => progress.language === language
  );

const keepProgress = (code: string, progress: Progress): void => {
  inProgress.delete(code);
  inProgress.set(code, progress);

  const oldest = inProgress.keys().next();

  if (inProgress.size > PROGRESS_ENTRIES && oldest.done !== true) {
    inProgress.delete(oldest.value);
  }
};

/**
 * Tokenizes the next slice of `code`: some with the lines highlighted so far, the whole code once
 * the last slice puts its tokens in the cache; none when there was nothing to do.
 */
const nextSlice = (code: string, language: string): Option.Option<number> => {
  if (Option.isSome(recall(code, language))) {
    return Option.none();
  }

  return Option.flatMap(loadedHighlighter(language), (highlighter) => {
    const lines = code.split("\n");

    const progress = Option.getOrElse(progressOf(code, language), () => ({
      language,
      lines: [],
      state: Option.none(),
    }));

    const start = progress.lines.length;
    const end = sliceEnd(lines, start);

    return Option.map(
      tokenizeSlice(
        highlighter,
        lines.slice(start, end).join("\n"),
        language,
        progress.state
      ),
      (slice) => {
        const done = [...progress.lines, ...slice.lines];

        if (end < lines.length) {
          keepProgress(code, { language, lines: done, state: slice.state });
        } else {
          inProgress.delete(code);
          remember(code, language, done);
        }

        return end;
      }
    );
  });
};

/**
 * Highlighted lines of `code` from the cache, or its first lines while `sliceTokens` works
 * through it (the rest stays plain). Never tokenizes, so a view drawing many blocks at once stays
 * cheap; the same array comes back until the tokens change.
 */
export const cachedTokensOf = (
  code: string,
  language: string
): Option.Option<TokenLines> =>
  Option.orElse(recall(code, language), () =>
    Option.map(progressOf(code, language), (progress) => progress.lines)
  );

/**
 * Highlighted lines of `code` once `language` has loaded: as `cachedTokensOf`, or tokenized now
 * when the code fits one slice. The transcript and the diff panel share one LRU of results, so call
 * this only for text that has stopped changing: every new text is a tokenization and an entry.
 */
export const readyTokensOf = (
  code: string,
  language: string
): Option.Option<TokenLines> =>
  Option.orElse(cachedTokensOf(code, language), () =>
    code.length > SLICE_CHARS
      ? Option.none()
      : Option.flatMap(nextSlice(code, language), () => recall(code, language))
  );

/**
 * Tokenizes `code` into the cache a slice at a time, pausing before each slice so the page paints
 * and takes input; code of any length highlights without a long task. Emits the lines highlighted
 * so far after each slice, and nothing when the tokens are cached already or `language` has not
 * loaded. Interrupted, it leaves its progress for the next call to go on from.
 */
export const sliceTokens = (
  code: string,
  language: string
): Stream.Stream<number> =>
  Stream.unfold(undefined, () =>
    Effect.gen(function* () {
      yield* Effect.sleep(SLICE_PAUSE);

      // Ends the stream with nothing left to tokenize.
      return Option.getOrUndefined(
        Option.map(
          nextSlice(code, language),
          (lines) => [lines, undefined] as const
        )
      );
    })
  );

/** How far a block's highlighting has gone: its grammar loaded, then each slice of its code. */
export type HighlightStage = "loaded" | "sliced";

/**
 * Loads `language`'s grammar, then, for `code` (the settled text of a block too long to tokenize
 * while rendering), tokenizes it a slice at a time: "loaded" once, then "sliced" after each slice.
 * Fails with `HighlightLoadError` when the grammar does not load.
 */
export const highlightStages = (
  language: string,
  code: Option.Option<string>
): Stream.Stream<HighlightStage, HighlightLoadError> =>
  Stream.fromEffect(Effect.as(loadLanguage(language), "loaded" as const)).pipe(
    Stream.concat(
      Option.match(code, {
        onNone: () => Stream.empty,
        onSome: (text) =>
          Stream.map(sliceTokens(text, language), () => "sliced" as const),
      })
    )
  );
