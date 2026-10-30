#!/usr/bin/env bash
# The node stop matrix (workflows note judge 2, plan 5C): a judge brain over a scratch store runs a
# workflow, stops one node or the whole workflow through the service behind `workflow.stopNode` and
# `workflow.stop`, and this judge kill -9s it around the stop. A stopped node must be null to the
# script with its work never finished and its spend in its receipt; nothing may rerun across a
# kill; a node held in a deaf wait must stop at once. The broken control (node tools deaf to the
# stop) must fail by a slow stop. The brain is `judges/fixtures/workflows/StopBrain.ts`, a plain
# child process of the judge; nothing here touches cairn.service or the user's store.
#
#   judges/workflow-stop.sh [--case <name>]... [--keep]
#
# Prints one JSON line per case and a summary line; exits 0 when every case passes and the control
# fails. No model, no network, no secrets.
set -euo pipefail

cd "$(dirname "$0")/.."

exec node judges/workflow-stop.ts "$@"
