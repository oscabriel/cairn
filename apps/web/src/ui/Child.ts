// The child a view helper accepts: an element (or nothing) or a text node. Foldkit builds these but
// does not export a name for them.
import type { Html } from "foldkit/html";

/** An element, nothing, or text. */
export type Child = Html | string;
