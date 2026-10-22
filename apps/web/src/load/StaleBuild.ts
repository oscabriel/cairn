// Ported from cairn-v1, apps/web/src/build.ts at 1a5cd4a. Kept: a page left open across a deploy
// (an installed PWA stays alive for days) reloads when the server serves another build, rather
// than importing chunks that are gone; one reload per server build, so a server that keeps
// answering an id the page can never get cannot cause a loop. Changed: the page's build id comes
// from the boot JSON the server inlined (the same id `session.hello` reports), not from a Vite
// define, and a page with no boot JSON (the dev server) never reloads.
import { Effect, Option, Schema } from "effect";

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

const readReloadedFor = Effect.try({
  try: () => Option.fromNullishOr(sessionStorage.getItem(RELOADED_FOR_KEY)),
  catch: () => "sessionStorage unavailable",
}).pipe(Effect.orElseSucceed(() => Option.none<string>()));

const rememberReload = (build: string) =>
  Effect.try({
    try: () => {
      sessionStorage.setItem(RELOADED_FOR_KEY, build);
    },
    catch: () => "sessionStorage unavailable",
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
