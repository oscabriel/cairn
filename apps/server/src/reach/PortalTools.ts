// The portal tools (ADR 0038, docs/phase-2/notes/reach.md R5): `portal_open`, `portal_close` and
// `portal_list`, for `ReachExtension.ts` to carry beside the artifact tools. Each runs `Portals`
// through one runtime made from the layer's scope (S43).
//
// `portal_open` is `replay: "safe"`: an open is keyed by the thread and the portal's name, so a
// rerun after a restart finishes or returns the same portal (`Portals.ts`, "Opening is five
// steps"). The name is `<branch>--<project>` for the thread's folder (or `<name>--<project>` when
// the agent names it): the branch git reports for the folder, `main` outside a repository or on a
// detached head, and the repository's folder name (a worktree counts as its main checkout).
// `portal_close` is safe too, being idempotent, and `portal_list` only reads.

import path from "node:path";

import { ThreadId } from "@cairn/protocol/Ids";
import { DEFAULT_PORTAL_TTL_HOURS } from "@cairn/protocol/Reach";
import type { PortalDetails, PortalRow } from "@cairn/protocol/Reach";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type {
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";

import { ThreadMeta } from "../brain/CairnDocs.ts";
import { Git } from "../git/Git.ts";
import type { PorchError } from "./PorchClient.ts";
import { DEFAULT_READY_TIMEOUT, portalName, Portals } from "./Portals.ts";
import type { PortalError } from "./Portals.ts";

/** `portal_open`. */
export const PORTAL_OPEN_TOOL = "portal_open";

/** `portal_close`. */
export const PORTAL_CLOSE_TOOL = "portal_close";

/** `portal_list`. */
export const PORTAL_LIST_TOOL = "portal_list";

/** The longest a server may take to answer before `portal_open` gives up. */
const MAX_READY_SECONDS = 120;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

type ToolContext = Parameters<ToolExecutionApi["agent"]>[0];

const text = (value: string) => [{ type: "text" as const, text: value }];

const refusal = (message: string) => ({ output: text(message), isError: true });

const detailsOf = (row: PortalRow): PortalDetails => ({
  kind: "portal",
  portalId: row.id,
  url: row.url,
  name: row.name,
  state: row.state,
});

/** One line per portal, for the model. */
const lineOf = (row: PortalRow) =>
  `- ${row.name} ${row.state} ${row.url} (port ${Option.match(row.port, { onNone: () => "none", onSome: String })}, \`${row.command}\` in ${row.cwd}, until ${DateTime.formatIso(row.expiresAt)})`;

/** The model-facing words for a failed portal call. */
const failureText = (error: PortalError | PorchError) =>
  Predicate.isTagged(error, "PorchError")
    ? `porch refused the portal: ${error.message}`
    : error.message;

/** The calling thread and its folder; none outside a Cairn thread or without a folder. */
const placeOf = async (api: ToolExecutionApi, context: ToolContext) => {
  const meta = await api.snapshot(ThreadMeta, api.conversationId, context);

  const agent = await api.agent(context);

  return {
    threadId: decodeThreadId(meta?.threadId),
    cwd: Option.filter(Option.fromUndefinedOr(agent.cwd), (cwd) => cwd !== ""),
  };
};

/** The portal tools, for the reach extension. */
export class PortalTools extends Context.Service<
  PortalTools,
  {
    /** `portal_open`, `portal_close` and `portal_list`. */
    readonly tools: ReadonlyArray<ToolRegistration>;
  }
>()("cairn/server/reach/PortalTools") {
  /** Over `Portals` and `Git`. */
  static readonly layerNoDeps = Layer.effect(
    PortalTools,
    Effect.gen(function* () {
      const portals = yield* Portals;
      const git = yield* Git;
      const run = yield* FiberSet.makeRuntimePromise();

      /** The name's two halves for `cwd`: its branch and its repository's folder name. */
      const nameParts = Effect.fn("PortalTools.nameParts")(function* (
        cwd: string
      ) {
        const branch = yield* git
          .run("portal.branch", cwd, ["branch", "--show-current"])
          .pipe(
            Effect.map((result) =>
              result.exitCode === 0 ? result.stdout.trim() : ""
            ),
            Effect.orElseSucceed(() => "")
          );

        const common = yield* git
          .run("portal.project", cwd, [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ])
          .pipe(
            Effect.map((result) =>
              result.exitCode === 0 ? result.stdout.trim() : ""
            ),
            Effect.orElseSucceed(() => "")
          );

        const project =
          common === ""
            ? path.basename(cwd)
            : path.basename(path.dirname(common));

        return { branch: branch === "" ? "main" : branch, project };
      });

      const openTool = defineTool({
        name: PORTAL_OPEN_TOOL,
        description: `Starts a dev server and serves it at a private HTTPS URL on the user's domain (a portal) that the user can open from their phone or laptop. The command must listen on 127.0.0.1 at $PORT (also $HOST); for Vite pass \`--host 127.0.0.1 --port $PORT --strictPort\`. It runs as its own service, so it keeps running after this turn and through brain restarts, until portal_close or ttlHours (default ${String(DEFAULT_PORTAL_TTL_HOURS)}). The URL is ready when this returns. Calling again with the same name reuses that portal. At most six are open at once.`,
        parameters: Type.Object({
          command: Type.String({ minLength: 1, maxLength: 4096 }),
          cwd: Type.Optional(
            Type.String({
              maxLength: 4096,
              description:
                "The folder to run in, relative to the thread's folder; default the thread's folder.",
            })
          ),
          name: Type.Optional(
            Type.String({
              maxLength: 30,
              description:
                "A short label for the URL in place of the branch name, such as 'demo'.",
            })
          ),
          readyPath: Type.Optional(
            Type.String({
              pattern: "^/",
              maxLength: 512,
              description:
                "The path probed until the server answers; default /.",
            })
          ),
          readyTimeoutSec: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_READY_SECONDS })
          ),
          ttlHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 72 })),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const place = await placeOf(api, context);

          if (Option.isNone(place.threadId) || Option.isNone(place.cwd)) {
            return refusal(
              "portal_open works only in a Cairn thread with a folder; this conversation has neither."
            );
          }

          const threadId = place.threadId.value;
          const cwd = path.resolve(place.cwd.value, args.cwd ?? ".");

          return await run(
            Effect.gen(function* () {
              const parts = yield* nameParts(cwd);

              const row = yield* portals.open({
                threadId,
                name: portalName(args.name ?? parts.branch, parts.project),
                command: args.command,
                cwd,
                ttlHours: args.ttlHours ?? DEFAULT_PORTAL_TTL_HOURS,
                readyPath: args.readyPath ?? "/",
                readyTimeout: Option.match(
                  Option.fromUndefinedOr(args.readyTimeoutSec),
                  {
                    onNone: () => DEFAULT_READY_TIMEOUT,
                    onSome: Duration.seconds,
                  }
                ),
              });

              return {
                output: text(
                  `Portal ${row.name} is open at ${row.url}, serving \`${row.command}\` from ${row.cwd} on port ${Option.match(row.port, { onNone: () => "none", onSome: String })}. It stays up until ${DateTime.formatIso(row.expiresAt)} or portal_close.`
                ),
                details: detailsOf(row),
              };
            }).pipe(
              Effect.catchTags({
                PortalError: (error) =>
                  Effect.succeed(refusal(failureText(error))),
                PorchError: (error) =>
                  Effect.succeed(refusal(failureText(error))),
              })
            ),
            { signal: context.abortSignal }
          );
        },
      });

      /** The thread's portal called `name` (its full name, or the label before `--`). */
      const findOwn = (threadId: ThreadId, name: string) =>
        Effect.map(portals.list(Option.some(threadId)), (rows) =>
          Option.fromUndefinedOr(
            rows.find(
              (row) => row.name === name || row.name.split("--")[0] === name
            )
          )
        );

      const closeTool = defineTool({
        name: PORTAL_CLOSE_TOOL,
        description:
          "Stops a portal's dev server and takes its URL down for good. Pass the portal's name as portal_open or portal_list gave it.",
        parameters: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 63 }),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
          const place = await placeOf(api, context);

          if (Option.isNone(place.threadId)) {
            return refusal(
              "portal_close works only in a Cairn thread; this conversation is not one."
            );
          }

          const threadId = place.threadId.value;

          return await run(
            Effect.gen(function* () {
              const found = yield* findOwn(threadId, args.name);

              if (Option.isNone(found)) {
                return refusal(
                  `This thread has no portal named ${args.name}. portal_list shows its portals.`
                );
              }

              const row = yield* portals.close(found.value.id);

              return {
                output: text(
                  `Portal ${row.name} is closed; ${row.url} no longer serves it.`
                ),
                details: detailsOf(row),
              };
            }).pipe(
              Effect.catchTags({
                PortalError: (error) =>
                  Effect.succeed(refusal(failureText(error))),
                PorchError: (error) =>
                  Effect.succeed(refusal(failureText(error))),
              })
            ),
            { signal: context.abortSignal }
          );
        },
      });

      const listTool = defineTool({
        name: PORTAL_LIST_TOOL,
        description:
          "Lists this thread's portals: name, state (opening, open, stopped), URL, port, command and when each expires.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, api, context) => {
          const place = await placeOf(api, context);

          if (Option.isNone(place.threadId)) {
            return refusal(
              "portal_list works only in a Cairn thread; this conversation is not one."
            );
          }

          const threadId = place.threadId.value;

          return await run(
            portals.list(Option.some(threadId)).pipe(
              Effect.map((rows) => ({
                output: text(
                  rows.length === 0
                    ? "This thread has no portals."
                    : rows.map(lineOf).join("\n")
                ),
              })),
              Effect.catchTag("PortalError", (error) =>
                Effect.succeed(refusal(failureText(error)))
              )
            ),
            { signal: context.abortSignal }
          );
        },
      });

      return PortalTools.of({ tools: [openTool, closeTool, listTool] });
    })
  );
}
