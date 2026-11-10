// The server's import graph, for the structural tests: what a module loads at run time (its value
// imports: `import type` and imports of types only are erased by Node's type stripping, so they
// load nothing), what an entry point's closure holds, and the graph between the top-level folders
// of `apps/server/src` with its cycles. Read from the source text, with no TypeScript parser: an
// import or re-export statement is `import ... from "<specifier>";` or `export ... from ...`, as
// oxfmt writes them.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** `apps/server/src`. */
export const SERVER_SOURCE = import.meta.dirname;

/** The repository root. */
export const REPO = path.join(SERVER_SOURCE, "..", "..", "..");

const STATEMENT =
  /^\s*(?<verb>import|export)\s+(?<type>type\s+)?(?<clause>[^;]*?)\s+from\s+"(?<specifier>[^"]+)";/gmu;

/** Whether an import clause names types only (`{ type A, type B }`), which loads nothing. */
const typesOnly = (clause: string) => {
  const names = /^\{(?<names>[^}]*)\}$/u.exec(clause.trim())?.groups?.names;

  if (names === undefined) {
    return false;
  }

  const named = names
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  return named.length > 0 && named.every((name) => name.startsWith("type "));
};

/** The file a specifier names: a relative path, or a `@cairn/<package>/<module>` import. */
const resolve = (from: string, specifier: string): string | undefined => {
  if (specifier.startsWith(".")) {
    return path.normalize(path.join(path.dirname(from), specifier));
  }

  const workspace = /^@cairn\/(?<pkg>[a-z-]+)\/(?<module>.+)$/u.exec(
    specifier
  )?.groups;

  if (workspace?.pkg === undefined || workspace.module === undefined) {
    return undefined;
  }

  return path.join(
    REPO,
    "packages",
    workspace.pkg,
    "src",
    `${workspace.module}.ts`
  );
};

/** The files `file` loads at run time from this repository, as absolute paths. */
export const valueImports = (file: string): ReadonlyArray<string> =>
  [...readFileSync(file, "utf-8").matchAll(STATEMENT)].flatMap((match) => {
    const { type, clause, specifier } = match.groups ?? {};

    if (
      type !== undefined ||
      clause === undefined ||
      specifier === undefined ||
      typesOnly(clause)
    ) {
      return [];
    }

    const target = resolve(file, specifier);

    return target === undefined ? [] : [target];
  });

/** Every `.ts` file under `directory` that is not a test. */
export const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(full);
    }

    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [full]
      : [];
  });

/** Every file `entry` loads at run time, itself included, with the file that first loaded each. */
export const closure = (entry: string): ReadonlyMap<string, string> => {
  const loadedBy = new Map<string, string>([[entry, entry]]);
  const pending = [entry];

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    for (const target of valueImports(file)) {
      if (!loadedBy.has(target)) {
        loadedBy.set(target, file);
        pending.push(target);
      }
    }
  }

  return loadedBy;
};

/**
 * Test doubles by name: a fake, a faux model, a fixture, a kit, a stub or mock, the scripted
 * harness, a dev-only layer or demo, the conformance suite, or a test.
 */
export const TEST_DOUBLE =
  /(?:Fake|Faux|Fixture|fixtures\/|Kit\.ts$|TestLayer|Stub|Mock|Scripted|\/Dev[A-Z]|Demo|conformance\/|\.test\.ts$)/u;

/** A server file's node in the folder graph: its top-level folder, or the file itself at the root. */
export const folderOf = (file: string) => {
  const relative = path.relative(SERVER_SOURCE, file);
  const [first, ...rest] = relative.split(path.sep);

  return rest.length === 0 ? relative : (first ?? relative);
};

/** One value import between two folders. */
export interface FolderEdge {
  readonly from: string;
  readonly to: string;
  readonly file: string;
  readonly target: string;
}

/** The value imports between top-level folders of `apps/server/src`, over `files`. */
export const folderEdges = (
  files: ReadonlyArray<string>
): ReadonlyArray<FolderEdge> =>
  files.flatMap((file) =>
    valueImports(file).flatMap((target) => {
      const from = folderOf(file);
      const to = folderOf(target);

      return target.startsWith(SERVER_SOURCE) && from !== to
        ? [
            {
              from,
              to,
              file: path.relative(SERVER_SOURCE, file),
              target: path.relative(SERVER_SOURCE, target),
            },
          ]
        : [];
    })
  );

/** The strongly connected components of more than one node (Tarjan), each sorted. */
export const cycles = (
  edges: ReadonlyArray<FolderEdge>
): ReadonlyArray<ReadonlyArray<string>> => {
  const next = new Map<string, Set<string>>();

  for (const edge of edges) {
    const targets = next.get(edge.from) ?? new Set<string>();

    targets.add(edge.to);
    next.set(edge.from, targets);
  }

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: Array<string> = [];
  const onStack = new Set<string>();
  const found: Array<ReadonlyArray<string>> = [];

  const visit = (node: string) => {
    index.set(node, index.size);
    low.set(node, index.size - 1);
    stack.push(node);
    onStack.add(node);

    for (const target of next.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(target) ?? 0));
      }
    }

    if (low.get(node) === index.get(node)) {
      const component: Array<string> = [];

      for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
        onStack.delete(top);
        component.push(top);

        if (top === node) {
          break;
        }
      }

      if (component.length > 1) {
        found.push(component.toSorted());
      }
    }
  };

  for (const node of next.keys()) {
    if (!index.has(node)) {
      visit(node);
    }
  }

  return found;
};
