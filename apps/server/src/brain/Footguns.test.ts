// pi-durable's API footguns (its spec, section 12, at `packages/durable/docs/spec.md` in the pi
// clone; docs/phase-1/notes/brain.md, "Footguns") held as pins over the source of every server
// module, not only `brain/`: phase 2 commits from `subagents/`, `approvals/`, `workflows/`,
// `verdicts/` and `models/ResultTool.ts` too (S42's folders), so the whole of `apps/server/src` is
// scanned.
//
// A commit body is any code that runs on a commit's line: a `commit(` call's callback (inline, or
// passed by a name the module declares), a callback passed inline to a commit wrapper
// (`io.commitDocs(`, any `commit…(` call), and every function whose first parameter is typed `Tx`
// (`meterCommit(tx, …)` and the other helpers given the transaction). Each rule a scan can pin:
//
// - Reads inside a commit: nothing in a commit body reads through the Session, the Harness or the
//   runtime (`snapshot`, `documentState`, `watchDoc`, `getTask`, `waitForTask`, `inspect`,
//   `conversation`, the scans) on any receiver but its transaction (`harness.`, `api?.`,
//   `brain().` alike): such a read can queue on the line the body holds and hang.
// - Long transactions: every `await` in a commit body is a call on the transaction, a helper given
//   it as its first argument, one of the body's own async functions, or a combinator over such
//   work, and no commit nests another.
// - Detached draft work: no fire-and-forget (`void`, `.then(`, a timer, a fork) in a commit body.
// - Writing to a busy conversation, and raw head writes into the past: a raw `appendEntry(` on a
//   transaction (`tx`, or the name a commit body gives it) is allowed only at the reviewed sites in
//   `RAW_APPENDS`, each guarded by hand against a live run.
// - Hook memo names: every `memo(` name carries a namespace prefix (`cairn.`).
// - Checkpoint starvation: `checkpointWhen: () => false` only on the reviewed documents in
//   `NEVER_CHECKPOINTED`, each tiny and written once.
// - Guards left out of a selection: no array `extensions: [` selection.
// - Selection edits and copies: no `{ add, remove }` `extensions: {` selection either; guards and
//   tools stay in the host default.
// - Reserved `pi.` names: no Cairn document, entry or task kind starts with `pi.`.
//
// Pinned elsewhere: wall clock in prompt text ("Unstable prompt text", S8) by the lint rule
// `automation/no-ambient-nondeterminism`; a reactor handler's commit rules by
// `ReactorFootguns.test.ts`; queued items after a failed run by the conformance scenario
// `failed_run_keeps_queue`; buffered watches by the `skip_snapshot` mutation and
// `one_subscription_past_100_entries`; fatal storage errors by `Brain.test.ts`.
//
// No scan can pin these, since each is about behaviour or data flow, not a call's shape: work
// reached from a commit body through a helper that is not given the transaction as its first
// parameter (it may read, await or fork unseen), read after write (the 1.5 `Tx` has no table
// API), compaction spend, heads and edits during compaction, summary timestamps, double-counted
// subagent spend, owned work holding its owner, work created by hooks, compensation in abort
// handlers, explicit creation, family initialization, wrong fork setting, schema stability (a kind
// may be retired on purpose), trusted immutable revisions, watch activation, watch stop, durable
// progress cadence, large terminal results, raw transcript, early resource disposal, copies are
// one-time, environment on recovery (T40), moving default selections, non-cooperative code at
// close (third-party pi-host tools), objects outliving the Harness, and JSONL durability.
//
// The checks are first shown to catch planted violations, then run over every server module.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

/** Session, Harness and runtime reads that may queue on the line a commit holds. */
const SESSION_READS = [
  "snapshot",
  "documentState",
  "watchDoc",
  "getTask",
  "waitForTask",
  "inspect",
  "conversation",
  "scanConversations",
  "scanEntries",
  "scanTasks",
  "latestEntryId",
  "submissionByRequest",
];

/** Fire-and-forget forms that outlive the commit callback they start in. */
const DETACHED = [
  /\bvoid\s+[\w(]/u,
  /\.then\(/u,
  /\bsetTimeout\(/u,
  /\bqueueMicrotask\(/u,
  /\brunFork\(/u,
];

/**
 * The reviewed raw `tx.appendEntry(` sites, by module and count. Each writes where no generation
 * can be preparing a request, or writes nothing the model reads, and checks by hand what a write
 * submission would; a new site is reviewed against "Writing to a busy conversation" and "Raw head
 * writes into the past", then added here.
 */
const RAW_APPENDS = {
  // The event log's own conversations, which never run.
  "brain/Events.ts": 2,
  // A note, and the queued writes ahead of it, placed only while no run is live; a queued write's
  // head is checked for staleness first, as a write submission's is.
  "brain/NoteAdmission.ts": 2,
  // A display-only budget notice (no model content), held back behind a queued reset.
  "usage/BudgetSources.ts": 1,
  // A display-only workflow budget notice, guarded the same way.
  "workflows/WorkflowBudget.ts": 1,
} satisfies Readonly<Record<string, number>>;

/**
 * The reviewed documents that never checkpoint, by module and count: each is tiny and written
 * once, so its replay cannot grow.
 */
const NEVER_CHECKPOINTED = {
  "brain/CairnDocs.ts": 2,
  "models/ResultTool.ts": 2,
} satisfies Readonly<Record<string, number>>;

/** The source with comments blanked (same length), so a match is code, not prose. */
const codeOf = (source: string) =>
  source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, (match) => " ".repeat(match.length))
    .replaceAll(/(?<!:)\/\/.*$/gmu, (match) => " ".repeat(match.length));

/** The end of the balanced parenthesis group opening at `open`. */
const closing = (source: string, open: number) => {
  let depth = 0;

  for (let at = open; at < source.length; at += 1) {
    const char = source[at];

    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;

      if (depth === 0) {
        return at;
      }
    }
  }

  return source.length - 1;
};

/** The end of the balanced brace block opening at `open`. */
const blockEnd = (source: string, open: number) => {
  let depth = 0;

  for (let at = open; at < source.length; at += 1) {
    const char = source[at];

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return at;
      }
    }
  }

  return source.length - 1;
};

const OPENERS = new Set(["(", "[", "{"]);

const CLOSERS = new Set([")", "]", "}"]);

/** An arrow's expression body from `start`: up to the end of its statement or argument. */
const expressionAt = (source: string, start: number) => {
  let depth = 0;

  for (let at = start; at < source.length; at += 1) {
    const char = source[at] ?? "";

    if (OPENERS.has(char)) {
      depth += 1;
    } else if (CLOSERS.has(char)) {
      if (depth === 0) {
        return source.slice(start, at);
      }

      depth -= 1;
    } else if (depth === 0 && (char === ";" || char === ",")) {
      return source.slice(start, at);
    }
  }

  return source.slice(start);
};

/**
 * The body of the function whose parameter list closes at `close`, past any return type: a block,
 * or an arrow's expression; none for a signature without one (an interface's method).
 */
const bodyAfter = (source: string, close: number): Option.Option<string> => {
  let angle = 0;

  for (let at = close + 1; at < source.length; at += 1) {
    const char = source[at];

    if (angle === 0 && source.startsWith("=>", at)) {
      const start = at + 2 + Math.max(0, source.slice(at + 2).search(/\S/u));

      return Option.some(
        source[start] === "{"
          ? source.slice(start, blockEnd(source, start) + 1)
          : expressionAt(source, start)
      );
    }

    if (char === "<") {
      angle += 1;
    } else if (char === ">") {
      angle -= 1;
    } else if (angle === 0 && char === "{") {
      return Option.some(source.slice(at, blockEnd(source, at) + 1));
    } else if (angle === 0 && (char === ";" || char === "," || char === ")")) {
      return Option.none();
    }
  }

  return Option.none();
};

/** One body that runs on a commit's line: where its parameters open, its text and its `tx`. */
interface CommitBody {
  readonly at: number;
  readonly text: string;
  readonly tx: string;
}

/** A callback's first parameter: `async (tx) =>`, `(tx: Tx) =>`, `async function (tx)`. */
const FIRST_PARAM =
  /^\s*(?:async\s+)?(?:function\s*[\w$]*\s*)?\(\s*(?<tx>[\w$]+)/u;

const escape = (text: string) => text.replaceAll(/[$]/gu, String.raw`\$`);

/** The function whose text starts at `start`, as a commit body; none when no function starts there. */
const functionAt = (
  source: string,
  start: number
): Option.Option<CommitBody> => {
  const head = FIRST_PARAM.exec(source.slice(start));
  const tx = head?.groups?.tx;

  if (head === null || tx === undefined) {
    return Option.none();
  }

  const at = start + head[0].lastIndexOf("(");

  return Option.map(bodyAfter(source, closing(source, at)), (text) => ({
    at,
    text,
    tx,
  }));
};

/** The callback a `commit(` call is passed by name, as the module declares it. */
const namedCallback = (
  source: string,
  args: string
): Option.Option<CommitBody> => {
  const named = /^\s*(?<name>[\w$]+)\s*,/u.exec(args)?.groups?.name;

  if (named === undefined) {
    return Option.none();
  }

  const declared = new RegExp(
    String.raw`const\s+${escape(named)}\s*(?::[^=]*)?=|(?:async\s+)?function\s+${escape(named)}\b`,
    "u"
  ).exec(source);

  if (declared === null) {
    return Option.none();
  }

  return functionAt(
    source,
    declared[0].startsWith("const")
      ? declared.index + declared[0].length
      : declared.index
  );
};

/**
 * Every body that runs inside a commit, each once:
 * - each `commit(` call's callback, inline or passed by a name the module declares;
 * - each callback passed inline to a commit wrapper (`io.commitDocs(`, any `commit…(` call);
 * - each function whose first parameter is typed `Tx` (`meterCommit(tx, …)`): a helper given the
 *   transaction runs on the commit's line as its caller does.
 */
const commitBodies = (source: string): ReadonlyArray<CommitBody> => {
  const calls = [...source.matchAll(/\.commit\(|\bcommit[A-Z][\w$]*\(/gu)]
    .filter(
      (match) =>
        !/\bfunction\s+$/u.test(
          source.slice(Math.max(0, match.index - 16), match.index)
        )
    )
    .flatMap((match) => {
      const open = match.index + match[0].length - 1;
      const inline = functionAt(source, open + 1);

      if (Option.isSome(inline) || match[0] !== ".commit(") {
        return Option.toArray(inline);
      }

      const args = source.slice(open + 1, closing(source, open));

      return [
        Option.getOrElse(namedCallback(source, args), () => ({
          at: open,
          text: args,
          tx: "tx",
        })),
      ];
    });

  const helpers = [
    ...source.matchAll(/\(\s*(?<tx>[\w$]+)\s*:\s*Tx\b/gu),
  ].flatMap((match) =>
    Option.toArray(
      Option.map(bodyAfter(source, closing(source, match.index)), (text) => ({
        at: match.index,
        text,
        tx: match.groups?.tx ?? "tx",
      }))
    )
  );

  const seen = new Set<number>();

  return [...calls, ...helpers].filter((body) => {
    if (seen.has(body.at)) {
      return false;
    }

    seen.add(body.at);

    return true;
  });
};

/** Awaited expressions that only combine other work: a conditional, `Promise.all`, `Option.match`. */
const COMBINATOR = /^(?:\(|Promise\.all\(|Option\.match\()/u;

/** Every commit-body footgun in one module's code, described. */
const commitFootguns = (code: string): ReadonlyArray<string> => {
  const found: Array<string> = [];

  for (const { text, tx } of commitBodies(code)) {
    // A read on any receiver but the transaction: `harness.`, `api?.`, `brain().`.
    const reads = new RegExp(
      String.raw`(?<receiver>[\w$]*)(?<call>[)\]]?)\s*\??\.\s*(?<read>${SESSION_READS.join("|")})\(`,
      "gu"
    );

    for (const read of text.matchAll(reads)) {
      if (read.groups?.receiver !== tx || read.groups.call !== "") {
        found.push(`calls ${read.groups?.read ?? ""} inside a commit`);
      }
    }

    // Async functions the body declares (a paging `scan` over `tx`): their own text is part of the
    // body, so their awaits are checked here too.
    const locals = [
      ...text.matchAll(
        /(?:const\s+(?<arrow>[\w$]+)\s*(?::[^=]*)?=\s*async\b|async\s+function\s+(?<declared>[\w$]+))/gu
      ),
    ].map((local) => local.groups?.arrow ?? local.groups?.declared ?? "");

    // An awaited expression that stays on the commit's line: `tx.…`, `helper(tx, …)` (also
    // `conversation?.submit(tx, …)`), a call of one of the body's own async functions, a resolved
    // value, or a combinator over `tx` work (a conditional, `Promise.all`, `Option.match`), whose
    // own inner awaits are checked in turn.
    const onTx = new RegExp(
      String.raw`^(?:${escape(tx)}\??\.|[\w$.?]+\(\s*${escape(tx)}\b|Promise\.resolve\(${locals.map((local) => String.raw`|${escape(local)}\(`).join("")})`,
      "u"
    );

    const usesTx = new RegExp(String.raw`\b${escape(tx)}\b`, "u");

    const isOnTx = (awaited: string) =>
      onTx.test(awaited) || (COMBINATOR.test(awaited) && usesTx.test(awaited));

    for (const match of text.matchAll(/\bawait\s+(?=(?<awaited>[^;]*))/gu)) {
      const awaited = match.groups?.awaited ?? "";

      if (!isOnTx(awaited)) {
        found.push(
          `awaits ${(awaited.split("(")[0] ?? awaited).trim()} inside a commit`
        );
      }
    }

    if (text.includes(".commit(")) {
      found.push("nests a commit inside a commit");
    }

    for (const detached of DETACHED) {
      if (detached.test(text)) {
        found.push(`starts detached work (${detached.source}) inside a commit`);
      }
    }
  }

  return found;
};

/**
 * The leading text of a memo name: a literal's, or a constant's or a `name(…)` template's as
 * `source` declares it; none when `source` does not.
 */
const memoNameOf = (
  expression: string,
  source: string
): Option.Option<string> => {
  const literal = /^\s*["'`](?<text>[^"'`$]*)/u.exec(expression);

  if (literal?.groups?.text !== undefined) {
    return Option.some(literal.groups.text);
  }

  const name = /^\s*(?<name>[\w$]+)/u.exec(expression)?.groups?.name;

  if (name === undefined) {
    return Option.none();
  }

  const declared = new RegExp(
    String.raw`const\s+${escape(name)}\s*=\s*(?:\([^)]*\)\s*=>\s*)?["'\x60](?<text>[^"'\x60$]*)`,
    "u"
  ).exec(source);

  return Option.fromUndefinedOr(declared?.groups?.text);
};

/** Every footgun in one module, described; `others` are the other modules' sources. */
const footguns = (
  source: string,
  others: ReadonlyArray<string> = []
): ReadonlyArray<string> => {
  const code = codeOf(source);
  const found = [...commitFootguns(code)];

  if (/extensions:\s*\[/u.test(code)) {
    found.push("writes an array extension selection");
  }

  if (/extensions:\s*\{/u.test(code)) {
    found.push("writes an { add, remove } extension selection");
  }

  const kinds = [
    ...source.matchAll(
      /define(?:Doc|DocFamily|Task)\(\{[\s\S]*?(?:kind|name):\s*"(?<kind>[^"]+)"/gu
    ),
    ...source.matchAll(/defineEntry(?:<[^>]*>)?\(\s*"(?<kind>[^"]+)"/gu),
  ].map((match) => match.groups?.kind ?? "");

  for (const kind of kinds) {
    if (kind.startsWith("pi.")) {
      found.push(`defines the reserved kind ${kind}`);
    }
  }

  for (const match of code.matchAll(/\.memo(?:<[^>]*>)?\(/gu)) {
    const open = match.index + match[0].length - 1;
    const first = source.slice(open + 1, closing(source, open));

    const name = Option.firstSomeOf(
      [source, ...others].map((text) => memoNameOf(first, text))
    );

    if (!Option.exists(name, (text) => /^[a-z][\w-]*\./u.test(text))) {
      found.push(
        `names a memo without a namespace prefix (${first.split(",")[0]?.trim() ?? first})`
      );
    }
  }

  return found;
};

/** How many times `pattern` occurs in a module's code. */
const count = (source: string, pattern: RegExp) =>
  [...codeOf(source).matchAll(pattern)].length;

/**
 * How many raw `appendEntry(` calls a module makes on a transaction: on `tx`, or on whatever name
 * a commit body there gives it.
 */
const rawAppends = (source: string) => {
  const names = new Set([
    "tx",
    ...commitBodies(codeOf(source)).map((body) => body.tx),
  ]);

  return count(
    source,
    new RegExp(
      String.raw`(?<![\w$.])(?:${[...names].map(escape).join("|")})\s*\??\.\s*appendEntry\(`,
      "gu"
    )
  );
};

const NEVER_CHECKPOINT = /checkpointWhen:\s*\(\)\s*=>\s*false/gu;

const SERVER = path.resolve(import.meta.dirname, "..");

const serverModules = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);

    if (statSync(full).isDirectory()) {
      return name === "node_modules" ? [] : serverModules(full);
    }

    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });

/** Modules by their path under `apps/server/src`, with their source. */
const modules = new Map(
  serverModules(SERVER).map((module) => [
    path.relative(SERVER, module),
    readFileSync(module, "utf-8"),
  ])
);

/** The modules where `counted` finds something, with their counts. */
const sites = (counted: (source: string) => number) =>
  Object.fromEntries(
    [...modules].flatMap(([name, source]) => {
      const found = counted(source);

      return found > 0 ? [[name, found] as const] : [];
    })
  );

describe("pi-durable footguns", () => {
  it("catches each footgun when it is planted", () => {
    assert.deepStrictEqual(
      footguns(
        "await harness.commit(async (tx) => { await harness.snapshot(Doc, ctx); }, ctx);"
      ),
      [
        "calls snapshot inside a commit",
        "awaits harness.snapshot inside a commit",
      ]
    );
    assert.deepStrictEqual(
      footguns(
        "await runtime.commit(async (t) => { const task = await runtime.waitForTask(id, ctx); }, ctx);"
      ),
      [
        "calls waitForTask inside a commit",
        "awaits runtime.waitForTask inside a commit",
      ]
    );
    assert.deepStrictEqual(
      footguns(
        "await harness.commit(async (tx) => { await fetch(url); await harness.commit(async (inner) => {}, ctx); }, ctx);"
      ),
      [
        "awaits fetch inside a commit",
        "awaits harness.commit inside a commit",
        "nests a commit inside a commit",
      ]
    );
    // A combinator passes only over `tx` work, and its inner awaits are checked in turn.
    assert.deepStrictEqual(
      footguns(
        "await harness.commit(async (tx) => { await Promise.all([fetch(a), fetch(b)]); await Promise.all(ids.map(async (id) => await fetch(id, tx))); }, ctx);"
      ),
      ["awaits Promise.all inside a commit", "awaits fetch inside a commit"]
    );
    assert.deepStrictEqual(
      footguns("await harness.commit(async (tx) => { void tx.doc(D); }, ctx);"),
      [String.raw`starts detached work (\bvoid\s+[\w(]) inside a commit`]
    );
    assert.deepStrictEqual(
      footguns(
        "const change = async (tx) => { await session.harness.inspect(ctx); };\nawait runtime.commit(change, ctx);"
      ),
      [
        "calls inspect inside a commit",
        "awaits session.harness.inspect inside a commit",
      ]
    );
    // A callback handed to a commit wrapper (`io.commitDocs(`) is a commit body.
    assert.deepStrictEqual(
      footguns(
        "await io.commitDocs(async (tx) => { await session.harness.snapshot(Approvals, child, ctx); void fetch(url); });"
      ),
      [
        "calls snapshot inside a commit",
        "awaits session.harness.snapshot inside a commit",
        String.raw`starts detached work (\bvoid\s+[\w(]) inside a commit`,
      ]
    );
    // So is every function whose first parameter is the transaction: it runs inside a commit.
    assert.deepStrictEqual(
      footguns(
        "export const meterCommit = async (\n  tx: Tx,\n  id: string\n): Promise<Option.Option<number>> => {\n  await session.harness.snapshot(Doc, ctx);\n  setTimeout(tick, 10);\n  return Option.none();\n};"
      ),
      [
        "calls snapshot inside a commit",
        "awaits session.harness.snapshot inside a commit",
        String.raw`starts detached work (\bsetTimeout\() inside a commit`,
      ]
    );
    assert.deepStrictEqual(
      footguns(
        "async function owned(tx: Tx, id: number) { const found = await harness.inspect(ctx); return found; }"
      ),
      [
        "calls inspect inside a commit",
        "awaits harness.inspect inside a commit",
      ]
    );
    // A function the body declares may be awaited; its own awaits are checked in turn.
    assert.deepStrictEqual(
      footguns(
        "const owned = async (tx: Tx, id: number) => { const scan = async (cursor) => { await fetch(id); const page = await tx.scanEntries({}, 10, cursor); return page.next === undefined ? page : await scan(page.next); }; return await scan(); };"
      ),
      ["awaits fetch inside a commit"]
    );
    // A read on any receiver but the transaction, through `?.` or a call's result too.
    assert.deepStrictEqual(
      footguns(
        "await harness.commit(async (tx) => { const p = brain().snapshot(Doc, ctx); return api?.snapshot(Doc, ctx); }, ctx);"
      ),
      ["calls snapshot inside a commit", "calls snapshot inside a commit"]
    );
    assert.deepStrictEqual(
      footguns("await conversation.configure({ extensions: [guard] }, ctx);"),
      ["writes an array extension selection"]
    );
    assert.deepStrictEqual(
      footguns(
        "await conversation.configure({ extensions: { add: [tool], remove: [] } }, ctx);"
      ),
      ["writes an { add, remove } extension selection"]
    );
    assert.deepStrictEqual(
      footguns('const D = defineDoc({ kind: "pi.mine", version: 1 });'),
      ["defines the reserved kind pi.mine"]
    );
    assert.deepStrictEqual(footguns('const E = defineEntry("pi.note");'), [
      "defines the reserved kind pi.note",
    ]);
    assert.deepStrictEqual(
      footguns('const seen = await api.memo("started", context);'),
      ['names a memo without a namespace prefix ("started")']
    );
    assert.deepStrictEqual(
      footguns(
        'const MARK = "mark";\nconst seen = await api.memo(MARK, context);'
      ),
      ["names a memo without a namespace prefix (MARK)"]
    );
    assert.deepStrictEqual(
      rawAppends(
        "await harness.commit(async (tx) => { await tx.appendEntry(id, draft); }, ctx);"
      ),
      1
    );
    // The transaction's own name, whatever the callback calls it.
    assert.deepStrictEqual(
      rawAppends(
        "await harness.commit(async (t) => { await t.appendEntry(id, draft); }, ctx);\nconst place = async (head: Tx) => { await head?.appendEntry(id, draft); };"
      ),
      2
    );
    assert.deepStrictEqual(
      count(
        "const D = defineDoc({ checkpointWhen: () => false });",
        NEVER_CHECKPOINT
      ),
      1
    );
    // Reads and writes on the transaction, helpers given it, and reads outside the commit pass.
    assert.deepStrictEqual(
      footguns(
        [
          "await harness.commit(async (tx) => { const doc = await tx.doc(Doc); await record(tx, id); await tx.conversation(id); }, ctx);",
          "await runtime.commit(async (tx) => { await (stopped ? admitNote(tx, id) : conversation?.submit(tx, draft)); const all = await Promise.all(ids.map(async (id) => await owned(tx, id))); const at = await Option.match(found, { onNone: async () => await Promise.resolve(none), onSome: async (x) => await latest(tx, x) }); }, ctx);",
          "const owned = async (tx: Tx, id: number) => { const scan = async (cursor) => { const page = await tx.scanEntries({}, 10, cursor); return page.next === undefined ? page : await scan(page.next); }; return await scan(); };",
          "export interface Reactor { handle(tx: Tx, event: EventRecord): Promise<void>; }",
          "await harness.snapshot(Doc, ctx);",
          "const PLACED = (id) => `cairn.placed:` + id;",
          "await api.memo(PLACED(id), true, context);",
          'await api.memo("cairn.started", context);',
        ].join("\n")
      ),
      []
    );
  });

  it("scans every module that commits, inside `brain/` and out", () => {
    const committing = [...modules].flatMap(([name, source]) =>
      source.includes(".commit(") ? [name.split("/")[0] ?? name] : []
    );

    for (const folder of [
      "brain",
      "approvals",
      "subagents",
      "verdicts",
      "workflows",
      "models",
    ]) {
      assert.include(committing, folder);
    }

    // Modules that never call `commit(` but hold helpers given the transaction are scanned too.
    for (const name of [
      "brain/NoteAdmission.ts",
      "subagents/BrainCap.ts",
      "subagents/Delivery.ts",
      "verdicts/Verdicts.ts",
    ]) {
      const source = modules.get(name) ?? "";

      assert.notInclude(source, ".commit(", name);
      assert.isAbove(commitBodies(codeOf(source)).length, 0, name);
    }
  });

  it("finds none in the server's modules", () => {
    const sources = [...modules.values()];

    const found = [...modules].flatMap(([name, source]) =>
      footguns(source, sources).map((footgun) => `${name}: ${footgun}`)
    );

    assert.deepStrictEqual(found, []);
  });

  it("finds raw appends only at the reviewed sites", () => {
    assert.deepStrictEqual(sites(rawAppends), RAW_APPENDS);
  });

  it("finds never-checkpointed documents only where reviewed", () => {
    assert.deepStrictEqual(
      sites((source) => count(source, NEVER_CHECKPOINT)),
      NEVER_CHECKPOINTED
    );
  });
});
