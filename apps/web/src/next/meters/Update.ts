// The meters' update (plan wave 6, 6G). The brain is asked for each section when the usage page or
// the settings page opens on a client, and again on a new epoch; answers from another epoch are
// dropped. On the usage page, new spend on the thread rows asks for the roll-up again, one question
// at a time. One budget form is open at a time (ADR 0047): the default a brief or workflow starts
// from, saved through `settings.update`, or a thread's own budget, through `budget.declare`; each in
// dollars at list price and tokens, both empty for no limit.

import { budgetDraftOf, budgetOfDraft } from "@cairn/client-logic/Meters";
import type { ShellSnapshot } from "@cairn/protocol/Shell";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import type { Budget } from "@cairn/protocol/Spend";
import { Array, Equal, Match, Option, Order, Predicate, Result } from "effect";
import type { Update } from "foldkit";
import * as AsyncData from "foldkit/asyncData";
import { modifyFields } from "foldkit/struct";

import { FetchMetersSettings, FetchSpend, SaveBudget } from "./Command.ts";
import type { Services } from "./Command.ts";
import { Message } from "./Message.ts";
import type {
  BudgetForm,
  BudgetTarget,
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
    }),
    commands: [FetchSpend({ epoch }), FetchMetersSettings({ epoch })],
  };
};

/**
 * Asks for the roll-up again when the usage page's rows show spend it was not asked with. One
 * `spend.get` is out at a time (`Loading` or `Refreshing`), so an older roll-up never lands after a
 * newer one; spend that arrives meanwhile is asked for once that answer is in.
 */
const askNewSpend = (model: Model): UpdateReturn => {
  const tokens = rowTokens(model.context);

  if (
    !canAsk(model) ||
    model.context.page !== "usage" ||
    tokens === model.spendAt ||
    AsyncData.isPending(model.spend)
  ) {
    return { model };
  }

  return {
    model: modifyFields(model, {
      spend: reloading,
      spendAt: () => tokens,
    }),
    commands: [FetchSpend({ epoch: model.context.epoch })],
  };
};

/** Takes the root's context; an opened page, a new epoch or new spend asks the brain. */
export const inform = (model: Model, context: MetersContext): UpdateReturn => {
  const next = modifyFields(model, {
    context: () => context,
    // Leaving both pages forgets the epoch, so coming back asks again.
    loadedEpoch: (loaded) =>
      context.page === "closed" ? Option.none() : loaded,
    // A form left open on a page the user left is dropped with it.
    form: (form) => (context.page === "usage" ? form : Option.none()),
    saved: (saved) => (context.page === "usage" ? saved : Option.none()),
  });

  if (!canAsk(next)) {
    return { model: next };
  }

  if (!Option.contains(next.loadedEpoch, context.epoch)) {
    return loadSections(next);
  }

  return askNewSpend(next);
};

/**
 * The budget a form starts from and writes over: the default's own warning line, a thread's the
 * default line of 80 percent. Only dollars and tokens are offered (ADR 0047), so the form writes no
 * other limit.
 */
const baseOf = (model: Model, target: BudgetTarget): Budget =>
  Predicate.isTagged(target, "Default")
    ? {
        ...DEFAULT_BUDGET,
        warnAt: Option.match(AsyncData.getData(model.server), {
          onNone: () => DEFAULT_BUDGET.warnAt,
          onSome: (settings) => settings.defaultBudget.warnAt,
        }),
      }
    : DEFAULT_BUDGET;

/** A form for `target`, filled from the default it changes, empty for a thread. */
const formFor = (model: Model, target: BudgetTarget): BudgetForm => {
  const draft = Predicate.isTagged(target, "Default")
    ? Option.match(AsyncData.getData(model.server), {
        onNone: () => budgetDraftOf(DEFAULT_BUDGET),
        onSome: (settings) => budgetDraftOf(settings.defaultBudget),
      })
    : budgetDraftOf(DEFAULT_BUDGET);

  return { target, ...draft, saving: false, error: Option.none() };
};

/** Changes the open form as typed, unless its save is out; a new word clears the last error. */
const typeForm = (
  model: Model,
  change: (form: BudgetForm) => BudgetForm
): UpdateReturn => ({
  model: modifyFields(model, {
    form: (form) =>
      Option.map(form, (open) =>
        open.saving ? open : change({ ...open, error: Option.none() })
      ),
  }),
});

/** What a saved form set, in words. */
const savedText = (target: BudgetTarget): string =>
  Predicate.isTagged(target, "Thread")
    ? `Budget set for ${target.title}. At its line the thread and its subagents stop.`
    : "Default budget saved. Briefs and workflows proposed from now on start from it.";

/** Saves the open form's budget, or says why it is not one. */
const saveForm = (model: Model): UpdateReturn =>
  Option.match(
    Option.filter(model.form, (form) => !form.saving),
    {
      onNone: () => ({ model }),
      onSome: (form) =>
        Result.match(budgetOfDraft(baseOf(model, form.target), form), {
          onFailure: (problem) => ({
            model: modifyFields(model, {
              form: () => Option.some({ ...form, error: Option.some(problem) }),
            }),
          }),
          onSuccess: (budget) =>
            model.context.hasClient
              ? {
                  model: modifyFields(model, {
                    form: () =>
                      Option.some({
                        ...form,
                        saving: true,
                        error: Option.none(),
                      }),
                  }),
                  commands: [SaveBudget({ target: form.target, budget })],
                }
              : {
                  model: modifyFields(model, {
                    form: () =>
                      Option.some({
                        ...form,
                        error: Option.some(
                          "Cairn is reconnecting. Save again once it is back."
                        ),
                      }),
                  }),
                },
        }),
    }
  );

/** The answer for `epoch`, written when it is still the meters' epoch. */
const answer = (
  model: Model,
  epoch: number,
  write: (model: Model) => UpdateReturn
): UpdateReturn => (epoch === model.context.epoch ? write(model) : { model });

/** The meters' update. */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ReceivedSpend: ({ epoch, spend }) =>
      answer(model, epoch, (current) =>
        askNewSpend(
          modifyFields(current, { spend: () => AsyncData.succeed(spend) })
        )
      ),
    ReceivedServerSettings: ({ epoch, settings }) =>
      answer(model, epoch, (current) => ({
        model: modifyFields(current, {
          server: () => AsyncData.succeed(settings),
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
            Match.exhaustive
          ),
        };
      }),
    ClickedRetry: () => (canAsk(model) ? loadSections(model) : { model }),
    ClickedEditBudget: ({ target }) => ({
      model: modifyFields(model, {
        form: () => Option.some(formFor(model, target)),
        saved: () => Option.none(),
      }),
    }),
    ChangedBudgetDollars: ({ value }) =>
      typeForm(model, (form) => ({ ...form, dollars: value })),
    ChangedBudgetTokens: ({ value }) =>
      typeForm(model, (form) => ({ ...form, tokens: value })),
    ClickedSaveBudget: () => saveForm(model),
    ClickedCancelBudget: () => ({
      model: modifyFields(model, { form: () => Option.none() }),
    }),
    SavedBudget: ({ target, settings }) => ({
      model: modifyFields(model, {
        form: () => Option.none(),
        saved: () => Option.some(savedText(target)),
        server: (server) =>
          Option.match(settings, {
            onNone: () => server,
            onSome: (found) => AsyncData.succeed(found),
          }),
      }),
    }),
    FailedSaveBudget: ({ message: text }) => ({
      model: modifyFields(model, {
        form: (form) =>
          Option.map(form, (open) => ({
            ...open,
            saving: false,
            error: Option.some(text),
          })),
      }),
    }),
  });

/** The meters' update and root hooks. */
export const meters = { update, inform, sameContext, contextOf } as const;
