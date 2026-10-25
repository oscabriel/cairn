// What a thread may reach through Executor. One grant serves every project and Executor cannot
// restrict arguments, so Cairn scopes each call to the thread's project, read at every call:
//
// - The Executor app's own tools (`executor.*`, which manage Executor itself) are never reachable
//   from a thread: refused in `executor_call`, and left out of discovery results. Its skills (how
//   to use Executor) stay readable.
// - A GitHub call must name the project's repo (`gitHubRefusal`): every `owner` and `repo` field
//   anywhere in the input must match it, and its `path` (or `input.path`) must name one. A project
//   with no GitHub remote gets no GitHub calls.
// - `executor_execute` programs can build any name at run time, so a program that plainly names
//   the Executor app is refused as a hint (`executeRefusal`); Cairn's grant is on a connection
//   without that app (ops/executor/NOTES.md), which is what holds.
//
// There is no per-project setup (the user declined one): every other app on the connection is
// allowed, and the project's repo comes from its checkout's git config (`RepoIdentity`).
//
// The scope is advisory (T22, ADRs 0003 and 0013): it holds only for a model that goes through
// `executor_call`. Thread tools run unconfined as the user, so a thread's `bash` can read the grant
// from `cairn.sqlite` and call Executor at 127.0.0.1:4400 itself. Holding it would take sandboxing
// thread tools, which is not done.
//
// Ported from cairn-v1, apps/server/src/ExecutorTools.ts at 1a5cd4a (`canonicalPath`, `appOfPath`,
// `gitHubRefusal`, `callRefusal`, `filterSearch`, `filterDescribe`, `filterSkills`,
// `discoveryRefusal`, `executeRefusal`). Changed: the per-project `apps` list, the code mode
// setting, the account pin and the Executor-app watch are gone (notes/v1.md B7); the scope is the
// repo alone, an `Option`.
import { Context, Effect, Layer, Option, Predicate } from "effect";
import type { Schema } from "effect";

import { RepoIdentity } from "../projects/RepoIdentity.ts";
import { asJsonObject } from "./ExecutorReply.ts";
import type { JsonObject } from "./ExecutorReply.ts";

/** What a project's threads may reach through Executor. */
export interface ExecutorScopeValue {
  /** `owner/name` of the project's GitHub repo, lowercased; none for no GitHub calls. */
  readonly repo: Option.Option<string>;
}

/** The Executor app's slug: its tools manage Executor itself. */
const EXECUTOR_APP = "executor";

const isExecutorApp = (app: string) => app.toLowerCase() === EXECUTOR_APP;

const EXECUTOR_APP_REFUSAL =
  "The Executor app's own tools manage Executor itself, and Cairn never lets a thread call them.";

const NAMES_EXECUTOR_APP =
  /\btools\s*(?:\??\.\s*executor\b|\[\s*(?<quote>["'`])executor\k<quote>\s*\])/u;

/** Why an `executor_execute` program is refused before it is sent, or none. A hint only. */
export const executeRefusal = (code: string): Option.Option<string> =>
  NAMES_EXECUTOR_APP.test(code)
    ? Option.some(
        `${EXECUTOR_APP_REFUSAL} The program names them, so it was not sent to Executor.`
      )
    : Option.none();

const MEMBER =
  /^(?:\.(?<identifier>[A-Za-z_$][\w$]*)|\[(?<quoted>"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\])/u;

const decodeQuoted = (quoted: string): string => {
  const parsed: unknown = JSON.parse(quoted);

  return Predicate.isString(parsed) ? parsed : "";
};

/**
 * The canonical dotted path of a name, as Executor resolves one: `tools["my-app"].issues` is
 * `my-app.issues`, `tools.github.x` is `github.x`; any other name is already canonical.
 */
export const canonicalPath = (name: string): string => {
  const trimmed = name.trim();

  if (
    trimmed !== "tools" &&
    !trimmed.startsWith("tools.") &&
    !trimmed.startsWith("tools[")
  ) {
    return trimmed;
  }

  const segments: Array<string> = [];

  for (let rest = trimmed.slice("tools".length); rest !== "";) {
    const member = MEMBER.exec(rest);

    if (member === null) {
      return trimmed;
    }

    const [matched] = member;
    const identifier = member.groups?.identifier;
    const quoted = member.groups?.quoted;

    segments.push(
      identifier ?? (quoted === undefined ? "" : decodeQuoted(quoted))
    );
    rest = rest.slice(matched.length);
  }

  return segments.join(".");
};

/** The app slug a path or namespace starts with. */
export const appOfPath = (path: string): string =>
  canonicalPath(path).split(".")[0] ?? "";

type Json = Schema.MutableJson;

const asRecord = (value: Json | undefined): Option.Option<JsonObject> =>
  asJsonObject(value);

/** Every value under a key named `owner` or `repo`, anywhere in `value`. */
const repoFields = (
  value: Json | undefined,
  out: Array<{ key: "owner" | "repo"; value: Json }> = [],
  depth = 0
) => {
  if (depth > 32) {
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      repoFields(item, out, depth + 1);
    }

    return out;
  }

  const record = asRecord(value);

  if (Option.isNone(record)) {
    return out;
  }

  for (const [key, item] of Object.entries(record.value)) {
    if (key === "owner" || key === "repo") {
      out.push({ key, value: item });
    }

    repoFields(item, out, depth + 1);
  }

  return out;
};

const NO_REPO_IN_PATH =
  "this tool names no repo in its path, so it could reach any repo the account can";

/**
 * Why Cairn refuses a GitHub call for this project, or none. The same GitHub account backs every
 * project, so a call must name the project's repo, in its `path` (or `input.path` for an
 * account-bound tool) and in every `owner` and `repo` field anywhere in the input. A tool with no
 * repo in its path (search, the user's own repos, GraphQL) is refused: its reach is not one repo.
 */
export const gitHubRefusal = (
  scope: ExecutorScopeValue,
  input: JsonObject
): Option.Option<string> => {
  if (Option.isNone(scope.repo)) {
    return Option.some(
      "This project has no GitHub repo (its checkout has no GitHub remote), so Cairn sends it no GitHub calls."
    );
  }

  const repoName = scope.repo.value;
  const [owner = "", repo = ""] = repoName.split("/");
  const outside = `Cairn lets this project's threads call GitHub only on its own repo, ${repoName}`;
  const top = asRecord(input);

  if (Option.isNone(top)) {
    return Option.some(
      `${outside}, named in the input's path (owner and repo).`
    );
  }

  const paths = [
    asRecord(top.value.path),
    Option.flatMap(asRecord(top.value.input), (inner) => asRecord(inner.path)),
  ].flatMap((path) => (Option.isSome(path) ? [path.value] : []));

  if (
    paths.length === 0 ||
    paths.some(
      (path) =>
        !Predicate.isString(path.owner) || !Predicate.isString(path.repo)
    )
  ) {
    return Option.some(`${outside}: ${NO_REPO_IN_PATH}.`);
  }

  for (const field of repoFields(top.value)) {
    // A nested object under `owner` or `repo` is checked by its own fields.
    if (Option.isSome(asRecord(field.value))) {
      continue;
    }

    if (!Predicate.isString(field.value)) {
      return Option.some(`${outside}; the input's ${field.key} is not a name.`);
    }

    const want = field.key === "owner" ? owner : repo;

    if (field.value.toLowerCase() !== want) {
      return Option.some(
        `${outside}; the input names ${field.key} ${field.value}.`
      );
    }
  }

  return Option.none();
};

/** Why Cairn refuses an `executor_call` before it reaches Executor, or none. */
export const callRefusal = (
  scope: ExecutorScopeValue,
  path: string,
  input: JsonObject
): Option.Option<string> => {
  const app = appOfPath(path);

  if (app === "") {
    return Option.some(
      `${path} is not a tool path. Use an exact path from executor_search, such as tools.github.issues.list. Nothing was sent to Executor.`
    );
  }

  if (isExecutorApp(app)) {
    return Option.some(`${EXECUTOR_APP_REFUSAL} Nothing was sent to Executor.`);
  }

  if (app.toLowerCase() === "github") {
    return Option.map(
      gitHubRefusal(scope, input),
      (why) => `${why} Nothing was sent to Executor.`
    );
  }

  return Option.none();
};

/** A discovery result with what the scope hides removed, and how many items went. */
export interface Filtered {
  readonly value: JsonObject;
  readonly hidden: number;
}

const keepItems = (
  items: JsonField | undefined,
  allowed: (item: JsonObject) => boolean
) => {
  if (!Array.isArray(items)) {
    return { kept: items, hidden: 0 };
  }

  const kept = items.filter((item) =>
    Option.match(asRecord(item), {
      onNone: () => false,
      onSome: allowed,
    })
  );

  return { kept, hidden: items.length - kept.length };
};

type JsonField = JsonObject[string];

/** An item whose `path` is outside the Executor app. */
const pathAllowed = (item: JsonObject) =>
  Predicate.isString(item.path) && !isExecutorApp(appOfPath(item.path));

/** An app as Executor names one in a result: a slug, or `{ id, name, slug }`. */
const slugOf = (app: Json | undefined): Option.Option<string> => {
  if (Predicate.isString(app)) {
    return Option.some(app);
  }

  return Option.filter(
    Option.flatMap(asRecord(app), (record) =>
      Predicate.isString(record.slug) ? Option.some(record.slug) : Option.none()
    ),
    Predicate.isString
  );
};

const appAllowed = (item: JsonObject) =>
  Option.match(slugOf(item.app), {
    onNone: () => false,
    onSome: (app) => !isExecutorApp(app),
  });

const withKept = (
  value: JsonObject,
  key: string,
  kept: JsonField | undefined
): JsonObject =>
  value[key] === undefined || kept === undefined
    ? value
    : { ...value, [key]: kept };

/** `search`'s result without the Executor app's tools and namespaces. */
export const filterSearch = (value: JsonObject): Filtered => {
  const items = keepItems(value.items, pathAllowed);
  const namespaces = keepItems(value.namespaces, pathAllowed);
  const unavailable = keepItems(value.unavailableApps, appAllowed);

  return {
    value: withKept(
      withKept(
        withKept(value, "items", items.kept),
        "namespaces",
        namespaces.kept
      ),
      "unavailableApps",
      unavailable.kept
    ),
    hidden: items.hidden,
  };
};

/** `describe`'s result without the Executor app's tools, and the near matches of a missing path. */
export const filterDescribe = (value: JsonObject): Filtered => {
  const items = keepItems(value.items, pathAllowed);
  const namespaces = keepItems(value.namespaces, pathAllowed);
  const { missing } = value;

  const filteredMissing = Array.isArray(missing)
    ? missing.map((entry) =>
        Option.match(asJsonObject(entry), {
          onNone: () => entry,
          onSome: (record): Schema.MutableJson => {
            const { matches } = record;

            return Array.isArray(matches)
              ? {
                  ...record,
                  matches: matches.filter(
                    (match) =>
                      Predicate.isString(match) &&
                      !isExecutorApp(appOfPath(match))
                  ),
                }
              : entry;
          },
        })
      )
    : missing;

  return {
    value: withKept(
      withKept(
        withKept(value, "items", items.kept),
        "namespaces",
        namespaces.kept
      ),
      "missing",
      filteredMissing
    ),
    hidden: items.hidden,
  };
};

/** `skills`' result: every skill stays readable, the Executor app's own included. */
export const filterSkills = (value: JsonObject): Filtered => ({
  value,
  hidden: 0,
});

/** Why a discovery request is refused before it is sent: it names the Executor app's tools. */
export const discoveryRefusal = (
  name: "skills" | "search" | "describe",
  args: JsonObject
): Option.Option<string> => {
  const refusal =
    "The Executor app's tools are not for threads; its skills (how to use Executor) are readable with executor_skills. Nothing was sent to Executor.";

  if (
    name === "search" &&
    Predicate.isString(args.namespace) &&
    isExecutorApp(appOfPath(args.namespace))
  ) {
    return Option.some(refusal);
  }

  if (name === "describe" && Array.isArray(args.paths)) {
    const outside = args.paths.filter(
      (path) => !Predicate.isString(path) || isExecutorApp(appOfPath(path))
    );

    if (outside.length > 0) {
      return Option.some(`${outside.map(String).join(", ")}: ${refusal}`);
    }
  }

  return Option.none();
};

/** The scope of a thread from the directory its tools run in. */
export class ExecutorScope extends Context.Service<
  ExecutorScope,
  {
    /** The scope for a thread whose tools run in `cwd`; none (no cwd) has no repo. Never fails. */
    forCwd(cwd: Option.Option<string>): Effect.Effect<ExecutorScopeValue>;
  }
>()("cairn/server/executor/ExecutorScope") {
  /** Reads the checkout's repo through `RepoIdentity`. */
  static readonly layerNoDeps = Layer.effect(
    ExecutorScope,
    Effect.gen(function* () {
      const identity = yield* RepoIdentity;

      const forCwd = Effect.fn("ExecutorScope.forCwd")(function* (
        cwd: Option.Option<string>
      ) {
        if (Option.isNone(cwd)) {
          return { repo: Option.none<string>() };
        }

        const info = yield* identity.read(cwd.value);

        return { repo: info.identity };
      });

      return ExecutorScope.of({ forCwd });
    })
  );

  /** Reads through Node's file system. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(RepoIdentity.layer)
  );
}
