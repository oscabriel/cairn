#!/usr/bin/env bash
# Fetch pi-claude-bridge at upstream main (1ae18a2) into runs/upstream (ignored by git), unmodified.
set -euo pipefail
cd "$(dirname "$0")"
commit=1ae18a2151c2bac2aa5df7ec691b2ecb7938f0bb
rm -rf runs/upstream && mkdir -p runs/upstream
gh api "repos/elidickinson/pi-claude-bridge/tarball/$commit" > runs/upstream.tar.gz
tar xzf runs/upstream.tar.gz -C runs/upstream --strip-components=1
echo "upstream at $commit in runs/upstream"
