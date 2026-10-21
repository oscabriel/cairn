#!/usr/bin/env bash
# Deploy spike 1's stack with Alchemy 2, on the default profile in ~/.alchemy. No Docker: the image is the one
# Actions pushed (runs/stone-image.txt, from the stone image workflow's artifact).
#   ./deploy.sh [plan|deploy|destroy]
# .env here (0600, ignored) holds RELAY_SECRET, made on the first run, and ACCESS_TEAM_DOMAIN.
set -euo pipefail
cd "$(dirname "$0")"
umask 077
touch .env && chmod 600 .env
grep -q '^RELAY_SECRET=' .env || echo "RELAY_SECRET=$(openssl rand -hex 32)" >> .env
grep -q '^ACCESS_TEAM_DOMAIN=' .env || echo "ACCESS_TEAM_DOMAIN=https://still-glitter-6c16.cloudflareaccess.com" >> .env
STONE_IMAGE=$(cat runs/stone-image.txt)
[[ $STONE_IMAGE =~ ^registry\.cloudflare\.com/cairn-stone@sha256:[0-9a-f]{64}$ ]] || { echo "runs/stone-image.txt: not a digest reference" >&2; exit 1; }
export STONE_IMAGE
cmd=${1:-deploy}; shift || true
exec node_modules/.bin/alchemy "$cmd" --env-file .env "$@"
