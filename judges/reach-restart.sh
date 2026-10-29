#!/usr/bin/env bash
# Portals through brain restarts (ADR 0038's gate): a judge brain running Cairn's `Portals` as a
# transient unit with `cairn.service`'s kill settings, a throwaway Caddy and a scratch porch. The
# page must answer every probe through a `kill -9` and a SIGTERM of the brain, the kill matrix
# (a crash after each step of an open, rerun or not) must leave no unit, porch or live row behind,
# and the control (servers inside the brain's cgroup) must fail. Never cairn.service, the live
# Caddy or the user's porch.
#
#   judges/reach-restart.sh [--case restart|matrix|control]... [--porch <bin>] [--image <caddy image>]
#
# Prints one JSON line per case and a summary; exits 0 on a pass. No model, $0.
set -euo pipefail

cd "$(dirname "$0")/.."

exec node judges/reach-restart.ts "$@"
