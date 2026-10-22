// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ui/sidebar.tsx,
// apps/web/src/components/ui/sheet.tsx, apps/web/src/components/sidebar/SidebarThreadHeader.tsx,
// apps/web/src/components/ui/collapsible-section-header.tsx, apps/web/src/components/ui/alert.tsx and
// apps/web/src/contextMenuFallback.ts at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92, as the installed
// nightly renders them (class strings read from its DOM, after tailwind-merge). Kept: every class
// string, so identical classes give identical pixels. Changed: nothing but the names.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

/** The outer element of the desktop sidebar: the peer the main column sits beside. */
export const SIDEBAR_ROOT_CLASS =
  "group peer hidden text-sidebar-foreground md:block";

/** The in-flow gap that reserves the sidebar's width. */
export const SIDEBAR_GAP_CLASS =
  "relative w-(--sidebar-width) bg-transparent [[data-panel-animations=true]_&]:transition-[width] [[data-panel-animations=true]_&]:[transition-duration:var(--panel-animation-duration)] [[data-panel-animations=true]_&]:ease-out group-data-[collapsible=offcanvas]:w-0 group-data-[side=right]:rotate-180 group-data-[collapsible=icon]:w-(--sidebar-width-icon)";

/** The fixed container that draws the sidebar. */
export const SIDEBAR_CONTAINER_CLASS =
  "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) md:flex [[data-panel-animations=true]_&]:transition-[left,right,width] [[data-panel-animations=true]_&]:[transition-duration:var(--panel-animation-duration)] [[data-panel-animations=true]_&]:ease-out left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l";

/** The sidebar's surface. */
export const SIDEBAR_INNER_CLASS =
  "flex h-full w-full flex-col bg-sidebar surface-grain group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm/5";

/** The phone's sheet viewport. */
export const SHEET_VIEWPORT_CLASS =
  "fixed inset-0 z-(--z-sheet) flex justify-start";

/** The dimmed layer behind the phone's sheet. */
export const SHEET_BACKDROP_CLASS =
  "fixed inset-0 z-(--z-sheet) bg-background/60 backdrop-blur-xs transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0";

/** The phone's sheet holding the sidebar. */
export const SHEET_POPUP_CLASS =
  "relative flex max-h-full min-h-0 min-w-0 flex-col not-dark:bg-clip-padding shadow-lg/5 transition-[opacity,translate] duration-200 ease-in-out will-change-transform before:pointer-events-none before:absolute before:inset-0 before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:opacity-0 data-starting-style:opacity-0 max-sm:before:hidden dark:before:shadow-[0_-1px_--theme(--color-white/6%)] data-ending-style:-translate-x-8 data-starting-style:-translate-x-8 border-e w-(--sidebar-width) max-w-none bg-sidebar surface-grain p-0 text-sidebar-foreground";

/** The column inside the sheet. */
export const SHEET_COLUMN_CLASS =
  "flex h-full w-full flex-col pb-safe pt-safe max-sm:[--workspace-titlebar-control-size:--spacing(8)] pl-safe";

/** The band at the top that t3code fills with its brand. */
export const CHROME_HEADER_CLASS =
  "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3";

/** A sidebar group: padded by the content inset. */
export const GROUP_CLASS =
  "relative flex w-full min-w-0 flex-col p-[var(--sidebar-content-inset)]";

/** The search field's frame. */
export const SEARCH_FIELD_CLASS =
  "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground";

/** The search input's control wrapper. */
export const SEARCH_CONTROL_CLASS =
  "[&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:placeholder:text-sidebar-muted-foreground min-w-0 flex-1";

/** The search input. */
export const SEARCH_INPUT_CLASS =
  "h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none placeholder:text-placeholder sm:h-7.5 sm:leading-7.5 [transition:background-color_5000000s_ease-in-out_0s] [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none";

/** The ghost-muted micro button that clears the search. */
export const CLEAR_SEARCH_CLASS =
  "[&_svg]:-mx-0.5 relative inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap border font-medium text-base outline-none transition-[box-shadow,scale] [&:not([aria-haspopup]):not(:disabled):not([aria-disabled=true])]:will-change-[scale] [&:active:not([aria-haspopup])]:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 sm:text-sm [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 size-5 rounded-sm p-0 before:rounded-[calc(var(--radius-sm)-1px)] [&_svg:not([class*='size-'])]:size-3 [--control-icon-color:currentColor] border-transparent text-muted-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-foreground shrink-0";

const MENU_BUTTON_BASE =
  "peer/menu-button flex cursor-pointer items-center gap-[var(--sidebar-control-gap)] overflow-hidden text-left outline-hidden ring-ring transition-[width,height,padding] hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset active:bg-sidebar-row-active active:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:opacity-64 data-[active=true]:bg-sidebar-row-selected data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground data-[state=open]:hover:bg-sidebar-row-hover data-[state=open]:hover:text-sidebar-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-[var(--sidebar-content-inset)]! [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--sidebar-icon-color)] hover:[&>svg]:text-sidebar-foreground active:[&>svg]:text-sidebar-foreground data-[active=true]:[&>svg]:text-sidebar-foreground";

/** A header icon button (filter, add project, new thread). */
export const HEADER_ICON_BUTTON_CLASS = `${MENU_BUTTON_BASE} justify-center rounded-[var(--control-radius)] p-0 font-medium text-sidebar-muted-foreground/80 relative size-7 shrink-0`;

/** A footer icon button (settings, usage). */
export const FOOTER_ICON_BUTTON_CLASS = `${MENU_BUTTON_BASE} size-8 justify-center rounded-[var(--control-radius)] p-0 font-medium text-sidebar-muted-foreground/80`;

/** The invisible 3rem touch target inside a header icon button. */
export const TOUCH_TARGET_CLASS =
  "pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden";

/** The scroll area's root. */
export const SCROLL_ROOT_CLASS =
  "relative size-full overflow-hidden rounded-[inherit] h-auto min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:[--fade-size:0.75rem]";

/** The scroll area's viewport. */
export const SCROLL_VIEWPORT_CLASS =
  "h-full max-h-[inherit] overflow-auto overscroll-contain rounded-[inherit] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-has-overflow-x:overscroll-x-contain mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] focus-visible:mask-none [--fade-size:1.5rem] has-focus-visible:mask-none [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** The sidebar content column inside the scroll area. */
export const CONTENT_CLASS =
  "flex w-full min-w-0 flex-col [overflow-anchor:none] group-data-[collapsible=icon]:overflow-hidden [&>[data-sidebar=group]+[data-sidebar=group]]:pt-0 [&>[data-sidebar=group]:first-child]:pt-0 min-h-full";

/** A zero-height list marker between shelves. */
export const MARKER_CLASS =
  "list-none pointer-events-none relative mx-0.5 -mb-px h-0";

/** A zero-height drop placeholder. */
export const PLACEHOLDER_CLASS = "list-none relative mx-0.5 -mb-px h-0";

/** A shelf header's toggle. */
export const SHELF_TOGGLE_CLASS =
  "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 px-2";

/** The shelf header tones: muted for settled, info for snoozed. */
export const SHELF_TONES = {
  muted: {
    label: "text-sidebar-muted-foreground/60",
    line: "bg-sidebar-border/60",
  },
  info: {
    label: "text-blue-600 dark:text-blue-400",
    line: "bg-blue-500/20 dark:bg-blue-400/15",
  },
} as const;

/** The "Show 25 more" button under the settled rows. */
export const SHOW_MORE_CLASS =
  "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground";

/** Every row's surface, before its state classes. */
export const ROW_SURFACE_CLASS =
  "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** A status slot's resting label (hidden while the row is hovered). */
export const STATUS_LABEL_CLASS =
  "pointer-events-none group-has-[:focus-visible]/sidebar-status-slot:absolute group-has-[:focus-visible]/sidebar-status-slot:right-0 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-any-hover/sidebar-row:absolute group-any-hover/sidebar-row:right-0 group-any-hover/sidebar-row:opacity-0 flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity";

/** A status slot's row controls (shown while the row is hovered). */
export const STATUS_CONTROLS_CLASS =
  "pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:static group-any-hover/sidebar-row:opacity-100";

/** A slim row's hover action (un-settle, wake). */
export const SLIM_ACTION_CLASS =
  "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100";

/** The fallback context menu's panel. */
export const CONTEXT_MENU_CLASS =
  "dropdown-glass fixed z-[10000] min-w-32 max-w-sm overflow-hidden rounded-lg bg-clip-padding text-popover-foreground outline-none";

/** The fallback context menu's inline style. */
export const CONTEXT_MENU_STYLE = {
  position: "fixed",
  "z-index": "10000",
  "min-width": "8rem",
  "max-width": "24rem",
  overflow: "hidden",
  "border-radius": "var(--radius-lg)",
  "background-clip": "padding-box",
  color: "var(--contrast-popover-foreground)",
  outline: "none",
  "pointer-events": "auto",
} as const;

/** The fallback context menu's scrolling column. */
export const CONTEXT_MENU_INNER_CLASS =
  "max-h-[calc(100vh-0.5rem)] min-w-0 max-w-sm overflow-y-auto overflow-x-hidden p-1";

/** Its inline style. */
export const CONTEXT_MENU_INNER_STYLE = {
  "max-height": "calc(-0.5rem + 100vh)",
  "min-width": "0px",
  "max-width": "24rem",
  overflow: "hidden auto",
  padding: "0.25rem",
} as const;

/** A context menu row, before its tone. */
export const CONTEXT_MENU_ROW_CLASS =
  "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-left outline-none transition-colors sm:min-h-7 sm:text-sm min-h-8 text-base";

/** A context menu row's inline style. */
export const CONTEXT_MENU_ROW_STYLE = {
  display: "flex",
  width: "100%",
  "min-height": "1.75rem",
  "align-items": "center",
  gap: "0.5rem",
  border: "0px",
  "border-radius": "var(--radius-sm)",
  background: "transparent",
  padding: "0.25rem 0.5rem",
  color: "var(--contrast-foreground)",
  "font-family": "var(--font-sans,system-ui,sans-serif)",
  "font-size": "0.875rem",
  "line-height": "1.25rem",
  "text-align": "left",
  cursor: "default",
} as const;

/** The context menu's separator. */
export const CONTEXT_MENU_SEPARATOR_CLASS = "mx-2 my-1 h-px bg-border";

/** Its inline style. */
export const CONTEXT_MENU_SEPARATOR_STYLE = {
  height: "1px",
  margin: "0.25rem 0.5rem",
  background: "var(--contrast-border)",
} as const;

/** The sidebar alert the undo notice uses. */
export const UNDO_ALERT_CLASS =
  "relative rounded-xl border px-3.5 py-3 text-card-foreground text-sm rounded-lg border-sidebar-border bg-sidebar-control-surface px-2 py-1.5 text-[11px] leading-4 [&_[data-slot=alert-description]]:block [&_[data-slot=alert-description]]:text-sidebar-muted-foreground";

/** The inline button inside the undo notice. */
export const INLINE_BUTTON_CLASS =
  "cursor-pointer font-medium text-sidebar-foreground underline-offset-2 hover:underline";
