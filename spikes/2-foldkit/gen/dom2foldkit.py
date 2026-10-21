"""Spike 2: turn a captured t3code DOM subtree into Foldkit view code with the same tags, classes and attributes.

    python3 gen/dom2foldkit.py <page.html> <attr>=<value>[&&<attr>=<value>] [--nth N] [--name fn] [--params "a: A"]
        [--slot <attr>=<value>[&&...]=<expr>]...  replace the first matching descendant with a TS expression
        [--text <literal>=<expr>]...              replace text and attribute values containing <literal>
                                                  (a leading ~ limits it to text nodes)

Selects the Nth element whose attributes all match, and prints `export const <fn> = (h, ...params) => ...`.
"""
import json, sys
from html.parser import HTMLParser

VOID = {"area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"}
SVG_SELF = {"path","circle","rect","line","polyline","polygon","stop","use","ellipse"}
SKIP_ATTR_PREFIX = ("data-base-ui","data-radix")
SKIP_ATTR = {"id","aria-describedby","aria-controls","aria-labelledby","tabindex","data-react-aria-pressable"}

class Node:
    def __init__(s, tag, attrs, parent):
        s.tag, s.attrs, s.parent, s.children = tag, attrs, parent, []

class P(HTMLParser):
    def __init__(s):
        super().__init__(convert_charrefs=True)
        s.root = Node("root", {}, None); s.cur = s.root; s.skip = 0
    def handle_starttag(s, tag, attrs):
        if tag in ("script","style","head"): s.skip += 1
        if s.skip: return
        n = Node(tag, dict(attrs), s.cur); s.cur.children.append(n)
        if tag not in VOID and tag not in SVG_SELF: s.cur = n
    def handle_startendtag(s, tag, attrs):
        if s.skip: return
        s.cur.children.append(Node(tag, dict(attrs), s.cur))
    def handle_endtag(s, tag):
        if tag in ("script","style","head"): s.skip -= 1; return
        if s.skip or tag in VOID or tag in SVG_SELF: return
        n = s.cur
        while n is not s.root and n.tag != tag: n = n.parent
        if n is not s.root: s.cur = n.parent
    def handle_data(s, data):
        if s.skip: return
        if data.strip(): s.cur.children.append(data)

def find(node, want, out):
    if isinstance(node, str): return
    if node.tag != "root" and all(node.attrs.get(k) == v for k, v in want.items()): out.append(node)
    for c in node.children: find(c, want, out)

ATTR_FN = {"class": "Class", "aria-label": "AriaLabel", "role": "Role", "type": "Type", "placeholder": "Placeholder", "title": "Title"}

# html.parser lowercases names; SVG's are case-sensitive.
SVG_ATTRS = {a.lower(): a for a in ["viewBox","textLength","lengthAdjust","preserveAspectRatio","gradientUnits","gradientTransform","stdDeviation","patternUnits","patternTransform","clipPathUnits","maskUnits","maskContentUnits","filterUnits","primitiveUnits","baseFrequency","numOctaves","stitchTiles","kernelMatrix","tableValues","spreadMethod","startOffset","markerWidth","markerHeight","refX","refY","pathLength","attributeName","repeatCount","keyTimes","keySplines","calcMode","floodColor","floodOpacity","stopColor","stopOpacity"]}
SVG_TAGS = {t.lower(): t for t in ["linearGradient","radialGradient","clipPath","feGaussianBlur","feColorMatrix","feTurbulence","feBlend","feOffset","feMerge","feMergeNode","feFlood","feComposite","feDisplacementMap","feMorphology","feDropShadow","foreignObject","textPath","animateTransform","animateMotion","feComponentTransfer","feFuncA","feFuncR","feFuncG","feFuncB","feImage","feTile","feSpecularLighting","feDiffuseLighting","fePointLight","feDistantLight","feSpotLight","feConvolveMatrix"]}
TEXT = []
SLOTS = []

def lit(v, text=False):
    hits = [(a.lstrip("~"), e) for a, e in TEXT if (text or not a.startswith("~")) and a.lstrip("~") in v]
    if not hits: return json.dumps(v)
    out = v.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
    for a, e in hits: out = out.replace(a, "${" + e + "}")
    return "`" + out + "`"

def parse_want(spec):
    want = {}
    for part in spec.split("&&"):
        k, v = part.split("=", 1); want[k] = v
    return want

def matches(node, want):
    return not isinstance(node, str) and all(node.attrs.get(k) == v for k, v in want.items())

def attr_code(k, v):
    if k == "style":
        decls = {}
        for part in v.split(";"):
            if ":" in part:
                a, b = part.split(":", 1); decls[a.strip()] = b.strip()
        return f"h.Style({json.dumps(decls)})"
    if k in ATTR_FN and not k.startswith("data-"): return f"h.{ATTR_FN[k]}({lit(v)})"
    if k.startswith("data-"): return f"h.DataAttribute({json.dumps(k[5:])}, {lit(v)})"
    return f"h.Attribute({json.dumps(SVG_ATTRS.get(k, k))}, {lit(v)})"

def ancestors(node):
    n = node.parent
    while n is not None:
        yield n
        n = n.parent

def emit(node, depth):
    pad = "  " * depth
    if isinstance(node, str):
        text = " ".join(node.split())
        if node[:1].isspace(): text = " " + text
        if node[-1:].isspace(): text = text + " "
        return pad + lit(text, text=True)
    for slot in SLOTS:
        if not slot[2] and matches(node, slot[0]):
            slot[2] = True
            return pad + slot[1]
    in_svg = node.tag == "svg" or any(a.tag == "svg" for a in ancestors(node))
    attrs = [attr_code(k, v) for k, v in node.attrs.items() if v is not None and (k not in SKIP_ATTR or (k == "id" and in_svg)) and not k.startswith(SKIP_ATTR_PREFIX)]
    kids = [emit(c, depth + 1) for c in node.children]
    a = "[" + ", ".join(attrs) + "]"
    tag = SVG_TAGS.get(node.tag, node.tag)
    if tag in VOID or tag == "textarea": return f"{pad}h.{tag}({a})"
    if not kids: return f"{pad}h.{tag}({a}, [])"
    return f"{pad}h.{tag}({a}, [\n" + ",\n".join(kids) + f",\n{pad}])"

args = sys.argv[1:]; page = args.pop(0); nth = 0; name = "fragment"; want = {}; params = ""
while args:
    a = args.pop(0)
    if a == "--nth": nth = int(args.pop(0))
    elif a == "--name": name = args.pop(0)
    elif a == "--params": params = ", " + args.pop(0)
    elif a == "--slot":
        spec, expr = args.pop(0).rsplit("=", 1); SLOTS.append([parse_want(spec), expr, False])
    elif a == "--text":
        l, e = args.pop(0).split("=", 1); TEXT.append((l, e))
    else: want = parse_want(a)
p = P(); p.feed(open(page).read())
hits = []; find(p.root, want, hits)
if len(hits) <= nth: sys.exit(f"{len(hits)} matches for {want}")
body = emit(hits[nth], 1)
missing = [s[1] for s in SLOTS if not s[2]]
if missing: sys.exit(f"slots not found: {missing}")
print(f"export const {name} = <M>(h: HtmlBuilder<M>{params}): Html =>\n" + body + "\n")
