// The `next` avatar: a small square mark for a project, a role (`@worker`, `@scout`) or an agent,
// as one or two initials on a tone's wash, or as a glyph. It names nothing on its own: the words
// beside it do, so the avatar is hidden from assistive technology.

import type { Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import { TYPE, WEIGHT_STRONG } from "./Classes.ts";
import type { Tone } from "./Tone.ts";
import { TONE_TEXT, TONE_WASH } from "./Tone.ts";

/** An avatar's size: `small` in a row, `regular` in a card's header, `large` in an empty state. */
export type AvatarSize = "small" | "regular" | "large";

const SIZE: Readonly<Record<AvatarSize, string>> = {
  small: classNames("size-5 rounded-(--radius-small)", TYPE.micro),
  regular: classNames("size-7 rounded-(--radius-small)", TYPE.small),
  large: classNames("size-10 rounded-(--radius-medium)", TYPE.title),
};

/** The class string of an avatar of `size` in `tone`. */
export const avatarClass = (size: AvatarSize, tone: Tone): string =>
  classNames(
    "inline-flex shrink-0 select-none items-center justify-center overflow-hidden uppercase",
    WEIGHT_STRONG,
    SIZE[size],
    TONE_WASH[tone],
    TONE_TEXT[tone]
  );

/**
 * The initials of `name`: the first letter of its first two words, or its first two letters when
 * it is one word (`cairn` is `CA`, `pi durable` is `PD`), ignoring a leading `@`.
 */
export const initialsOf = (name: string): string => {
  const words = name
    .replace(/^@/u, "")
    .split(/[\s_-]+/u)
    .filter((word) => word !== "");

  const [first = "", second = ""] = words;

  return words.length > 1
    ? `${first.slice(0, 1)}${second.slice(0, 1)}`
    : first.slice(0, 2);
};

/** An avatar showing `name`'s initials. */
export const avatar = <Message>(
  h: HtmlBuilder<Message>,
  name: string,
  size: AvatarSize,
  tone: Tone
): Html =>
  h.span(
    [
      h.DataAttribute("slot", "avatar"),
      h.AriaHidden(true),
      h.Class(avatarClass(size, tone)),
    ],
    [initialsOf(name)]
  );

/** An avatar showing a glyph. */
export const glyphAvatar = <Message>(
  h: HtmlBuilder<Message>,
  glyph: Html,
  size: AvatarSize,
  tone: Tone
): Html =>
  h.span(
    [
      h.DataAttribute("slot", "avatar"),
      h.AriaHidden(true),
      h.Class(avatarClass(size, tone)),
    ],
    [glyph]
  );
