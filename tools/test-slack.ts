// The test slack: the factor every test deadline scales by (`CAIRN_TEST_SLACK`), so a deadline that
// holds on a quiet machine still holds when other work shares it. The gate (`check.ts`) sets it
// from the load when it starts, before its own steps add to that load; `vitest.config.ts` sets it
// the same way for a run outside the gate and leaves a value already set alone, so a run can name
// its own. Tests read it through `apps/server/src/EventuallyTestKit.ts`.

import os from "node:os";

/** The variable the slack travels in, from the gate to Vitest and its workers. */
export const SLACK_VARIABLE = "CAIRN_TEST_SLACK";

/**
 * The slack this machine's load calls for now, read before the tests add their own: a half plus
 * the one-minute load average per core, to one decimal, and never below 1. The tests' own numbers
 * were set with the run filling every core, so other work slows them once it passes about half the
 * machine, and in proportion after that: a quiet machine gets 1, a load of 50 on 16 cores 3.7.
 */
export const slackFromLoad = (): number => {
  const [oneMinute = 0] = os.loadavg();
  const perCore = oneMinute / os.availableParallelism();

  return Math.max(1, Math.ceil((perCore + 0.5) * 10) / 10);
};

/**
 * The slack `CAIRN_TEST_SLACK` names, or the load's when it names none (or no number of at least
 * 1). Writes the value back to the process's environment, so every worker Vitest starts reads the
 * same one.
 */
export const testSlack = (): number => {
  const named = Number(process.env[SLACK_VARIABLE] ?? "");
  const slack = named >= 1 ? named : slackFromLoad();

  process.env[SLACK_VARIABLE] = String(slack);

  return slack;
};
