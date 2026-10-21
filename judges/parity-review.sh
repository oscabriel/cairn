#!/usr/bin/env bash
# The parity reviewer: a model from another family (OpenAI GPT, through pi and the OpenCode Go key) judges
# judges/parity.mjs's screenshots against the parity plan's checklist and writes its verdict to <dir>/review.md.
#   REVIEW_MODEL=opencode-go/gpt-6-luna judges/parity-review.sh <dir> [row...]
# Rows default to the surfaces S2 judges: sidebar, new-thread, composer, look.
set -euo pipefail
dir=$1
shift
rows=("${@:-sidebar new-thread composer look}")
read -r -a rows <<<"${rows[*]}"

declare -A checklist=(
	[sidebar]="Sidebar: one flat inbox across projects. Active and Settled sections. Status words (Working, Approval, Failed), receding rows, hover actions, search and a project filter in one header row."
	[new-thread]="New thread: the composer is centred under \"What should we build in [Project]?\", a combobox with search and Add project, plus \"or start without a project\"."
	[composer]="Composer: a rounded-3xl card. One footer row of borderless h-7 ghost controls that fold into a … menu by width. A context ring and a round send button. Collapses to one row on mobile."
	[look]="Look: semantic tokens, status tints at 8%, glass, a neutral-950 dark theme with white/6% borders, compact tactile buttons, stepped pulses, a 6px scrollbar."
	[transcript]="Transcript: tool runs fold into one row; turns fold to \"Worked for 42s\"; hover timestamps; changed-files card per turn."
	[shell]="Shell: resizable panels, command palette, a grace period before reconnect warnings, settings for theme and font size."
)

images=()
for view in 1440 390 390-sidebar; do
	images+=("@$dir/$view-t3.png" "@$dir/$view-cairn.png")
done

prompt="You are judging whether a new web app (Cairn) has reached visual parity with t3code.
You get six screenshots, in pairs: for each view, t3code first and Cairn second. Views, in order: desktop 1440x900,
phone 390x844, phone 390x844 with the sidebar open.
For each checklist row below, compare only what the screenshots show. Answer each row with exactly one of
\"same as t3code\" or \"differs\", followed by every visible difference you can find (position, size, colour, text,
spacing, icons), however small. Then list anything the screenshots cannot show for that row (for example hover states
or menus), marked \"not visible\". Be strict: \"same\" means indistinguishable.

Checklist:"
for row in "${rows[@]}"; do
	prompt+=$'\n'"- ${checklist[$row]}"
done

# No tools and no session: the reviewer only looks.
pi -p --no-session --no-tools --model "${REVIEW_MODEL:-opencode-go/gpt-6-luna}" "${images[@]}" "$prompt" </dev/null >"$dir/review.md" 2>"$dir/review.log"
cat "$dir/review.md"
