#!/usr/bin/env bash
# warm.sh: leave work in the relay for judges/relay-orphans.sh (port of spikes/5-stdio-bridges/warm.sh):
# one playwright and one convex session abandoned open, so each has a running child.
#
#   judges/relay-orphans.sh cairn-bridges http://172.17.0.1:3776/healthz ops/relay/warm.sh executor
#
# The spike's third step, a convex call through Executor, needed Phase 0's setup token, which wizard
# stage 11 revoked; Executor's side is checked through the brain's grant instead (see install.sh).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
"$here/hold.sh" playwright >/dev/null
"$here/hold.sh" convex >/dev/null
