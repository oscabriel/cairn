// Draws a lucide icon (its node data from the `lucide` package) as Foldkit markup, with the
// attributes t3code's lucide-react icons carry, so class strings like `lucide lucide-brain` match.
import type { Html, HtmlBuilder } from "foldkit/html";

/** One lucide icon's nodes: element tags with their attributes. */
export type IconNode = ReadonlyArray<
  readonly [string, Readonly<Record<string, string | number | undefined>>]
>;

const attributesOf = <Message>(
  h: HtmlBuilder<Message>,
  attributes: Readonly<Record<string, string | number | undefined>>
) =>
  Object.entries(attributes).flatMap(([name, value]) =>
    value === undefined ? [] : [h.Attribute(name, String(value))]
  );

const child = <Message>(
  h: HtmlBuilder<Message>,
  tag: string,
  attributes: Readonly<Record<string, string | number | undefined>>
): Html => {
  const nodeAttributes = attributesOf(h, attributes);

  if (tag === "circle") {
    return h.circle(nodeAttributes);
  }

  if (tag === "ellipse") {
    return h.ellipse(nodeAttributes);
  }

  if (tag === "line") {
    return h.line(nodeAttributes);
  }

  if (tag === "polygon") {
    return h.polygon(nodeAttributes);
  }

  if (tag === "polyline") {
    return h.polyline(nodeAttributes);
  }

  return tag === "rect" ? h.rect(nodeAttributes) : h.path(nodeAttributes);
};

/**
 * The icon as an inline SVG. `name` is its lucide name (`chevron-down`), used for t3code's
 * `lucide lucide-<name>` classes; `className` is added after them. `hook` names a `data-<hook>`
 * attribute set to `true`, for t3code's `data-composer-control-icon` and chevron hooks.
 */
export const icon = <Message>(
  h: HtmlBuilder<Message>,
  node: IconNode,
  name: string,
  className: string,
  strokeWidth = 2,
  hook?: string
): Html =>
  h.svg(
    [
      ...(hook === undefined ? [] : [h.DataAttribute(hook, "true")]),
      h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
      h.Attribute("width", "24"),
      h.Attribute("height", "24"),
      h.Attribute("viewBox", "0 0 24 24"),
      h.Attribute("fill", "none"),
      h.Attribute("stroke", "currentColor"),
      h.Attribute("stroke-width", String(strokeWidth)),
      h.Attribute("stroke-linecap", "round"),
      h.Attribute("stroke-linejoin", "round"),
      h.Attribute("aria-hidden", "true"),
      h.Class(`lucide lucide-${name} ${className}`),
    ],
    node.map(([tag, attributes]) => child(h, tag, attributes))
  );
