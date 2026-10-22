// Joins class strings, skipping empty ones, so a primitive's base, variant, size and caller classes
// read as one list. Unlike t3code's `cn` there is no tailwind-merge: callers add classes, they do
// not override a primitive's own.

/** One class string, or none when a condition left it out. */
export type ClassPart = string | false;

/** The parts joined with single spaces, empty and left-out parts dropped. */
export const classNames = (...parts: ReadonlyArray<ClassPart>): string =>
  parts
    .filter((part): part is string => part !== false && part !== "")
    .join(" ");
