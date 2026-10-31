// Whether the thread page's diff panel can open. It is off at every width (the user, 2026-10-30:
// the right-hand diff panel broke on the phone, with skeleton rows and clipped headers): the
// header's diff toggle is not drawn, the changed-files card opens no panel, and the thread page
// draws no panel even when its diff model says open. The panel's code stays; set this to true to
// bring every entry point back once the panel is fixed.
export const DIFF_PANEL_ENABLED = false;
