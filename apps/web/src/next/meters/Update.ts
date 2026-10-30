// The meters' update (plan wave 6, 6G). The brain is asked for each section when the usage page or
// the settings page opens on a client, and again on a new epoch; answers from another epoch are
// dropped. On the usage page, new spend on the thread rows asks for the roll-up again. A role is
// rebound by saving the whole table through `settings.update`, one change at a time, and the editor
// shows what the brain answered rather than what was asked, then checks every role again.

import {
  modelText,
  rebindModel,
  rebindThinking,
  thinkingChoicesOf,
} from "@cairn/client-logic/Meters";
import { ThinkingLevel } from "@cairn/protocol/Models";
import type { ModelRef } from "@cairn/protocol/Models";
import type { RoleName, RoleTable } from "@cairn/protocol/Roles";
import type { ShellSnapshot } from "@cairn/protocol/Shell";
import { Array, Equal, Match, Option, Order, Schema } from "effect";
import type { Update } from "foldkit";
import * as AsyncData from "foldkit/asyncData";
import { modifyFields } from "foldkit/struct";

import {
  CheckRoles,
  FetchMetersCatalog,
  FetchMetersSettings,
  FetchSpend,
  SaveRoleTable,
} from "./Command.ts";
import type { Services } from "./Command.ts";
import { Message } from "./Message.ts";
import type {
  MeteredThread,
  MetersContext,
  MetersPage,
  Model,
} from "./Model.ts";

type UpdateReturn = Update.Return<Model, Message, Services>;

/** What the root holds that the meters read. */
export interface MetersInputs {
  readonly epoch: number;
  readonly hasClient: boolean;
  readonly page: MetersPage;
  readonly usage: MetersContext["usage"];
  readonly shell: Option.Option<ShellSnapshot>;
}

const byListPriceThenTokens = Order.combine(
  Order.mapInput(
    Order.flip(Order.Number),
    (thread: MeteredThread) => thread.spend.listMicros
  ),
  Order.mapInput(
    Order.flip(Order.Number),
    (thread: MeteredThread) => thread.spend.totalTokens
  )
);

/** The rows with spend recorded, the most spent first; none while no meters page is open. */
const meteredThreadsOf = (
  page: MetersPage,
  shell: Option.Option<ShellSnapshot>
): ReadonlyArray<MeteredThread> =>
  page === "closed"
    ? []
    : Option.match(shell, {
        onNone: () => [],
        onSome: (snapshot) =>
          Array.sort(
            snapshot.threads.flatMap((thread) =>
              Option.match(thread.spend, {
                onNone: () => [],
                onSome: (spend) => [
                  { threadId: thread.id, title: thread.title, spend },
                ],
              })
            ),
            byListPriceThenTokens
          ),
      });

/** The meters' context from the root's state. */
export const contextOf = (inputs: MetersInputs): MetersContext => ({
  epoch: inputs.epoch,
  hasClient: inputs.hasClient,
  page: inputs.page,
  usage: inputs.page === "closed" ? Option.none() : inputs.usage,
  threads: meteredThreadsOf(inputs.page, inputs.shell),
});

/** True when the meters already hold `context`, so the root can skip informing them. */
export const sameContext = (model: Model, context: MetersContext): boolean =>
  Equal.equals(model.context, context);

/** The section state to show while asking again: kept data stays on screen. */
const reloading = <A>(
  data: AsyncData.AsyncData<A, string>
): AsyncData.AsyncData<A, string> =>
  Option.getOrElse(AsyncData.revalidateOrLoad(data), () => data);

const canAsk = (model: Model): boolean =>
  model.context.page !== "closed" && model.context.hasClient;

/** Every token the rows show: new spend on any of them asks for the roll-up again. */
const rowTokens = (context: MetersContext): number =>
  context.threads.reduce((sum, thread) => sum + thread.spend.totalTokens, 0);

/** Asks the brain for every section. */
const loadSections = (model: Model): UpdateReturn => {
  const { epoch } = model.context;

  return {
    model: modifyFields(model, {
      loadedEpoch: () => Option.some(epoch),
      spend: reloading,
      spendAt: () => rowTokens(model.context),
      server: reloading,
      catalog: reloading,
      checks: reloading,
    }),
    commands: [
      FetchSpend({ epoch }),
      FetchMetersSettings({ epoch }),
      FetchMetersCatalog({ epoch }),
    ],
  };
};

/** Takes the root's context; an opened page, a new epoch or new spend asks the brain. */
export const inform = (model: Model, context: MetersContext): UpdateReturn => {
  const next = modifyFields(model, {
    context: () => context,
    // Leaving both pages forgets the epoch, so coming back asks again.
    loadedEpoch: (loaded) =>
      context.page === "closed" ? Option.none() : loaded,
  });

  if (!canAsk(next)) {
    return { model: next };
  }

  if (!Option.contains(next.loadedEpoch, context.epoch)) {
    return loadSections(next);
  }

  const tokens = rowTokens(context);

  if (
    context.page === "usage" &&
    tokens !== next.spendAt &&
    !AsyncData.isLoading(next.spend)
  ) {
    return {
      model: modifyFields(next, {
        spend: reloading,
        spendAt: () => tokens,
      }),
      commands: [FetchSpend({ epoch: context.epoch })],
    };
  }

  return { model: next };
};

/** The answer for `epoch`, written when it is still the meters' epoch. */
const answer = (
  model: Model,
  epoch: number,
  write: (model: Model) => UpdateReturn
): UpdateReturn => (epoch === model.context.epoch ? write(model) : { model });

/** Checks every role of the table the brain answered. */
const checkTable = (model: Model, table: RoleTable): UpdateReturn => ({
  model: modifyFields(model, { checks: reloading }),
  commands: canAsk(model)
    ? [CheckRoles({ epoch: model.context.epoch, table })]
    : [],
});

const decodeThinking = Schema.decodeUnknownOption(ThinkingLevel);

/** The table the brain answered, when nothing else is saving. */
const editableTable = (model: Model): Option.Option<RoleTable> =>
  Option.isSome(model.saving)
    ? Option.none()
    : Option.map(
        AsyncData.getData(model.server),
        (settings) => settings.roleBindings
      );

/** The model a select value names: a listed model, or the role's current one. */
const modelOfValue = (
  model: Model,
  table: RoleTable,
  role: RoleName,
  value: string
): Option.Option<ModelRef> => {
  const listed = Option.flatMap(AsyncData.getData(model.catalog), (catalog) =>
    Array.findFirst(catalog.models, (listing) => modelText(listing) === value)
  );

  return Option.orElse(
    Option.map(listed, (listing): ModelRef => ({
      provider: listing.provider,
      modelId: listing.modelId,
    })),
    () =>
      Option.filter(
        Option.map(
          Option.fromUndefinedOr(table[role]),
          (binding) => binding.model
        ),
        (current) => modelText(current) === value
      )
  );
};

/** Saves `next` for `role` when it changes the table. */
const save = (
  model: Model,
  role: RoleName,
  table: RoleTable,
  next: Option.Option<RoleTable>
): UpdateReturn =>
  Option.match(
    Option.filter(next, (changed) => !Equal.equals(changed, table)),
    {
      onNone: () => ({ model }),
      onSome: (changed) => ({
        model: modifyFields(model, {
          saving: () => Option.some(role),
          notice: () => Option.none(),
        }),
        commands: [SaveRoleTable({ table: changed })],
      }),
    }
  );

const ALL_LEVELS = ThinkingLevel.literals;

/** The meters' update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ReceivedSpend: ({ epoch, spend }) =>
      answer(model, epoch, (current) => ({
        model: modifyFields(current, { spend: () => AsyncData.succeed(spend) }),
      })),
    ReceivedServerSettings: ({ epoch, settings }) =>
      answer(model, epoch, (current) =>
        checkTable(
          modifyFields(current, { server: () => AsyncData.succeed(settings) }),
          settings.roleBindings
        )
      ),
    ReceivedCatalog: ({ catalog, epoch }) =>
      answer(model, epoch, (current) => ({
        model: modifyFields(current, {
          catalog: () => AsyncData.succeed(catalog),
        }),
      })),
    ReceivedRoleChecks: ({ checks, epoch }) =>
      answer(model, epoch, (current) => ({
        model: modifyFields(current, {
          checks: () => AsyncData.succeed(checks),
        }),
      })),
    FailedLoad: ({ epoch, message: text, section }) =>
      answer(model, epoch, (current) => {
        const failed = AsyncData.fail(text);

        return {
          model: Match.value(section).pipe(
            Match.when("spend", () =>
              modifyFields(current, { spend: () => failed })
            ),
            Match.when("server", () =>
              modifyFields(current, { server: () => failed })
            ),
            Match.when("catalog", () =>
              modifyFields(current, { catalog: () => failed })
            ),
            Match.when("checks", () =>
              modifyFields(current, { checks: () => failed })
            ),
            Match.exhaustive
          ),
        };
      }),
    ClickedRetry: () => (canAsk(model) ? loadSections(model) : { model }),

    SelectedRoleModel: ({ role, value }) =>
      Option.match(editableTable(model), {
        onNone: () => ({ model }),
        onSome: (table) =>
          Option.match(modelOfValue(model, table, role, value), {
            onNone: () => ({ model }),
            onSome: (ref) => {
              const levels = Option.match(AsyncData.getData(model.catalog), {
                onNone: () => ALL_LEVELS,
                onSome: (catalog) =>
                  thinkingChoicesOf(catalog.models, ref, ALL_LEVELS),
              });

              return save(
                model,
                role,
                table,
                rebindModel(table, role, ref, levels)
              );
            },
          }),
      }),
    SelectedRoleThinking: ({ role, value }) =>
      Option.match(editableTable(model), {
        onNone: () => ({ model }),
        onSome: (table) =>
          value === ""
            ? save(
                model,
                role,
                table,
                rebindThinking(table, role, Option.none())
              )
            : Option.match(decodeThinking(value), {
                onNone: () => ({ model }),
                onSome: (level) =>
                  save(
                    model,
                    role,
                    table,
                    rebindThinking(table, role, Option.some(level))
                  ),
              }),
      }),
    SavedRoleTable: ({ settings }) =>
      checkTable(
        modifyFields(model, {
          server: () => AsyncData.succeed(settings),
          saving: () => Option.none(),
        }),
        settings.roleBindings
      ),
    FailedRoleSave: ({ message: text }) => ({
      model: modifyFields(model, {
        saving: () => Option.none(),
        notice: () => Option.some(text),
      }),
    }),

    DismissedNotice: () => ({
      model: modifyFields(model, { notice: () => Option.none() }),
    }),
  });

/** The meters' update and root hooks. */
export const meters = { update, inform, sameContext, contextOf } as const;
