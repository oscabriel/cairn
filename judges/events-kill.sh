#!/usr/bin/env bash
# Durable events under kill -9 (ADR 0033, plan 1B): a judge brain over a scratch store produces 300
# events while it is killed 12 times (case kills) and 10 times with the log rotating (case
# rotation), with handler faults injected on three reactors, one of which creates pi-durable tasks.
# Every (event, reactor) must be handled exactly once, every created task must run once, and every
# reactor's lag must return to 0. The broken control (reactors that keep their cursor in memory)
# must fail. The brain is `judges/fixtures/events/EventsBrain.ts`, a plain child process of the
# judge; nothing here touches cairn.service or the user's store.
#
#   judges/events-kill.sh [--case kills|rotation|control]... [--kills N] [--total N] [--keep]
#
# Prints one JSON line per case and a summary line; exits 0 when the real cases pass and the
# control fails. No model, no network, no secrets.
set -euo pipefail

cd "$(dirname "$0")/.."

exec node judges/events-kill.ts "$@"
