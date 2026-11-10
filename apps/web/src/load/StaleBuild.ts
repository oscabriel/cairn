// Ported from cairn-v1, apps/web/src/build.ts at 1a5cd4a. Kept: a page left open across a deploy
// (an installed PWA stays alive for days) reloads when the server serves another build, rather
// than importing chunks that are gone; one reload per server build, so a server that keeps
// answering an id the page can never get cannot cause a loop. Changed: the page's build id comes
// from the boot JSON the server inlined (the same id `session.hello` reports), not from a Vite
// define, and a page with no boot JSON (the dev server) never reloads.
//
// A page learns the server's build from `session.hello`, which needs a socket. After a protocol
// bump the server refuses the old page's dial with a 426 that a browser WebSocket cannot read, so a
// page whose dials keep failing asks `GET /api/build` over plain HTTP (`checkServerBuild`) and
// reloads through the same rule.

import { Duration, Effect, Option, Schema } from "effect";

import { BOOT_ELEMENT_ID } from "../shell/ShellStore.ts";

/** The part of the boot JSON this module reads. */
const BootBuild = Schema.Struct({ build: Schema.String });

const decodeBootBuild = Schema.decodeEffect(
  Schema.fromJsonString(Schema.NullOr(BootBuild))
);

/** The `sessionStorage` key holding the build the page last reloaded for. */
export const RELOADED_FOR_KEY = "cairn:reloaded-for";

/** The build id in the page's boot JSON; none without boot JSON or with an older shape. */
export const readPageBuild: Effect.Effect<Option.Option<string>> = Effect.gen(
  function* () {
    const text = yield* Effect.sync(() =>
      Option.fromNullishOr(
        document.querySelector(`#${BOOT_ELEMENT_ID}`)?.textContent
      )
    );

    if (Option.isNone(text)) {
      return Option.none<string>();
    }

    const boot = yield* decodeBootBuild(text.value);

    return Option.map(Option.fromNullOr(boot), ({ build }) => build);
  }
).pipe(Effect.orElseSucceed(() => Option.none<string>()));

/**
 * Whether the page should reload for the server's build: the page knows its own build, the server
 * serves another, and the page has not already reloaded for that one.
 */
export const shouldReload = (
  pageBuild: Option.Option<string>,
  serverBuild: string,
  reloadedFor: Option.Option<string>
): boolean =>
  Option.exists(pageBuild, (build) => build !== serverBuild) &&
  !Option.contains(reloadedFor, serverBuild);

/** `sessionStorage` threw (storage disabled, a private window's quota). */
class StorageUnavailable extends Schema.TaggedError<StorageUnavailable>()(
  "StorageUnavailable",
  { cause: Schema.Defect() }
) {}

const readReloadedFor = Effect.try({
  try: () => Option.fromNullishOr(sessionStorage.getItem(RELOADED_FOR_KEY)),
  catch: (cause) => new StorageUnavailable({ cause }),
}).pipe(Effect.orElseSucceed(() => Option.none<string>()));

const rememberReload = (build: string) =>
  Effect.try({
    try: () => {
      sessionStorage.setItem(RELOADED_FOR_KEY, build);
    },
    catch: (cause) => new StorageUnavailable({ cause }),
  }).pipe(Effect.ignore);

/**
 * Reloads the page when `session.hello` names another build than the one this page is. Run by the
 * `session.hello` Command on its answer, before the answer reaches `update`.
 */
export const reloadIfStale = Effect.fn("StaleBuild.reloadIfStale")(function* (
  build: string
) {
  const page = yield* readPageBuild;
  const reloadedFor = yield* readReloadedFor;

  if (shouldReload(page, build, reloadedFor)) {
    yield* rememberReload(build);
    yield* Effect.sync(() => {
      location.reload();
    });
  }
});

/** Where the server answers which web build it serves, over plain HTTP (`apps/server/src/http/Build.ts`). */
export const BUILD_PATH = "/api/build";

/** What `GET /api/build` answers. */
const ServerBuild = Schema.Struct({ build: Schema.String });

const decodeServerBuild = Schema.decodeEffect(
  Schema.fromJsonString(ServerBuild)
);

/** How long the build check may take; the page tries again at a later failed dial. */
const BUILD_CHECK_TIMEOUT = Duration.seconds(5);

/** `GET /api/build` did not answer with a build: the server is down, or refused the request. */
class ServerBuildUnknown extends Schema.TaggedError<ServerBuildUnknown>()(
  "ServerBuildUnknown",
  { status: Schema.Int, cause: Schema.Defect() }
) {}

const fetchServerBuild = Effect.tryPromise({
  try: async (signal) => {
    const response = await fetch(BUILD_PATH, { cache: "no-store", signal });

    return { status: response.status, text: await response.text() };
  },
  catch: (cause) => new ServerBuildUnknown({ status: 0, cause }),
});

/**
 * Asks the server over HTTP which build it serves, and reloads when it is another than this page's
 * (`shouldReload`: once per server build, never without boot JSON). Run when the socket's dials keep
 * failing (`checksBuild`); a server that does not answer changes nothing.
 */
export const checkServerBuild = Effect.gen(function* () {
  const answer = yield* fetchServerBuild;

  if (answer.status !== 200) {
    return yield* new ServerBuildUnknown({
      status: answer.status,
      cause: answer.text,
    });
  }

  const { build } = yield* decodeServerBuild(answer.text);

  return yield* reloadIfStale(build);
}).pipe(
  Effect.timeoutOption(BUILD_CHECK_TIMEOUT),
  // The next check, a few failed dials later, asks again.
  Effect.ignore,
  Effect.withSpan("StaleBuild.checkServerBuild")
);
