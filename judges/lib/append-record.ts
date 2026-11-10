// Appends one judge record (`Record.ts`) for a shell judge, which cannot import the helper: `record.sh`
// calls it when the judge exits, and the nightly calls it at its end with its counts.
//
//   node judges/lib/append-record.ts --file <path under judges/> --exit <code> --started <unix s>
//     [--commit <sha> --tree clean|dirty] [--counts <json object>] [-- <the judge's arguments>]
//
// Without --commit, the commit and tree are read now. Prints nothing on success.

import { parseArgs } from "node:util";

import { Option, Schema } from "effect";

import {
  appendRecord,
  countsOf,
  recordOf,
  setRunOfEnv,
  treeState,
} from "./Record.ts";

const { values, positionals } = parseArgs({
  options: {
    file: { type: "string" },
    exit: { type: "string" },
    started: { type: "string" },
    commit: { type: "string" },
    tree: { type: "string" },
    counts: { type: "string", default: "{}" },
  },
  allowPositionals: true,
});

const decodeInt = Schema.decodeUnknownOption(Schema.FiniteFromString);

const decodeTree = Schema.decodeUnknownOption(
  Schema.Literals(["clean", "dirty"])
);

const file = values.file ?? "";

const exitCode = decodeInt(values.exit);

const started = decodeInt(values.started);

if (file === "" || Option.isNone(exitCode) || Option.isNone(started)) {
  process.stderr.write(
    "usage: append-record.ts --file <path under judges/> --exit <code> --started <unix s> [--commit <sha> --tree clean|dirty] [--counts <json>] [-- args]\n"
  );
  process.exit(2);
}

const now = treeState(import.meta.dirname);

appendRecord(
  recordOf({
    file,
    args: positionals,
    commit: values.commit ?? now.commit,
    tree: Option.getOrElse(decodeTree(values.tree), () => now.tree),
    exitCode: exitCode.value,
    counts: countsOf(values.counts),
    startedAt: new Date(started.value * 1000),
    endedAt: new Date(),
    run: setRunOfEnv(),
  })
);
