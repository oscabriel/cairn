// Ported from github.com/pingdotgg/t3code, apps/server/src/orchestration-v2/CommandReceiptStore.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: one receipt per command id holding the sequence
// it committed at or the rejection it got, so a resent command returns the first answer instead of
// running twice. Changed: one receipt kind, the rejection stored as its encoded error, and receipts
// pruned with the events they cover.
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

import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { AggregateKind, ShellCommandRejection } from "./ShellCommands.ts";
import { shellStoreFailure } from "./ShellStoreError.ts";
import type { ShellStoreError } from "./ShellStoreError.ts";

/** What happened to a command the first time it was sent. */
export interface CommandReceipt {
  readonly commandId: string;
  readonly commandType: string;
  readonly aggregateKind: typeof AggregateKind.Type;
  readonly aggregateId: string;
  readonly acceptedAt: DateTime.Utc;
  /** The sequence of the command's last event; for a rejection, the log's head when refused. */
  readonly resultSequence: number;
  /** None when the command committed; the rejection otherwise. */
  readonly rejection: Option.Option<ShellCommandRejection>;
}

const StoredReceipt = Schema.Struct({
  command_id: Schema.String,
  command_type: Schema.String,
  aggregate_kind: AggregateKind,
  aggregate_id: Schema.String,
  accepted_at: Schema.DateTimeUtcFromMillis,
  result_sequence: Schema.Int,
  error_json: Schema.OptionFromNullOr(
    Schema.fromJsonString(Schema.toCodecJson(ShellCommandRejection))
  ),
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredReceipt));

const encodeRejection = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(ShellCommandRejection))
);

/** Receipts for shell commands, keyed by command id. */
export class CommandReceipts extends Context.Service<
  CommandReceipts,
  {
    /** The receipt for `commandId`, if the command was seen before. */
    find(
      commandId: string
    ): Effect.Effect<Option.Option<CommandReceipt>, ShellStoreError>;
    /** Records a receipt. Call only inside the event sink's transaction. */
    write(receipt: CommandReceipt): Effect.Effect<void, ShellStoreError>;
  }
>()("cairn/server/shell/CommandReceipts") {
  /** Reads and writes `command_receipts` through the ambient `SqlClient`. */
  static readonly layerNoDeps = Layer.effect(
    CommandReceipts,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const find = Effect.fn("CommandReceipts.find")(function* (
        commandId: string
      ) {
        const rows = yield* sql`
            SELECT command_id, command_type, aggregate_kind, aggregate_id, accepted_at,
              result_sequence, error_json
            FROM command_receipts WHERE command_id = ${commandId}
          `.pipe(Effect.flatMap(decodeRows));

        return Option.map(
          Option.fromNullishOr(rows[0]),
          (row): CommandReceipt => ({
            commandId: row.command_id,
            commandType: row.command_type,
            aggregateKind: row.aggregate_kind,
            aggregateId: row.aggregate_id,
            acceptedAt: row.accepted_at,
            resultSequence: row.result_sequence,
            rejection: row.error_json,
          })
        );
      }, shellStoreFailure("CommandReceipts.find"));

      const write = Effect.fn("CommandReceipts.write")(function* (
        receipt: CommandReceipt
      ) {
        const errorJson = Option.isSome(receipt.rejection)
          ? yield* encodeRejection(receipt.rejection.value)
          : null;

        yield* sql`
            INSERT INTO command_receipts (
              command_id, command_type, aggregate_kind, aggregate_id, accepted_at,
              result_sequence, status, error_json
            )
            VALUES (
              ${receipt.commandId},
              ${receipt.commandType},
              ${receipt.aggregateKind},
              ${receipt.aggregateId},
              ${DateTime.toEpochMillis(receipt.acceptedAt)},
              ${receipt.resultSequence},
              ${Option.isSome(receipt.rejection) ? "rejected" : "accepted"},
              ${errorJson}
            )
          `;
      }, shellStoreFailure("CommandReceipts.write"));

      return CommandReceipts.of({ find, write });
    })
  );
}
