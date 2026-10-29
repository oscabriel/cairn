// The machine edits of the phase 2 wizard's reach stage (ADR 0038, docs/phase-2/notes/reach.md R2),
// as pure text transforms the wizard shows as a diff before it applies each one:
//
//   node ops/wizards/reach-edits.ts <edit> <in> <out> [--snippets <dir>]
//
// Edits of the Caddyfile (`~/caddy/conf/Caddyfile`, the `*.gneiss.run` site):
// - `owner-only`: a site-level `forward_auth` to Cairn's `/_cairn/auth` for `plans.gneiss.run` and
//   every `<branch>--<project>` portal name, so artifacts and portals are the owner's alone. A
//   site-level directive runs before every `handle`, hand-written or porch's, so porch needs no
//   guard setting of its own.
// - `rename-plans`: the hand-written `@plans` matcher becomes `@owner_plans`. porch names its
//   artifacts porch `plans`, and two `@plans` matchers in one site do not validate. The
//   hand-written handle keeps serving the same folder with `Cache-Control: no-cache`; porch's
//   handle for the same host comes after it and is never reached.
// - `import`: porch's `porches.caddy` and `errors.caddy` above the site's final catch-all
//   `handle`, after every hand-written handle. Not `fallback.caddy`: the site has its own.
// - `stream-close-delay`: `stream_close_delay 5m` in every `reverse_proxy` of the handles that
//   carry WebSockets, so a reload no longer cuts them.
// Edits of other files:
// - `compose-mount`: porch's snippet folder mounted read-only at its own path in
//   `~/caddy/docker-compose.yml`, beside `./conf:/etc/caddy`.
// - `porch-ports`: porch's port range `[3100, 3699]` in its machine config, clear of the
//   hand-written dev table (3001 to 3032), Cairn's 3774 to 3777 and Executor's 4400.
//
// Every edit is idempotent: run on its own output it changes nothing and says so. An edit whose
// anchor is missing changes nothing and exits 2 with the reason; it never guesses. Exit 0 means
// `<out>` holds the result (equal to `<in>` when nothing was needed).

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { Predicate, Result, Schema } from "effect";

/** What one edit did. */
export interface Edited {
  readonly text: string;
  /** What changed or was already in place, one line each, for the wizard to print. */
  readonly notes: ReadonlyArray<string>;
}

/** The site every Caddyfile edit works inside. */
export const SITE = "*.gneiss.run";

/** The domain the owner-only matcher names. */
export const DOMAIN = "gneiss.run";

/** The handles that carry WebSockets (the reach note's list). */
export const WEBSOCKET_MATCHERS: ReadonlyArray<string> = [
  "cairn",
  "t3",
  "ha",
  "exec",
  "jellyfin",
  "immich",
];

/** The close delay added to each WebSocket proxy. */
export const STREAM_CLOSE_DELAY = "5m";

/** porch's port range for `porch run` dev porches. */
export const PORCH_PORTS: readonly [number, number] = [3100, 3699];

const OWNER_MATCHER = "@cairn_owner_only";

/** A line's brace balance, ignoring a trailing comment and backtick-quoted text. */
const braceDelta = (line: string) => {
  let delta = 0;
  let quoted = false;

  for (const char of line) {
    if (char === "`") {
      quoted = !quoted;
    } else if (!quoted && char === "#") {
      break;
    } else if (!quoted && char === "{") {
      delta += 1;
    } else if (!quoted && char === "}") {
      delta -= 1;
    }
  }

  return delta;
};

/** The index of the line that closes the block opened on `start`. */
const blockEnd = (lines: ReadonlyArray<string>, start: number) => {
  let depth = 0;

  for (let index = start; index < lines.length; index += 1) {
    depth += braceDelta(lines[index] ?? "");

    if (depth === 0) {
      return index;
    }
  }

  return -1;
};

const indentOf = (line: string) => /^\s*/u.exec(line)?.[0] ?? "";

/** The site block's first and last line, found at the top level. */
const siteBlock = (lines: ReadonlyArray<string>) => {
  let depth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (
      depth === 0 &&
      line.trim().startsWith(`${SITE} `) &&
      line.trim().endsWith("{")
    ) {
      const end = blockEnd(lines, index);

      return end === -1
        ? Result.fail(
            `the ${SITE} block opened on line ${String(index + 1)} never closes`
          )
        : Result.succeed({ start: index, end });
    }

    depth += braceDelta(line);
  }

  return Result.fail(`no top-level "${SITE} {" block`);
};

/** The indentation of the site's own directives. */
const childIndent = (
  lines: ReadonlyArray<string>,
  start: number,
  end: number
) => {
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index] ?? "";

    if (line.trim() !== "") {
      return indentOf(line);
    }
  }

  return "\t";
};

const splitLines = (text: string) => text.split("\n");

/** The owner-only guard for artifacts and portals. */
export const ownerOnly = (text: string): Result.Result<Edited, string> => {
  if (text.includes(OWNER_MATCHER)) {
    return Result.succeed({
      text,
      notes: ["owner-only guard already in place"],
    });
  }

  const lines = splitLines(text);

  return Result.map(siteBlock(lines), ({ start, end }) => {
    const indent = childIndent(lines, start, end);
    const escaped = DOMAIN.replaceAll(".", "\\\\.");

    const guard = [
      `${indent}# Cairn (ADR 0038): artifacts and portals are the owner's alone. A site-level`,
      `${indent}# forward_auth runs before every handle below, hand-written or porch's.`,
      `${indent}${OWNER_MATCHER} expression \`{host} == 'plans.${DOMAIN}' || {host}.matches('^[a-z0-9-]+--[a-z0-9-]+\\\\.${escaped}$')\``,
      `${indent}forward_auth ${OWNER_MATCHER} 127.0.0.1:3774 {`,
      `${indent}\turi /_cairn/auth`,
      `${indent}\theader_up X-Cairn-Peer {remote_host}`,
      `${indent}\tlb_try_duration 3s`,
      `${indent}\tlb_try_interval 250ms`,
      `${indent}}`,
      "",
    ];

    return {
      text: [
        ...lines.slice(0, start + 1),
        ...guard,
        ...lines.slice(start + 1),
      ].join("\n"),
      notes: [`owner-only guard for plans.${DOMAIN} and *--*.${DOMAIN}`],
    };
  });
};

/** Renames the hand-written `@plans` matcher so porch's artifacts porch can be imported. */
export const renamePlans = (text: string): Result.Result<Edited, string> => {
  const definition = /^(?<indent>\s*)@plans(?<rest>\s+host\s+plans\.\S+\s*)$/mu;
  const handle = /^(?<indent>\s*)handle\s+@plans(?<rest>\s*\{\s*)$/mu;

  if (!definition.test(text) && !handle.test(text)) {
    return /@plans\b/u.test(text)
      ? Result.fail(
          "@plans appears in a form this edit does not know; rename it by hand"
        )
      : Result.succeed({ text, notes: ["no hand-written @plans matcher"] });
  }

  const renamed = text
    .replace(definition, "$<indent>@owner_plans$<rest>")
    .replace(handle, "$<indent>handle @owner_plans$<rest>");

  if (/@plans\b/u.test(renamed)) {
    return Result.fail(
      "@plans is still used after the rename; rename it by hand"
    );
  }

  return Result.succeed({
    text: renamed,
    notes: [
      "@plans is now @owner_plans (porch's artifacts porch is named plans)",
    ],
  });
};

/** porch's snippet imports above the site's final catch-all `handle`. */
export const importPorch = (
  text: string,
  snippets: string
): Result.Result<Edited, string> => {
  const porches = `import ${snippets}/porches.caddy`;

  if (text.includes(porches)) {
    return Result.succeed({
      text,
      notes: ["porch's snippet already imported"],
    });
  }

  const lines = splitLines(text);

  return Result.flatMap(siteBlock(lines), ({ start, end }) => {
    const indent = childIndent(lines, start, end);
    let catchAll = -1;

    for (let index = start + 1; index < end; index += 1) {
      if (lines[index] === `${indent}handle {`) {
        catchAll = index;
      }
    }

    if (catchAll === -1) {
      return Result.fail(`no catch-all "handle {" in the ${SITE} block`);
    }

    const imports = [
      `${indent}# porch (ADR 0038): its porches and their dark page, after every hand-written handle.`,
      `${indent}${porches}`,
      `${indent}import ${snippets}/errors.caddy`,
      "",
    ];

    return Result.succeed({
      text: [
        ...lines.slice(0, catchAll),
        ...imports,
        ...lines.slice(catchAll),
      ].join("\n"),
      notes: [
        `porches.caddy and errors.caddy imported before line ${String(catchAll + 1)}`,
      ],
    });
  });
};

/** `stream_close_delay` in every `reverse_proxy` of the WebSocket handles. */
export const streamCloseDelay = (
  text: string,
  matchers: ReadonlyArray<string> = WEBSOCKET_MATCHERS
): Result.Result<Edited, string> => {
  const lines = splitLines(text);

  return Result.map(siteBlock(lines), ({ start, end }) => {
    const out = [...lines];
    const notes: Array<string> = [];
    // Inserting shifts later lines, so the handles are edited from the last to the first.
    const handles: Array<{ readonly name: string; readonly at: number }> = [];

    for (let index = start + 1; index < end; index += 1) {
      const match = /^\s*handle\s+@(?<name>[A-Za-z0-9_-]+)\s*\{\s*$/u.exec(
        lines[index] ?? ""
      );

      const name = match?.groups?.name;

      if (name !== undefined && matchers.includes(name)) {
        handles.push({ name, at: index });
      }
    }

    for (const handle of handles.toReversed()) {
      const close = blockEnd(out, handle.at);
      let added = 0;
      let present = 0;

      for (let index = close - 1; index > handle.at; index -= 1) {
        const line = out[index] ?? "";

        if (!/^\s*reverse_proxy\b/u.test(line)) {
          continue;
        }

        const indent = indentOf(line);

        if (line.trimEnd().endsWith("{")) {
          const proxyEnd = blockEnd(out, index);
          const body = out.slice(index + 1, proxyEnd);

          if (body.some((inner) => /^\s*stream_close_delay\b/u.test(inner))) {
            present += 1;
          } else {
            out.splice(
              index + 1,
              0,
              `${indent}\tstream_close_delay ${STREAM_CLOSE_DELAY}`
            );
            added += 1;
          }
        } else {
          out.splice(
            index,
            1,
            `${line.trimEnd()} {`,
            `${indent}\tstream_close_delay ${STREAM_CLOSE_DELAY}`,
            `${indent}}`
          );
          added += 1;
        }
      }

      if (added + present === 0) {
        notes.push(`@${handle.name}: no reverse_proxy in its handle, skipped`);
      } else {
        notes.push(
          `@${handle.name}: ${String(added)} added, ${String(present)} already set`
        );
      }
    }

    for (const missing of matchers.filter(
      (name) => !handles.some((handle) => handle.name === name)
    )) {
      notes.unshift(`@${missing}: no handle in the ${SITE} block, skipped`);
    }

    return { text: out.join("\n"), notes: notes.toReversed() };
  });
};

/** porch's snippet folder mounted read-only into the Caddy container at its own path. */
export const composeMount = (
  text: string,
  snippets: string
): Result.Result<Edited, string> => {
  if (text.includes(`${snippets}:${snippets}`)) {
    return Result.succeed({
      text,
      notes: ["the snippet folder is already mounted"],
    });
  }

  const lines = splitLines(text);

  const conf = lines.findIndex((line) =>
    /^\s*-\s*["']?\.\/conf:\/etc\/caddy/u.test(line)
  );

  if (conf === -1) {
    return Result.fail('no "- ./conf:/etc/caddy" volume line');
  }

  const indent =
    /^(?<indent>\s*-\s*)/u.exec(lines[conf] ?? "")?.groups?.indent ??
    "      - ";

  return Result.succeed({
    text: [
      ...lines.slice(0, conf + 1),
      `${indent}${snippets}:${snippets}:ro`,
      ...lines.slice(conf + 1),
    ].join("\n"),
    notes: [`${snippets} mounted read-only beside ./conf`],
  });
};

const PorchConfig = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Json)
);

const decodePorchConfig = Schema.decodeResult(PorchConfig);

/** porch's dev port range in its machine config. */
export const porchPorts = (text: string): Result.Result<Edited, string> =>
  Result.flatMap(
    Result.mapError(
      decodePorchConfig(text),
      (failure) => `porch's config is not JSON: ${failure.message}`
    ),
    (config) => {
      const { ports } = config;

      const current =
        Predicate.isObject(ports) && !Array.isArray(ports) ? ports.range : null;

      if (
        Array.isArray(current) &&
        current[0] === PORCH_PORTS[0] &&
        current[1] === PORCH_PORTS[1]
      ) {
        return Result.succeed({
          text,
          notes: ["porch's port range is already 3100 to 3699"],
        });
      }

      const next = {
        ...config,
        ports: { range: [PORCH_PORTS[0], PORCH_PORTS[1]] },
      };

      return Result.succeed({
        text: `${JSON.stringify(next, null, "\t")}\n`,
        notes: [
          `porch's port range set to ${String(PORCH_PORTS[0])} to ${String(PORCH_PORTS[1])}`,
        ],
      });
    }
  );

const EDITS = [
  "owner-only",
  "rename-plans",
  "import",
  "stream-close-delay",
  "compose-mount",
  "porch-ports",
] as const;

const run = (edit: string, text: string, snippets: string) => {
  switch (edit) {
    case "owner-only": {
      return ownerOnly(text);
    }

    case "rename-plans": {
      return renamePlans(text);
    }

    case "import": {
      return importPorch(text, snippets);
    }

    case "stream-close-delay": {
      return streamCloseDelay(text);
    }

    case "compose-mount": {
      return composeMount(text, snippets);
    }

    case "porch-ports": {
      return porchPorts(text);
    }

    default: {
      return Result.fail(`unknown edit ${edit}; one of ${EDITS.join(", ")}`);
    }
  }
};

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { snippets: { type: "string", default: "" } },
  });

  const [edit = "", input = "", output = ""] = positionals;
  const needsSnippets = edit === "import" || edit === "compose-mount";

  if (
    input === "" ||
    output === "" ||
    (needsSnippets && values.snippets === "")
  ) {
    process.stderr.write(
      "usage: node ops/wizards/reach-edits.ts <edit> <in> <out> [--snippets <dir>]\n"
    );
    process.exitCode = 2;
  } else {
    const result = run(edit, readFileSync(input, "utf-8"), values.snippets);

    if (Result.isFailure(result)) {
      process.stderr.write(`${edit}: ${result.failure}\n`);
      process.exitCode = 2;
    } else {
      writeFileSync(output, result.success.text);

      for (const note of result.success.notes) {
        process.stdout.write(`${note}\n`);
      }
    }
  }
}
