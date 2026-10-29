#!/usr/bin/env bash
# The workflow kill and node stop matrices (workflows note judges 1 and 2, plan 4D): a judge brain
# over a scratch store runs a workflow while this judge kill -9s it at named moments (mid fan-out,
# between a node's reserve and its submit, inside its settle, between Go and the codemode call,
# while the script's question waits, across a pi bump), and stops single nodes with and without
# kills around the stop. Every node must be dispatched once, every ledger row must name an accepted
# brief, and a stopped node must be null to the script with its work never finished. The broken
# control (a dispatch that ignores its row) must fail by dispatching twice. The brain is
# `judges/fixtures/workflows/WorkflowBrain.ts`, a plain child process of the judge; nothing here
# touches cairn.service or the user's store.
#
#   judges/workflow-kill.sh [--case <name>]... [--keep]
#
# Prints one JSON line per case and a summary line; exits 0 when every case passes and the control
# fails. No model, no network, no secrets.
set -euo pipefail

cd "$(dirname "$0")/.."

exec node judges/workflow-kill.ts "$@"
