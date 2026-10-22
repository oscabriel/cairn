// Turns one turn of user input into what the model sees (pi-ai content) and how the transcript
// records it (a `cairn.user` entry). It runs an ordered list of stages over a draft; the order
// lives in `TurnContentStages.ts`, so later work adds a stage (skill expansion, attachments)
// without editing this module. A failing stage fails the whole turn, and nothing is submitted.
import type { AttachmentRef } from "@cairn/protocol/Attachments";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { TurnInput } from "@cairn/protocol/Thread";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Context, Effect, Layer, Option, Schema } from "effect";

import type { InputEntry } from "../brain/HarnessSeam.ts";

/** The entry kind a user turn is recorded as. */
export const CAIRN_USER_ENTRY = "cairn.user";

/** A turn being built: the input as sent, and the content and attachments the stages produced. */
export interface TurnDraft {
  readonly threadId: ThreadId;
  /** Who sent the turn: the viewer's login. */
  readonly from: string;
  readonly input: TurnInput;
  /** What the model sees, in order. */
  readonly content: ReadonlyArray<TextContent | ImageContent>;
  /** The attachments the entry records. */
  readonly attachments: ReadonlyArray<AttachmentRef>;
}

/** A built turn, ready for the harness. */
export interface BuiltTurn {
  readonly content: ReadonlyArray<TextContent | ImageContent>;
  readonly entry: Option.Option<InputEntry>;
}

/** A stage refused the turn. The message says what to change before sending again. */
export class TurnContentError extends Schema.TaggedError<TurnContentError>()(
  "TurnContentError",
  {
    message: Schema.String,
    /** The stage that refused. */
    stage: Schema.String,
    reason: Schema.Literals([
      /** The turn has nothing for the model to read. */
      "empty",
      /** A value in the input cannot be used (a skill or an attachment that does not exist). */
      "invalid_input",
      /** An attachment is not ready or was refused. */
      "attachment",
      /** A dependency the stage reads is down; nothing ran. */
      "unavailable",
    ]),
    /** The input field at fault, when there is one. */
    field: Schema.OptionFromNullOr(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** One step of building a turn. */
export interface TurnContentStage<R> {
  /** For logs and for the error a failure carries. */
  readonly name: string;
  run(draft: TurnDraft): Effect.Effect<TurnDraft, TurnContentError, R>;
}

/** The input's text as the first content block, when there is any. */
export const textStage: TurnContentStage<never> = {
  name: "text",
  run: (draft) =>
    Effect.succeed(
      draft.input.text.trim() === ""
        ? draft
        : {
            ...draft,
            content: [
              ...draft.content,
              { type: "text", text: draft.input.text },
            ],
          }
    ),
};

/** Builds the model content and the transcript entry of a user turn. */
export class TurnContent extends Context.Service<
  TurnContent,
  {
    /**
     * Runs every stage in order over `input`. Fails with `TurnContentError` when a stage refuses
     * the turn, or when no stage produced any content (`empty`).
     */
    build(
      threadId: ThreadId,
      from: string,
      input: TurnInput
    ): Effect.Effect<BuiltTurn, TurnContentError>;
  }
>()("cairn/server/threads/TurnContent") {
  /** Runs `stages` in the given order; their requirements are the layer's. */
  static readonly layerFrom = <R>(stages: ReadonlyArray<TurnContentStage<R>>) =>
    Layer.effect(
      TurnContent,
      Effect.gen(function* () {
        const context = yield* Effect.context<R>();

        const build = Effect.fn("TurnContent.build")(function* (
          threadId: ThreadId,
          from: string,
          input: TurnInput
        ) {
          let draft: TurnDraft = {
            threadId,
            from,
            input,
            content: [],
            attachments: [],
          };

          for (const stage of stages) {
            draft = yield* stage.run(draft).pipe(
              Effect.provideContext(context),
              Effect.withSpan("TurnContent.stage", {
                attributes: { stage: stage.name },
              })
            );
          }

          if (draft.content.length === 0) {
            return yield* new TurnContentError({
              message:
                "The turn has no text and no attachments, so there is nothing to send. Type a message or attach a file.",
              stage: "build",
              reason: "empty",
              field: Option.some("text"),
            });
          }

          return {
            content: draft.content,
            entry: Option.some({
              kind: CAIRN_USER_ENTRY,
              data: {
                from: draft.from,
                attachments: draft.attachments.map((ref) => ({ ...ref })),
              },
            }),
          };
        });

        return TurnContent.of({ build });
      })
    );
}
