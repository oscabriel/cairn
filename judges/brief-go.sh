#!/usr/bin/env bash
# ADR 0030's gate (plan 4A): Go is the commit that starts the child. A judge brain over a scratch
# data folder and git repository is killed with SIGKILL before, inside and after the Go commit and
# at each step of the child's start; a brief must yield one worktree, one child conversation, one
# first input and one answer to the parent, or none when declined. Ten windows (the race of Go,
# Decline and Go among them), the five-kill parked case (the start task parks, a boot does not retry
# it, a human Retry starts the child once) and a broken control that must fail. The brain is
# `judges/fixtures/brief-go/GoBrain.ts`, a plain child process of the judge; nothing here touches
# cairn.service or the user's store.
#
#   judges/brief-go.sh [--case <name>]... [--keep]
#
# Prints one JSON line per case and a summary line; exits 0 when every window and the parked case
# pass and the control fails. No model, no network, no secrets, $0.
set -euo pipefail

cd "$(dirname "$0")/.."

exec node judges/brief-go.ts "$@"
