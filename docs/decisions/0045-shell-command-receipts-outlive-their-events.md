---
status: accepted
gate: `pnpm check` green, with `EventSink.test.ts` ("answers a command resent after 5,000 newer events with its first answer", "forgets a receipt once it is older than the retention", "forgets an old receipt behind receipts stamped by a clock that ran ahead") and `Outbox.test.ts` ("drops a shell command past its resend window unsent, and sends one inside it") passing; the user accepts the contract
---

# Shell command receipts outlive their events

The brain answers a resent shell command from its receipt, the first answer that command got, so a command the client never saw answered runs once however often it is sent. t3code, where the receipt store is ported from (`CommandReceiptStore.ts` at `fe27e8e3`), prunes receipts with the events they cover. Cairn kept that at first: the event log keeps its newest 5,000 events, and the receipts went with the rest. A client that resent a command after 5,000 newer events then found no receipt, and the brain planned the command again against rows that had moved on (a resent archive stopped a run a second time).

## Decisions

1. **Receipts are pruned by age, not with their events.** `EventStore.prune` deletes a receipt once it is older than `COMMAND_RECEIPT_RETENTION`, whatever happened to the events. The receipts table holds about four weeks of commands, one row each.
2. **The client and the brain share a resend window.** `SHELL_COMMAND_RESEND_WINDOW` (7 days, `@cairn/protocol/ShellCommands`) is how long a client may resend a shell command, counted from its command id's mint time. The web outbox drops an older one with a notice instead of sending it. The brain keeps receipts four times as long (28 days), so every resend a client makes finds its first answer, with room for a client clock that is off.
3. **A prune deletes at most 100 expired receipts, oldest first by age.** Each commit writes one receipt, so the table still shrinks. The batch is found through an index on `accepted_at` (migration `0014_CommandReceiptAge`), so a prune reads only the rows it deletes, and receipts stamped in the future by a clock that ran ahead never hold back older ones.

Changing either number, or making the window something other than a client-side drop, changes the contract between every client and the brain, so both sides move together.

Round 1 of the state machine fixes (I03, 2026-11) made the change; this records it.
