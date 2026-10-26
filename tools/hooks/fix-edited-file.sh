#!/bin/sh
# Claude Code PostToolUse hook: autofix the file just written. Paths oxfmt or oxlint ignore are
# skipped, because `ultracite fix --hook` fails when it finds no file to fix. Only the edited path is
# matched, never the content written (which may well mention `/spikes/`). Keep the list in step with
# `oxfmt.config.ts` and `oxlint.config.ts`.
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
case "$file" in
  '' | */spikes/* | */tools/oxlint/anti-slop/* | */.claude/* | */.agents/* | */docs/phase-1/* | */judges/fixtures/parity/* | */pnpm-lock.yaml) exit 0 ;;
esac
printf '%s' "$input" | pnpm exec ultracite fix --hook
