#!/usr/bin/env bash
# The parity reviewer (plan 4F): a model from another family (OpenAI GPT, through pi and the
# OpenCode Go key) looks at every pair judges/parity.ts wrote, t3code first, Cairn second, then the
# difference image, and answers each row of the parity plan's "Why it feels unpolished" table
# (~/Developer/agent-artifacts/cairn/t3code-parity-plan.html) with "same as t3code" or "differs".
#
#   judges/parity-review.sh [<dir>] [group...]
#   REVIEW_MODEL=opencode-go/gpt-6-luna judges/parity-review.sh ~/Developer/agent-artifacts/cairn/v2/phase-1-parity
#
# <dir> is parity.ts's output (default ~/Developer/agent-artifacts/cairn/v2/phase-1-parity); groups
# default to sidebar, hero and thread. Each group is reviewed in batches of at most 6 states (18
# images) and the answers go to <dir>/review-<group>-<n>.md, joined in <dir>/review.md. The declared
# gaps are named so the reviewer reports them but does not count them.
set -euo pipefail

dir=${1:-$HOME/Developer/agent-artifacts/cairn/v2/phase-1-parity}
shift || true
groups=("${@:-sidebar hero thread settings}")
read -r -a groups <<<"${groups[*]}"
model=${REVIEW_MODEL:-opencode-go/gpt-6-luna}
batch=6

declare -A checklist=(
	[sidebar]="Sidebar: one flat inbox across projects. Active and Settled sections. Status words (Working, Approval, Failed), receding rows, hover actions, search and a project filter in one header row."
	[new-thread]="New thread: the composer is centred under \"What should we build in [Project]?\", a combobox with search and Add project, plus \"or start without a project\"."
	[composer]="Composer: a rounded-3xl card. One footer row of borderless h-7 ghost controls that fold into a menu by width. A context ring and a round send button. Drafts saved per thread. Collapses to one row on mobile."
	[transcript]="Transcript: tool runs fold into one \"Ran 3 commands, read 2 files\" row. Turns fold to \"Worked for 42s\". Hover timestamps. Virtualized, with per-thread scroll memory. A changed-files card per turn."
	[look]="Look: semantic tokens, status tints at 8%, glass, a neutral-950 dark theme with white/6% borders, compact tactile buttons, stepped pulses, a 6px scrollbar."
	[shell]="Shell: resizable, persisted panels. Command palette and shortcuts. A 2 s grace before reconnect warnings. Settings for theme and font size. Shiki diffs with a file tree."
	[settings]="Settings: grouped cards of rows (title, description, control on the right, stacked when narrow) under section headings, at the readable width, under a settings breadcrumb header."
)

declare -A rows_for=(
	[sidebar]="sidebar look"
	[hero]="new-thread composer look shell"
	[thread]="transcript composer look shell"
	[settings]="settings look"
)

gaps="Declared gaps, which you must list but which do not make a row differ: the brand header (t3code's starfield and \"T3 Code\" wordmark; Cairn shows the text \"Cairn\"), project favicons (Cairn draws monograms), drag reorder of rows, the sweep gesture on rows, t3code's pull request and update pill in the sidebar footer, t3code's thread details panel, and differences that come only from the data each app holds (thread titles, ages, model names, branch names), t3code's settings navigation column, its scope line (Applying settings for All projects across All environments) and Restore device defaults (Cairn has one settings page and one scope), and settings that exist in only one app."

: >"$dir/review.md"

for group in "${groups[@]}"; do
	mapfile -t states < <(find "$dir/$group" -maxdepth 1 -name '*-t3.png' -printf '%f\n' | sed 's/-t3\.png$//' | sort)

	if [[ ${#states[@]} -eq 0 ]]; then
		echo "parity-review: no pairs for $group in $dir; run judges/parity.ts first" >&2
		continue
	fi

	checklist_text=""
	for row in ${rows_for[$group]}; do
		checklist_text+=$'\n'"- ${checklist[$row]}"
	done

	part=0
	for ((start = 0; start < ${#states[@]}; start += batch)); do
		part=$((part + 1))
		chunk=("${states[@]:start:batch}")
		images=()
		for state in "${chunk[@]}"; do
			images+=("@$dir/$group/$state-t3.png" "@$dir/$group/$state-cairn.png" "@$dir/$group/$state-diff.png")
		done

		prompt="You are judging whether a new web app (Cairn) has reached visual parity with t3code.
You get ${#chunk[@]} states of the $group surface, three images per state, in this order: t3code, Cairn, then a
difference image where magenta marks pixels that differ (black areas were masked as declared differences).
States, in order: ${chunk[*]}. A state name starts with the viewport width (1440 is desktop 1440x900, 390 is a
phone 390x844, other numbers are desktop widths where the composer footer folds).
For each checklist row below, compare only what the screenshots show. Answer each row with exactly one of
\"same as t3code\" or \"differs\", followed by every visible difference you can find (position, size, colour, text,
spacing, icons), naming the state each one is in, however small. Then list anything the screenshots cannot show
for that row (for example hover states, animation or menus), marked \"not visible\". Be strict: \"same\" means
indistinguishable.
$gaps

Checklist:$checklist_text"

		out="$dir/review-$group-$part.md"
		# No tools and no session: the reviewer only looks.
		pi -p --no-session --no-tools --model "$model" "${images[@]}" "$prompt" </dev/null >"$out" 2>"$dir/review-$group-$part.log"
		{
			echo "## $group, part $part (${chunk[*]})"
			echo
			cat "$out"
			echo
		} >>"$dir/review.md"
		echo "parity-review: $group part $part written to $out"
	done
done

echo "parity-review: $dir/review.md"
