// Class strings copied from t3code's rendered composer at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92
// (apps/web/src/components/chat/{ChatComposer,ComposerSurface,ComposerPrimaryActions}.tsx and
// BranchToolbar.tsx, read from the live nightly's DOM and the S2 spike's capture). The theme-id
// variants are dropped with t3code's themes; everything else is verbatim, so the parity judge can
// compare pixels.
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

/** The composer's outer shell (the glass card and, with a context strip, its drawer shape). */
export const SHELL_CLASS =
  "@container/composer-surface group/composer-surface relative isolate mx-auto w-full max-w-(--chat-content-max-width) [--chat-composer-drawer-inset:1.375rem] [--chat-composer-glass-surface:var(--card)] [--chat-composer-outline:rgb(0_0_0/8%)] dark:[--chat-composer-glass-surface:var(--surface-raised)] dark:[--chat-composer-highlight:rgb(255_255_255/3%)] dark:[--chat-composer-outline:color-mix(in_srgb,var(--color-white)_5%,transparent)] before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-3xl before:bg-(--chat-composer-glass-surface)/(--glass-opacity) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation) not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-glass-surface) has-data-[composer-banner-surface=attached]:before:hidden data-model-strip-transition:before:hidden [--chat-composer-context-extension:2.25rem] sm:[--chat-composer-context-extension:2rem] supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:rounded-none before:[clip-path:shape(from_0_22px,curve_to_22px_0_with_0_9.85px/9.85px_0,line_to_calc(100%-22px)_0,curve_to_100%_22px_with_calc(100%-9.85px)_0/100%_9.85px,line_to_100%_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)),curve_to_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-var(--chat-composer-context-extension))_with_100%_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)*0.4477)/calc(100%-var(--chat-composer-drawer-inset)*0.4477)_calc(100%-var(--chat-composer-context-extension)),line_to_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-16px),curve_to_calc(100%-var(--chat-composer-drawer-inset)-16px)_100%_with_calc(100%-var(--chat-composer-drawer-inset))_calc(100%-7.16px)/calc(100%-var(--chat-composer-drawer-inset)-7.16px)_100%,line_to_calc(var(--chat-composer-drawer-inset)+16px)_100%,curve_to_var(--chat-composer-drawer-inset)_calc(100%-16px)_with_calc(var(--chat-composer-drawer-inset)+7.16px)_100%/var(--chat-composer-drawer-inset)_calc(100%-7.16px),line_to_var(--chat-composer-drawer-inset)_calc(100%-var(--chat-composer-context-extension)),curve_to_0_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset))_with_calc(var(--chat-composer-drawer-inset)*0.4477)_calc(100%-var(--chat-composer-context-extension))/0_calc(100%-var(--chat-composer-context-extension)-var(--chat-composer-drawer-inset)*0.4477),line_to_0_22px,close)] not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:bottom-(--chat-composer-context-extension)";

/** The host inside the shell that carries the card's shadow and outline. */
export const HOST_CLASS =
  "relative z-10 w-full rounded-3xl shadow-composer after:z-1 dark:shadow-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-(--chat-composer-outline) dark:after:inset-shadow-2xs dark:after:inset-shadow-(color:--chat-composer-highlight) group-data-with-context/composer-surface:after:[clip-path:polygon(0_0,100%_0,100%_100%,calc(100%-22px)_100%,calc(100%-22px)_calc(100%-2px),22px_calc(100%-2px),22px_100%,0_100%)] group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none group-has-data-[composer-banner-surface=attached]/composer-surface:after:hidden";

/** The slot above the card where an attached drawer (menu, queue) sits. */
export const BANNER_SLOT_CLASS =
  "mx-auto -mb-[calc(1rem+1px)] w-[calc(100%-2*var(--chat-composer-drawer-inset))] [&+[data-slot=composer-banner-attachment]_[data-composer-banner-surface=attached]]:before:rounded-none [&+[data-slot=composer-banner-attachment]_[data-composer-banner-surface=attached]]:before:border-t-0 [&+*_[data-chat-composer-form]>[data-slot=composer-banner-attachment]:first-child_[data-composer-banner-surface=attached]]:before:rounded-none [&+*_[data-chat-composer-form]>[data-slot=composer-banner-attachment]:first-child_[data-composer-banner-surface=attached]]:before:border-t-0 flex items-end gap-1 not-has-data-[composer-banner-surface=attached]:hidden";

/** The stack of attached drawers inside the banner slot. */
export const BANNER_STACK_CLASS =
  "flex min-w-0 flex-1 flex-col empty:hidden [&>[data-slot=composer-banner-attachment]]:w-full [&>[data-slot=composer-banner-attachment]:last-child]:mb-0";

/** The card's main surface. */
export const MAIN_SURFACE_CLASS =
  "group relative z-10 rounded-3xl p-px group-data-model-strip-transition/composer-surface:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-data-model-strip-transition/composer-surface:backdrop-blur-(--glass-blur) group-data-model-strip-transition/composer-surface:backdrop-saturate-(--glass-saturation) after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-(--chat-composer-outline) dark:after:inset-shadow-2xs dark:after:inset-shadow-(color:--chat-composer-highlight) group-data-with-context/composer-surface:after:[clip-path:polygon(0_0,100%_0,100%_100%,calc(100%-22px)_100%,calc(100%-22px)_calc(100%-2px),22px_calc(100%-2px),22px_100%,0_100%)] after:z-20 after:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:block group-data-model-strip-transition/composer-surface:after:block group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-blur-(--glass-blur) group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-saturate-(--glass-saturation) group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-composer dark:group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface) group-has-data-[composer-banner-surface=attached]/composer-surface:**:data-[chat-composer-mobile-collapsed=true]:min-h-[calc(1rem+1px)]";

/** The surface inside the main surface. */
export const SURFACE_CLASS =
  "rounded-3xl transition-[background-color] duration-200 in-data-[thread-context-over]:bg-accent/45 in-data-[thread-context-over]:ring-1 in-data-[thread-context-over]:ring-inset in-data-[thread-context-over]:ring-primary/70";

/** The body that holds the editor. */
export const BODY_CLASS = "relative px-3 pb-2 sm:px-4 pt-3.5 sm:pt-4";

/** The footer row under the editor. */
export const FOOTER_CLASS =
  "flex min-w-0 flex-nowrap items-center justify-between overflow-visible px-3 pb-3 sm:px-4 sm:pb-4 gap-2 sm:gap-0";

/** The footer's left cluster: model picker, traits and mode blocks, overflow. */
export const CONTROLS_CLASS =
  "relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** Every footer and context-strip control's base. */
export const CONTROL_BASE_CLASS =
  "relative inline-flex cursor-pointer items-center rounded-(--control-radius) border border-transparent text-base outline-none hover:bg-accent data-pressed:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-disabled:pointer-events-none data-disabled:opacity-64 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&:active:not([aria-haspopup])]:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:-mx-0.5 [&_svg[data-composer-control-icon]]:mx-0 [&_:is([data-composer-control-label],[data-chat-provider-model-picker-label])]:[text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:[&_:is([data-composer-control-label],[data-chat-provider-model-picker-label])]:py-1.5";

/** A footer control's size and colour, after the base. */
export const FOOTER_CONTROL_CLASS =
  "h-7 gap-1.5 px-2.5 font-medium text-secondary-label [&_svg:not([class*='text-'])]:text-muted-foreground hover:text-foreground sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-pressed:hover:bg-accent/80";

/** A context-strip control's size and colour, after the base. */
export const CONTEXT_CONTROL_CLASS =
  "h-7 gap-1 px-1.75 font-normal text-muted-foreground/70 text-sm hover:text-foreground/80 sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5 [&_svg[data-composer-control-chevron]]:ms-0 [&_svg[data-composer-control-chevron]]:-me-1 aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-pressed:hover:bg-accent/80";

/** One foldable footer block (traits, mode). */
export const BLOCK_CLASS = "flex w-max min-w-max shrink-0 items-center gap-1";

/** The vertical rule before a block. */
export const SEPARATOR_CLASS =
  "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:not-[[class^='h-']]:not-[[class*='_h-']]:self-stretch mx-0.5 hidden sm:block h-4";

/** The footer's right cluster. */
export const ACTIONS_CLASS =
  "flex shrink-0 flex-nowrap items-center justify-end gap-2";

/** The paperclip button. */
export const ATTACH_CLASS =
  "[&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-base outline-none transition-[box-shadow,scale] [&:not([aria-haspopup]):not(:disabled):not([aria-disabled=true])]:will-change-[scale] [&:active:not([aria-haspopup])]:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 sm:text-sm [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 size-8 sm:size-7 [--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent";

/** The round send button (t3code's plain variant, without the brand artwork). */
export const SEND_CLASS =
  "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover";

/** The round Stop button while a run is busy. */
export const STOP_CLASS =
  "flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-colors duration-150 hover:bg-destructive active:inset-shadow-control-pressed active:shadow-none [&_svg]:pointer-events-none size-8 sm:h-8 sm:w-8";

/** A pill-shaped message action (Clear queue). */
export const PILL_CLASS =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-message-action font-medium text-base text-message-action-foreground shadow-xs shadow-message-action/24 outline-none hover:bg-message-action-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:text-sm";

/** The context strip under the card. */
export const CONTEXT_STRIP_CLASS =
  "group/composer-context relative isolate mx-auto -mt-4 flex w-[calc(100%-2*var(--chat-composer-drawer-inset))] items-center overflow-x-clip overflow-y-visible px-2 pt-5 pb-1 before:absolute before:inset-0 before:-z-1 before:rounded-b-2xl before:border before:border-(--chat-composer-outline) before:mask-b-from-transparent before:mask-b-from-(position:--spacing-composer-seam) before:mask-b-to-black before:mask-b-to-(position:--spacing-composer-seam) before:shadow-composer dark:before:border-white/7 dark:before:bg-composer-seam-below dark:before:shadow-composer-dark group-has-data-[composer-banner-surface=attached]/composer-surface:before:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-has-data-[composer-banner-surface=attached]/composer-surface:before:backdrop-blur-(--glass-blur) group-has-data-[composer-banner-surface=attached]/composer-surface:before:backdrop-saturate-(--glass-saturation) not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:bg-(--chat-composer-glass-surface)/(--glass-opacity) not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:backdrop-blur-(--glass-blur) not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:backdrop-saturate-(--glass-saturation) gap-1 text-xs font-normal text-muted-foreground/70";

/** A context-strip label's frame (it collapses when the strip is compact). */
export const CONTEXT_LABEL_CLASS =
  "min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0";

/** A context-strip label. */
export const CONTEXT_LABEL_MOTION_CLASS =
  "block w-full min-w-0 truncate max-w-[240px] transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none";

/** A popover's glass panel. */
export const POPUP_CLASS =
  "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg text-popover-foreground outline-none transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)] dropdown-glass shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]";

/** One row of a footer menu. */
export const MENU_ITEM_CLASS =
  "[&>svg]:-mx-0.5 flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 text-base text-foreground outline-none data-disabled:pointer-events-none data-disabled:cursor-not-allowed hover:bg-accent data-active:bg-accent data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg:not([class*='size-'])]:size-4.5 sm:[&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='text-'])]:text-muted-foreground [&>svg]:pointer-events-none [&>svg]:shrink-0";
