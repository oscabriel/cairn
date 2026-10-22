// Ported from cairn-v1 at 1a5cd4a, apps/web/src/markdown/highlight.ts. Kept: shiki's JavaScript
// regex engine (no WASM); nothing loads until a code block mounts, then the core and both GitHub
// themes come with the first grammar and each grammar is its own lazily imported chunk; the view
// reads tokens synchronously and only for a language the Model lists as loaded, so a block shows
// plain text first and the same text, colored, after, without a layout shift; colors are checked
// to be plain hex; a failed load is forgotten so a later block tries again. Changed: async
// functions and a typed failure instead of promise chains, and a smaller grammar list.
import { Effect, Option, Schema } from "effect";
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

/** The highlighter once loaded, and the loads in flight; one page-wide cache, like the grammars. */
const cores = new Map<"core", Promise<HighlighterCore>>();

const ready = new Map<"core", HighlighterCore>();

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

/** Loads the core and one grammar; a later call after a failure tries again. */
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
      }),
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

const TOKEN_CACHE_LIMIT = 200;

const tokenCache = new Map<string, TokenLines>();

const tokenize = (
  core: HighlighterCore,
  code: string,
  language: string
): Option.Option<TokenLines> =>
  Option.liftThrowable(() =>
    core
      .codeToTokens(code, {
        lang: language,
        themes: { light: LIGHT_THEME, dark: DARK_THEME },
        defaultColor: false,
      })
      .tokens.map((line) =>
        line.map((token) => ({
          content: token.content,
          light: colorOf(token.htmlStyle?.["--shiki-light"]),
          dark: colorOf(token.htmlStyle?.["--shiki-dark"]),
        }))
      )
  )();

const remember = (key: string, lines: TokenLines): void => {
  tokenCache.set(key, lines);

  const oldest = tokenCache.keys().next();

  if (tokenCache.size > TOKEN_CACHE_LIMIT && oldest.done !== true) {
    tokenCache.delete(oldest.value);
  }
};

/** Highlighted lines of `code`, once `language` has loaded. */
export const tokensOf = (
  code: string,
  language: string
): Option.Option<TokenLines> => {
  const highlighter = ready.get("core");

  if (
    highlighter === undefined ||
    !highlighter.getLoadedLanguages().includes(language)
  ) {
    return Option.none();
  }

  const key = `${language}\u0000${code}`;
  const cached = tokenCache.get(key);

  if (cached !== undefined) {
    return Option.some(cached);
  }

  const tokens = tokenize(highlighter, code, language);

  if (Option.isSome(tokens)) {
    remember(key, tokens.value);
  }

  return tokens;
};
