#!/usr/bin/env bash
# J-spend under kill -9 (ADR 0036, plan 2C): a judge brain over a scratch store runs 48 turns on
# four threads (three on the Claude bridge's id, priced as its anthropic twin, one unpriced) while it
# is killed 12 times; the spend ledger must equal what the store holds, priced one response at a
# time, with no token or micro counted twice, and the unpriced thread's row must count its tokens as
# unpriced, never as $0. The broken control (a ledger that adds what it reads and catches up at boot
# by adding every response again) must fail by double counting. The brain is
# `judges/fixtures/spend/SpendBrain.ts`, a plain child process of the judge; nothing here touches
# cairn.service or the user's store.
#
#   judges/spend-kill.sh [--case kills|control]... [--kills N] [--turns N] [--quick] [--keep]
#
# `--quick` kills 50 to 150 ms after each life starts producing, so five kills land on one request
# and pi-durable parks it (`restart_limit`). The last life retries every parked task at boot, so it
# finishes instead of waiting on a turn that never runs; the result counts them as `retriedParked`.
#
# Prints one JSON line per case and a summary line; exits 0 when the real case passes and the
# control fails. No model, no network, no secrets.
set -euo pipefail

cd "$(dirname "$0")/.."

exec node judges/spend-kill.ts "$@"
