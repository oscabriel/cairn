// The `cairn.reach` extension (ADR 0038, docs/phase-2/notes/reach.md R3 to R5): the tools an agent
// uses to put its work in front of the user. This is its artifact half: `artifact_publish`,
// `artifact_list` and `artifact_revoke`, over `Artifacts`. The portal tools (3F) join the same
// extension, so the installed set gains one name for both.
//
// Each tool reads its thread from `cairn.thread-meta` and its folder from the conversation's
// `pi.agent` cwd, and answers the model in words while the transcript gets `ArtifactDetails`. All
// three are `replay: "safe"`: publishing is idempotent per thread and name, listing reads, and
// revoking repeats harmlessly. A refusal or a porch that is not set up is a tool error the model
// reads, never a thrown one. Effects run through one runtime made from the layer's scope (S43).

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { ArtifactDetails, ArtifactId } from "@cairn/protocol/Reach";
import type { ArtifactRow } from "@cairn/protocol/Reach";
import type { JsonValue } from "@earendil-works/chord";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type {
  ToolExecutionApi,
  ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Context, Effect, FiberSet, Layer, Option, Schema } from "effect";

import { ThreadMeta } from "../brain/CairnDocs.ts";
import type { CairnExtension } from "../brain/Extensions.ts";
import { artifactIdOf } from "./ArtifactPublisher.ts";
import { Artifacts, outcomeOf } from "./Artifacts.ts";

/** The extension's name in pi-durable's registry. */
export const REACH_EXTENSION = "cairn.reach";

/** The tool that publishes a file or folder from the thread's folder. */
export const ARTIFACT_PUBLISH_TOOL = "artifact_publish";

/** The tool that lists the thread's artifacts. */
export const ARTIFACT_LIST_TOOL = "artifact_list";

/** The tool that stops serving one of the thread's artifacts. */
export const ARTIFACT_REVOKE_TOOL = "artifact_revoke";

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const decodeProjectId = Schema.decodeUnknownOption(ProjectId);

const encodeDetails = Schema.encodeSync(ArtifactDetails);

const decodeArtifactId = Schema.decodeEffect(ArtifactId);

/** The thread a tool call belongs to, as its documents say. */
interface Caller {
  readonly threadId: ThreadId;
  readonly projectId: Option.Option<ProjectId>;
  readonly cwd: string;
}

/** A failed call as the model reads it. */
const toolError = (text: string): ToolExecutionResult => ({
  output: [{ type: "text", text }],
  isError: true,
});

const said = (text: string, details?: JsonValue): ToolExecutionResult =>
  details === undefined
    ? { output: [{ type: "text", text }] }
    : { output: [{ type: "text", text }], details };

/** Reads the calling thread; none when the conversation is not a Cairn thread. */
const callerOf = async (
  api: ToolExecutionApi,
  context: ChordContext
): Promise<Option.Option<Caller>> => {
  const meta = await api.snapshot(ThreadMeta, api.conversationId, context);
  const agent = await api.agent(context);

  return Option.map(decodeThreadId(meta?.threadId), (threadId) => ({
    threadId,
    projectId: decodeProjectId(meta?.projectId),
    cwd: agent.cwd ?? "",
  }));
};

const NOT_A_THREAD =
  "This conversation is not a Cairn thread, so it has no artifacts.";

/** One artifact as a line the model reads. */
const lineOf = (row: ArtifactRow) =>
  `${row.projectSlug}/${row.name} (${row.kind}, ${String(row.bytes)} bytes): ${row.url}${Option.isSome(row.revokedAt) ? " [revoked]" : ""}`;

/** A failure the model reads as its message. */
const answerWith = (failure: { readonly message: string }) =>
  Effect.succeed(toolError(failure.message));

/** The `cairn.reach` extension, over `Artifacts`. */
export class ReachTools extends Context.Service<
  ReachTools,
  {
    /** The extension, for the installed set. */
    readonly extension: CairnExtension;
  }
>()("cairn/server/reach/ReachExtension/ReachTools") {
  /** Over `Artifacts`. Installs at `order`; production passes `ExtensionOrder.reach`. */
  static readonly layerAt = (order: number) =>
    Layer.effect(
      ReachTools,
      Effect.gen(function* () {
        const artifacts = yield* Artifacts;
        const run = yield* FiberSet.makeRuntimePromise();

        const publish = defineTool({
          name: ARTIFACT_PUBLISH_TOOL,
          description:
            "Publishes an HTML file, or a folder with an index.html, from this thread's folder to a private URL only the user can open (https://plans.<domain>/<project>/<name>). Publishing the same name again from this thread updates the page in place. Folders holding .env files, .git or node_modules are refused. Answers the URL; give it to the user.",
          parameters: Type.Object({
            path: Type.String({
              minLength: 1,
              maxLength: 4096,
              description:
                "The file or folder, relative to the thread's folder or absolute inside it.",
            }),
            name: Type.Optional(
              Type.String({
                minLength: 1,
                maxLength: 128,
                description:
                  "The page's name in the URL; the file or folder name by default.",
              })
            ),
            project: Type.Optional(
              Type.String({
                minLength: 1,
                maxLength: 64,
                description:
                  "The project folder it is published under; the thread's project by default.",
              })
            ),
          }),
          replay: "safe",
          execute: async (args, api, context) => {
            const caller = await callerOf(api, context);

            if (Option.isNone(caller)) {
              return toolError(NOT_A_THREAD);
            }

            const answer = artifacts
              .publish({
                threadId: caller.value.threadId,
                projectId: caller.value.projectId,
                cwd: caller.value.cwd,
                path: args.path,
                name: Option.fromUndefinedOr(args.name),
                project: Option.fromUndefinedOr(args.project),
              })
              .pipe(
                Effect.map((published) => {
                  const { row } = published;
                  const outcome = outcomeOf(published);

                  const details = encodeDetails({
                    kind: "artifact",
                    artifactId: row.id,
                    url: row.url,
                    name: row.name,
                    changed: published.changed,
                    bytes: row.bytes,
                  });

                  const text =
                    outcome === "unchanged"
                      ? `${row.name} is already published with these bytes at ${row.url}`
                      : `${outcome === "published" ? "Published" : "Updated"} ${row.name} at ${row.url}`;

                  return said(text, details);
                }),
                Effect.catchTags({
                  ArtifactRefused: answerWith,
                  ArtifactPublishError: answerWith,
                  PorchError: answerWith,
                  ArtifactsError: answerWith,
                })
              );

            return await run(answer, { signal: context.abortSignal });
          },
        });

        const list = defineTool({
          name: ARTIFACT_LIST_TOOL,
          description:
            "Lists the artifacts this thread published, newest first, with their URLs; revoked ones are marked.",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async (_args, api, context) => {
            const caller = await callerOf(api, context);

            if (Option.isNone(caller)) {
              return toolError(NOT_A_THREAD);
            }

            const answer = artifacts
              .list(Option.some(caller.value.threadId))
              .pipe(
                Effect.map((rows) =>
                  said(
                    rows.length === 0
                      ? "This thread has published no artifacts."
                      : rows.map(lineOf).join("\n")
                  )
                ),
                Effect.catchTags({ ArtifactsError: answerWith })
              );

            return await run(answer, { signal: context.abortSignal });
          },
        });

        const revoke = defineTool({
          name: ARTIFACT_REVOKE_TOOL,
          description:
            "Stops serving an artifact this thread published. Its name stays this thread's; publishing it again serves it again.",
          parameters: Type.Object({
            project: Type.String({
              minLength: 1,
              maxLength: 64,
              description: "The project folder, as artifact_list shows it.",
            }),
            name: Type.String({
              minLength: 1,
              maxLength: 128,
              description: "The page's name, as artifact_list shows it.",
            }),
          }),
          replay: "safe",
          execute: async (args, api, context) => {
            const caller = await callerOf(api, context);

            if (Option.isNone(caller)) {
              return toolError(NOT_A_THREAD);
            }

            const id = artifactIdOf(args.project, args.name);

            const answer = decodeArtifactId(id).pipe(
              Effect.flatMap((artifactId) =>
                artifacts.revoke(artifactId, Option.some(caller.value.threadId))
              ),
              Effect.map((row) =>
                said(
                  `Revoked ${row.projectSlug}/${row.name}; ${row.url} no longer serves it.`
                )
              ),
              Effect.catchTags({
                SchemaError: () =>
                  Effect.succeed(
                    toolError(
                      `${args.project}/${args.name} is not an artifact name.`
                    )
                  ),
                ArtifactNotFound: answerWith,
                ArtifactsError: answerWith,
                PorchError: answerWith,
              })
            );

            return await run(answer, { signal: context.abortSignal });
          },
        });

        return ReachTools.of({
          extension: {
            order,
            extension: defineExtension({
              name: REACH_EXTENSION,
              tools: [publish, list, revoke],
            }),
          },
        });
      })
    );
}
