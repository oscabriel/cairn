#!/bin/sh
# Claude Code PostToolUse hook: autofix the file just written. Paths the linter ignores are skipped,
# because `ultracite fix --hook` fails when it finds no file to lint.
input=$(cat)
case "$input" in
  *'/spikes/'* | *'/tools/oxlint/anti-slop/'* | *'/.claude/'*) exit 0 ;;
esac
printf '%s' "$input" | pnpm exec ultracite fix --hook
