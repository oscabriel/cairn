# Parity is judged against t3code nightly

The kickoff pinned t3code at `7e289ae1`, but the t3code the user actually runs is the `t3code-nightly-bin` build on the Beelink (`0.1.1-nightly.20261020.3438`, commit `fe27e8e3`, 12 commits later, served at `t3.gneiss.run`). Parity screenshots and port sources must come from the same commit, so the pin follows the installed nightly: when the nightly is upgraded, read its commit from the matching GitHub release, move the pin in `AGENTS.md`, and re-check the port paths in research 03. Port headers name the commit each file was ported from.
