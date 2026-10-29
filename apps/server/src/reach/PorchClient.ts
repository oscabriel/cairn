// The one way Cairn talks to porch, the user's CLI that turns a name into an HTTPS URL on their own
// domain through the Docker Caddy (ADR 0038, docs/phase-2/notes/reach.md R3). porch is Bun-only with
// no library entry, so the brain runs its binary with `--json` and decodes one receipt schema per
// command; a refusal (`{"error":{"code","message"}}` with exit 1) becomes a `PorchError` naming
// porch's code, and `proxy-refused` keeps the proxy's own words.
//
// Only the commands the installed binary documents in `porch --help` are used: `publish` (never
// with `--replace`), `add`, `rm`, `ls`, `apply`, `doctor` and `--version`. Cairn never runs
// `import` (it rewrites hand-written routes and drops `forward_auth`), `init`, `rollback` or `run`.
// `porch publish` overwrites a file it did not publish, so callers publish through
// `ArtifactPublisher`, which refuses that case from Cairn's own `artifacts` table.
//
// Arguments go as argv entries, never through a shell, and every value that could start with `-`
// is refused before the call. `CAIRN_*` variables never reach the child.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import {
  Array as Arr,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// ── Receipts ─────────────────────────────────────────────────────────────────────────────────────

/** A URL porch hands out: https only. */
const PorchUrl = Schema.String.check(Schema.isPattern(/^https:\/\//u));

/** `porch publish --json`: where the copy landed and whether its bytes changed. */
export const PublishReceipt = Schema.Struct({
  changed: Schema.Boolean,
  /** porch's sha256 of the file, or of the folder's tree. */
  hash: Schema.String.check(Schema.isMinLength(1)),
  /** The copy inside the artifacts folder. */
  path: Schema.String,
  url: PorchUrl,
});

export type PublishReceipt = typeof PublishReceipt.Type;

/** `porch add --json`: a service porch and whether Caddy reloaded. */
export const AddReceipt = Schema.Struct({
  name: Schema.String,
  reloaded: Schema.Boolean,
  url: PorchUrl,
});

export type AddReceipt = typeof AddReceipt.Type;

/** `porch rm --json`. */
export const RemoveReceipt = Schema.Struct({
  removed: Schema.String,
  reloaded: Schema.Boolean,
});

export type RemoveReceipt = typeof RemoveReceipt.Type;

/** `porch apply --json`: how many porches the snippet holds. */
export const ApplyReceipt = Schema.Struct({
  applied: Schema.Int,
  reloaded: Schema.Boolean,
});

export type ApplyReceipt = typeof ApplyReceipt.Type;

/** What a porch is: a dev server, a service upstream, a static folder or the artifacts folder. */
export const PorchKind = Schema.Literals([
  "dev",
  "service",
  "static",
  "artifacts",
]);

export type PorchKind = typeof PorchKind.Type;

/** One row of `porch ls --json`. `state` is porch's word (`lit` when its upstream answers, `dark`). */
export const PorchRow = Schema.Struct({
  kind: PorchKind,
  name: Schema.String,
  state: Schema.String,
  url: PorchUrl,
});

export type PorchRow = typeof PorchRow.Type;

/** One check of `porch doctor --json`. */
export const DoctorCheck = Schema.Struct({
  name: Schema.String,
  ok: Schema.Boolean,
  detail: Schema.String,
});

export type DoctorCheck = typeof DoctorCheck.Type;

/** The part of porch's machine config (`<XDG_CONFIG_HOME>/porchlight/config.json`) Cairn reads. */
export const PorchMachine = Schema.Struct({
  domain: Schema.String.check(Schema.isMinLength(1)),
  /** The artifacts folder, `<artifacts>/<project>/<name>` for each published page. */
  artifacts: Schema.String.check(Schema.isPattern(/^\//u)),
});

export type PorchMachine = typeof PorchMachine.Type;

const ErrorBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});

const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeEffect(Schema.fromJsonString(schema));

const decodePublish = decodeJson(PublishReceipt);

const decodeAdd = decodeJson(AddReceipt);

const decodeRemove = decodeJson(RemoveReceipt);

const decodeApply = decodeJson(ApplyReceipt);

const decodeRows = decodeJson(Schema.Array(PorchRow));

const decodeDoctor = decodeJson(Schema.Array(DoctorCheck));

const decodeMachine = decodeJson(PorchMachine);

const decodeConfigHome = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isPattern(/^\//u))
);

const decodeErrorBody = Schema.decodeOption(Schema.fromJsonString(ErrorBody));

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Why a porch call failed. The first group are porch's own refusals, by its `error.code` (`busy`:
 * another porch command held the state lock past its wait; `no-port`: the port range is spent);
 * `other` is a code Cairn does not know yet. The rest are Cairn's: `unavailable` (the binary did not start
 * or its config is unreadable), `timeout`, `crashed` (a non-zero exit with no JSON refusal),
 * `bad-receipt` (output that does not decode) and `bad-input` (refused before porch ran).
 */
export const PorchErrorReason = Schema.Literals([
  "exists",
  "reserved",
  "missing",
  "invalid-name",
  "proxy-refused",
  "no-config",
  "busy",
  "no-port",
  "other",
  "unavailable",
  "timeout",
  "crashed",
  "bad-receipt",
  "bad-input",
]);

export type PorchErrorReason = typeof PorchErrorReason.Type;

const PORCH_CODES: ReadonlyArray<PorchErrorReason> = [
  "exists",
  "reserved",
  "missing",
  "invalid-name",
  "proxy-refused",
  "no-config",
  "busy",
  "no-port",
];

const reasonOfCode = (code: string): PorchErrorReason =>
  Option.getOrElse(
    Arr.findFirst(PORCH_CODES, (known) => known === code),
    (): PorchErrorReason => "other"
  );

/** A porch call was refused or could not run. `detail` is porch's message or the end of stderr. */
export class PorchError extends Schema.TaggedError<PorchError>()("PorchError", {
  message: Schema.String,
  /** porch's subcommand, such as `publish`. */
  operation: Schema.String,
  reason: PorchErrorReason,
  /** porch's own `error.code`, when it answered with one. */
  porchCode: Schema.OptionFromNullOr(Schema.String),
  detail: Schema.String,
  /** Whether the same call may simply be made again. */
  retryable: Schema.Boolean,
  cause: Schema.optional(Schema.Defect()),
}) {}

// Failures where the same call may simply be made again. `busy` is porch's lock, held a moment
// by another porch command; every other refusal changed nothing and will refuse again until
// something else changes.
const RETRYABLE: ReadonlySet<PorchErrorReason> = new Set<PorchErrorReason>([
  "busy",
  "timeout",
  "unavailable",
]);

// `add` and `rm` are not idempotent: after a timeout that did complete, the same call answers
// `exists` or `missing`. A timeout of theirs is retryable only after a `porch ls` (S32).
const NOT_IDEMPOTENT: ReadonlySet<string> = new Set(["add", "rm"]);

const retryableOf = (operation: string, reason: PorchErrorReason) =>
  RETRYABLE.has(reason) &&
  !(reason === "timeout" && NOT_IDEMPOTENT.has(operation));

const porchRefusal = (
  operation: string,
  code: string,
  detail: string
): PorchError => {
  const reason = reasonOfCode(code);

  return new PorchError({
    message: `porch ${operation} refused (${code}): ${detail}`,
    operation,
    reason,
    porchCode: Option.some(code),
    detail,
    retryable: retryableOf(operation, reason),
  });
};

const cairnFailure = (
  operation: string,
  reason: PorchErrorReason,
  message: string,
  detail: string,
  cause: Option.Option<unknown>
) =>
  new PorchError({
    message,
    operation,
    reason,
    porchCode: Option.none(),
    detail,
    retryable: retryableOf(operation, reason),
    cause: Option.getOrUndefined(cause),
  });

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────

/** Where the porch binary is and what extra environment it runs with. */
export interface PorchInvocation {
  /** The binary, a name on PATH or an absolute path. */
  readonly bin: string;
  /**
   * Extra environment for every call. Judges point `HOME`, `XDG_CONFIG_HOME` and
   * `XDG_STATE_HOME` at a folder they own, so a judge's porch never sees the user's.
   */
  readonly env: Readonly<Record<string, string>>;
  /** How long one call may take; a call that reloads Caddy waits for the reload. */
  readonly timeout: Duration.Duration;
}

/** The porch binary and its environment; the default is `porch` on the brain's PATH. */
export const PorchSettings = Context.Reference<PorchInvocation>(
  "cairn/server/reach/PorchSettings",
  {
    defaultValue: () => ({
      bin: "porch",
      env: {},
      timeout: Duration.seconds(60),
    }),
  }
);

/** The end of stderr an error keeps. */
const STDERR_TAIL_CHARS = 2000;

const tail = (text: string) =>
  (text.length <= STDERR_TAIL_CHARS
    ? text
    : text.slice(-STDERR_TAIL_CHARS)
  ).trim();

/** The environment a child sees: the brain's own less every `CAIRN_*` variable, plus `extra`. */
const childEnv = (extra: Readonly<Record<string, string>>) => ({
  ...Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => name.startsWith("CAIRN_"))
      .map((name) => [name, undefined])
  ),
  ...extra,
});

// ── Input checks ─────────────────────────────────────────────────────────────────────────────────

/** One DNS label, as porch requires of a name. */
const PORCH_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** An artifacts project: one path segment that cannot climb out of the artifacts folder. */
const PROJECT_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** An upstream Cairn registers: a loopback port, the only kind a portal has. */
const LOOPBACK_UPSTREAM = /^http:\/\/127\.0\.0\.1:(?<port>\d{1,5})$/u;

const badInput = (operation: string, detail: string) =>
  cairnFailure(
    operation,
    "bad-input",
    `porch ${operation} was not run: ${detail}`,
    detail,
    Option.none()
  );

/**
 * Why `porch publish <source> --project <project>` would be refused before porch runs: a source
 * that is not an absolute path, or a project that is not one slug segment. `ArtifactPublisher`
 * checks it before it reads the artifacts folder or the table.
 */
export const checkPublish = (source: string, project: string) => {
  if (!path.isAbsolute(source)) {
    return Option.some(
      badInput("publish", `the source ${source} is not an absolute path.`)
    );
  }

  if (!PROJECT_SLUG.test(project) || project.includes("..")) {
    return Option.some(
      badInput(
        "publish",
        `the project ${project} is not a slug (lowercase letters, digits, ".", "_" and "-", starting with a letter or digit).`
      )
    );
  }

  return Option.none<PorchError>();
};

const checkName = (operation: string, name: string) =>
  PORCH_NAME.test(name)
    ? Option.none<PorchError>()
    : Option.some(
        badInput(
          operation,
          `${name} is not one DNS label (lowercase a-z, 0-9 and -, up to 63 characters).`
        )
      );

/** A portal name, `<branch>--<project>`, the only service porch name the owner-only guard covers. */
const PORTAL_NAME = /^[a-z0-9-]+--[a-z0-9-]+$/u;

/**
 * Why `porch add <name>` would be refused before porch runs. Beyond one DNS label, the name must
 * hold `--`: the Caddyfile's owner-only guard matches `plans` and `<a>--<b>` only, so a name
 * without `--` would be served to the whole tailnet. It also keeps a porch name from ever equaling
 * a hand-written matcher such as `@cairn`.
 */
const checkPortalName = (name: string) =>
  Option.orElse(checkName("add", name), () =>
    PORTAL_NAME.test(name)
      ? Option.none<PorchError>()
      : Option.some(
          badInput(
            "add",
            `${name} is not a portal name (<branch>--<project>); the owner-only guard covers only names with "--", so any other name would be open to the whole tailnet.`
          )
        )
  );

const checkUpstream = (upstream: string) => {
  const port = Number(LOOPBACK_UPSTREAM.exec(upstream)?.groups?.port ?? "0");

  return port >= 1 && port <= 65_535
    ? Option.none<PorchError>()
    : Option.some(
        badInput(
          "add",
          `the upstream ${upstream} is not http://127.0.0.1:<port>.`
        )
      );
};

/** Fails with the input check's refusal, if it has one. */
const refuseWith = (refusal: Option.Option<PorchError>) =>
  Option.match(refusal, {
    onNone: () => Effect.void,
    onSome: (error) => Effect.fail(error),
  });

// ── The fake ─────────────────────────────────────────────────────────────────────────────────────

/** Where a fake porch serves from. */
export interface FakePorchOptions {
  readonly domain: string;
  /** A real folder the fake copies published pages into, as porch does. */
  readonly artifacts: string;
}

/** A fake porch and its controls. */
export interface FakePorch {
  readonly client: PorchClient["Service"];
  /** From now on every reload is refused with `text` as the proxy's words; `None` mends it. */
  refuseReloads(text: Option.Option<string>): Effect.Effect<void>;
  /** How many reloads the fake has run. */
  readonly reloads: Effect.Effect<number>;
}

const RESERVED_NAMES: ReadonlyArray<string> = [
  "www",
  "app",
  "admin",
  "api",
  "plans",
];

const ARTIFACTS_PORCH = "plans";

const fsFailure = (operation: string) => (cause: Error) =>
  cairnFailure(
    operation,
    "crashed",
    `fake porch ${operation} failed on the file system: ${cause.message}`,
    cause.message,
    Option.some(cause)
  );

interface FakeState {
  readonly porches: ReadonlyMap<string, PorchKind>;
  readonly published: ReadonlyMap<
    string,
    { readonly hash: string; readonly source: string }
  >;
  readonly refusal: Option.Option<string>;
  readonly reloads: number;
}

/**
 * A faithful in-memory porch, measured against porch 0.0.0 by `judges/porch-contract.ts`: the same
 * receipts and refusal codes, a file's hash is the sha256 of its bytes, a refused reload changes
 * nothing, and (as porch does) `publish` overwrites a file at the target that it never published.
 * Service porches list as `dark`, since nothing answers behind a fake.
 */
export const makeFakePorch = Effect.fnUntraced(function* (
  options: FakePorchOptions
) {
  const fs = yield* FileSystem.FileSystem;

  const state = yield* Ref.make<FakeState>({
    porches: new Map(),
    published: new Map(),
    refusal: Option.none(),
    reloads: 0,
  });

  const urlOf = (name: string) => `https://${name}.${options.domain}`;

  /** Runs a reload; on a refusal nothing the caller staged is kept. */
  const reload = (operation: string) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);

      if (Option.isSome(current.refusal)) {
        return yield* porchRefusal(
          operation,
          "proxy-refused",
          `caddy refused to reload, so nothing changed. It said:\n${current.refusal.value}`
        );
      }

      return yield* Ref.update(state, (s) => ({
        ...s,
        reloads: s.reloads + 1,
      }));
    });

  const filesOf = (root: string) =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(root, { recursive: true });
      const files: Array<string> = [];

      for (const entry of entries.toSorted()) {
        const info = yield* fs.stat(path.join(root, entry));

        if (info.type === "File") {
          files.push(entry);
        }
      }

      return files;
    });

  const hashOf = (source: string, folder: boolean) =>
    Effect.gen(function* () {
      const digest = createHash("sha256");

      if (!folder) {
        digest.update(yield* fs.readFile(source));

        return digest.digest("hex");
      }

      for (const file of yield* filesOf(source)) {
        digest.update(file);
        digest.update("\0");
        digest.update(yield* fs.readFile(path.join(source, file)));
        digest.update("\0");
      }

      return digest.digest("hex");
    });

  const publish = (source: string, project: string) =>
    Effect.gen(function* () {
      const refusal = checkPublish(source, project);

      if (Option.isSome(refusal)) {
        return yield* refusal.value;
      }

      if (!(yield* fs.exists(source))) {
        return yield* porchRefusal(
          "publish",
          "missing",
          `${source} does not exist.`
        );
      }

      const folder = (yield* fs.stat(source)).type === "Directory";

      if (folder && !(yield* fs.exists(path.join(source, "index.html")))) {
        return yield* porchRefusal(
          "publish",
          "missing",
          `${source} has no index.html. A published folder needs one as its front page.`
        );
      }

      const name = path.basename(source);
      const key = `${project}/${name}`;
      const target = path.join(options.artifacts, project, name);
      const url = `${urlOf(ARTIFACTS_PORCH)}/${project}/${name}${folder ? "/" : ""}`;
      const current = yield* Ref.get(state);
      const recorded = current.published.get(key);

      if (recorded !== undefined && recorded.source !== source) {
        return yield* porchRefusal(
          "publish",
          "exists",
          `${key} was published from ${recorded.source}. Publish from there, or pass --replace to put ${source} in its place.`
        );
      }

      if (!current.porches.has(ARTIFACTS_PORCH)) {
        yield* reload("publish");
        yield* Ref.update(state, (s) => ({
          ...s,
          porches: new Map(s.porches).set(ARTIFACTS_PORCH, "artifacts"),
        }));
      }

      const hash = yield* hashOf(source, folder);

      if (recorded?.hash === hash && (yield* fs.exists(target))) {
        return { changed: false, hash, path: target, url };
      }

      yield* fs.remove(target, { recursive: true, force: true });
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.copy(source, target);
      yield* Ref.update(state, (s) => ({
        ...s,
        published: new Map(s.published).set(key, { hash, source }),
      }));

      return { changed: true, hash, path: target, url };
    }).pipe(Effect.catchTag("PlatformError", fsFailure("publish")));

  const add = (name: string, upstream: string) =>
    Effect.gen(function* () {
      const badName = checkPortalName(name);

      if (Option.isSome(badName)) {
        return yield* badName.value;
      }

      const badUpstream = checkUpstream(upstream);

      if (Option.isSome(badUpstream)) {
        return yield* badUpstream.value;
      }

      if (RESERVED_NAMES.includes(name)) {
        return yield* porchRefusal(
          "add",
          "reserved",
          `${name} is reserved. Pick another name. Reserved: ${RESERVED_NAMES.join(", ")}.`
        );
      }

      if ((yield* Ref.get(state)).porches.has(name)) {
        return yield* porchRefusal(
          "add",
          "exists",
          `${name} is already a porch. Remove it first with \`porch rm ${name}\`.`
        );
      }

      yield* reload("add");
      yield* Ref.update(state, (s) => ({
        ...s,
        porches: new Map(s.porches).set(name, "service"),
      }));

      return { name, reloaded: true, url: urlOf(name) };
    });

  const remove = (name: string) =>
    Effect.gen(function* () {
      const badName = checkName("rm", name);

      if (Option.isSome(badName)) {
        return yield* badName.value;
      }

      if (!(yield* Ref.get(state)).porches.has(name)) {
        return yield* porchRefusal(
          "rm",
          "missing",
          `${name} is not a porch. Run \`porch ls\` to see them.`
        );
      }

      yield* reload("rm");
      yield* Ref.update(state, (s) => {
        const porches = new Map(s.porches);
        porches.delete(name);

        return { ...s, porches };
      });

      return { removed: name, reloaded: true };
    });

  const list = Effect.map(Ref.get(state), (s) =>
    Array.from(s.porches, ([name, kind]): PorchRow => ({
      kind,
      name,
      state: kind === "artifacts" ? "lit" : "dark",
      url: urlOf(name),
    }))
  );

  const apply = Effect.gen(function* () {
    yield* reload("apply");

    return {
      applied: (yield* Ref.get(state)).porches.size,
      reloaded: true,
    };
  });

  const client: PorchClient["Service"] = {
    version: Effect.succeed("0.0.0-fake"),
    machine: Effect.succeed({
      domain: options.domain,
      artifacts: options.artifacts,
    }),
    publish,
    add,
    remove,
    list,
    apply,
    doctor: Effect.succeed([
      {
        name: "Snippet is current",
        ok: true,
        detail: "the fake's registry",
      },
    ]),
  };

  const fake: FakePorch = {
    client,
    refuseReloads: (text) =>
      Ref.update(state, (s) => ({ ...s, refusal: text })),
    reloads: Effect.map(Ref.get(state), (s) => s.reloads),
  };

  return fake;
});

// ── The service ──────────────────────────────────────────────────────────────────────────────────

/** Runs porch for reach: artifacts and portals (ADR 0038). */
export class PorchClient extends Context.Service<
  PorchClient,
  {
    /** `porch --version`; fails `unavailable` when the binary is missing. */
    readonly version: Effect.Effect<string, PorchError>;
    /** The domain and artifacts folder from porch's machine config; `no-config` before `porch init`. */
    readonly machine: Effect.Effect<PorchMachine, PorchError>;
    /**
     * Copies `source` (an HTML file, or a folder with an `index.html`) to
     * `<artifacts>/<project>/<basename>` and answers its URL. The same bytes again are
     * `changed: false`. Refused `exists` when porch recorded that page from another source; never
     * replaces it. porch does overwrite a file it did not publish, so call this only through
     * `ArtifactPublisher`.
     */
    publish(
      source: string,
      project: string
    ): Effect.Effect<PublishReceipt, PorchError>;
    /**
     * A service porch `<name>.<domain>` in front of `upstream` (`http://127.0.0.1:<port>`); reloads
     * Caddy. `name` must be a portal name, `<branch>--<project>`: the Caddyfile's owner-only guard
     * (ops/wizards/reach-edits.ts) covers only names with `--`, so any other name would be served
     * to the whole tailnet. Refused `bad-input` before porch runs.
     */
    add(name: string, upstream: string): Effect.Effect<AddReceipt, PorchError>;
    /** Removes a porch; `missing` when there is none of that name. Reloads Caddy. */
    remove(name: string): Effect.Effect<RemoveReceipt, PorchError>;
    /** Every porch, lit or dark. */
    readonly list: Effect.Effect<ReadonlyArray<PorchRow>, PorchError>;
    /** Writes the snippet from porch's registry and reloads Caddy. */
    readonly apply: Effect.Effect<ApplyReceipt, PorchError>;
    /** porch's own checks (DNS, certificate, snippet, every porch); failing checks are answers, not errors. */
    readonly doctor: Effect.Effect<ReadonlyArray<DoctorCheck>, PorchError>;
  }
>()("cairn/server/reach/PorchClient") {
  /** Runs the binary named by `PorchSettings` through the ambient spawner and file system. */
  static readonly layerNoDeps = Layer.effect(
    PorchClient,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const settings = yield* PorchSettings;
      const defaultConfigHome = path.join(homedir(), ".config");

      // An unset or empty XDG_CONFIG_HOME falls back to ~/.config, as porch itself does.
      const ambientConfigHome = Option.getOrElse(
        decodeConfigHome(process.env.XDG_CONFIG_HOME),
        () => defaultConfigHome
      );

      const configHome =
        settings.env.XDG_CONFIG_HOME ??
        (settings.env.HOME === undefined
          ? ambientConfigHome
          : path.join(settings.env.HOME, ".config"));

      const configFile = path.join(configHome, "porchlight", "config.json");

      // The child reads its config from the same folder `machine` does, whatever the brain's own
      // XDG_CONFIG_HOME says.
      const env = childEnv({ ...settings.env, XDG_CONFIG_HOME: configHome });

      /** Runs porch once; answers its exit code and output, failing only when it could not run. */
      const run = Effect.fn("PorchClient.run")(function* (
        operation: string,
        args: ReadonlyArray<string>
      ) {
        yield* Effect.annotateCurrentSpan({ operation });

        const command = ChildProcess.make(settings.bin, [...args], {
          env,
          extendEnv: true,
          stdin: "ignore",
        });

        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(command);

            const [stdout, stderr] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
              ],
              { concurrency: 2 }
            );

            const exitCode = yield* handle.exitCode;

            return { exitCode: Number(exitCode), stdout, stderr };
          })
        ).pipe(
          Effect.mapError((cause) =>
            cairnFailure(
              operation,
              "unavailable",
              `porch ${operation} could not start ${settings.bin}: ${cause.message}. Check that porch is installed and on the brain's PATH (ops/wizards/phase-2.sh, the reach stage).`,
              cause.message,
              Option.some(cause)
            )
          ),
          Effect.timeoutOrElse({
            duration: settings.timeout,
            orElse: () =>
              Effect.fail(
                cairnFailure(
                  operation,
                  "timeout",
                  NOT_IDEMPOTENT.has(operation)
                    ? `porch ${operation} stopped after ${Duration.format(settings.timeout)}. It may have finished: run \`porch ls\` to see whether it did before calling ${operation} again.`
                    : `porch ${operation} stopped after ${Duration.format(settings.timeout)}. porch saves its registry only after a reload succeeds; check \`porch ls\`, then retry.`,
                  "",
                  Option.none()
                )
              ),
          })
        );
      });

      /** Runs a `--json` command and decodes its receipt, or its refusal into a `PorchError`. */
      const receipt = <A>(
        operation: string,
        args: ReadonlyArray<string>,
        decode: (stdout: string) => Effect.Effect<A, Schema.SchemaError>,
        acceptExit: (exitCode: number) => boolean = (code) => code === 0
      ) =>
        Effect.gen(function* () {
          const result = yield* run(operation, [...args, "--json"]);

          // A refusal body wins over an accepted exit code: `doctor` exits 1 both for failing
          // checks and for `no-config`, and only the body tells them apart.
          if (result.exitCode !== 0) {
            const refusal = decodeErrorBody(result.stdout);

            if (Option.isSome(refusal)) {
              return yield* porchRefusal(
                operation,
                refusal.value.error.code,
                refusal.value.error.message
              );
            }
          }

          if (!acceptExit(result.exitCode)) {
            const detail = tail(
              result.stderr === "" ? result.stdout : result.stderr
            );

            return yield* cairnFailure(
              operation,
              "crashed",
              `porch ${operation} exited ${String(result.exitCode)} without a refusal: ${detail}`,
              detail,
              Option.none()
            );
          }

          return yield* decode(result.stdout).pipe(
            Effect.mapError((cause) =>
              cairnFailure(
                operation,
                "bad-receipt",
                `porch ${operation} answered output Cairn cannot read (${cause.message}). The porch binary may have changed; run judges/porch-contract.ts against it.`,
                tail(result.stdout),
                Option.some(cause)
              )
            )
          );
        });

      const version = Effect.gen(function* () {
        const result = yield* run("version", ["--version"]);

        if (result.exitCode !== 0) {
          const detail = tail(result.stderr);

          return yield* cairnFailure(
            "version",
            "unavailable",
            `porch --version exited ${String(result.exitCode)}: ${detail}`,
            detail,
            Option.none()
          );
        }

        return result.stdout.trim();
      }).pipe(Effect.withSpan("PorchClient.version"));

      const machine = Effect.gen(function* () {
        const exists = yield* fs
          .exists(configFile)
          .pipe(Effect.orElseSucceed(() => false));

        if (!exists) {
          return yield* porchRefusal(
            "machine",
            "no-config",
            `No machine config at ${configFile}. Run \`porch init\` (ops/wizards/phase-2.sh, the reach stage).`
          );
        }

        const text = yield* fs
          .readFileString(configFile)
          .pipe(
            Effect.mapError((cause) =>
              cairnFailure(
                "machine",
                "unavailable",
                `porch's machine config ${configFile} could not be read: ${cause.message}.`,
                cause.message,
                Option.some(cause)
              )
            )
          );

        return yield* decodeMachine(text).pipe(
          Effect.mapError((cause) =>
            cairnFailure(
              "machine",
              "bad-receipt",
              `porch's machine config ${configFile} has no domain or absolute artifacts folder (${cause.message}).`,
              "",
              Option.some(cause)
            )
          )
        );
      }).pipe(Effect.withSpan("PorchClient.machine"));

      const publish = Effect.fn("PorchClient.publish")(function* (
        source: string,
        project: string
      ) {
        yield* refuseWith(checkPublish(source, project));

        return yield* receipt(
          "publish",
          ["publish", source, "--project", project],
          decodePublish
        );
      });

      const add = Effect.fn("PorchClient.add")(function* (
        name: string,
        upstream: string
      ) {
        yield* refuseWith(checkPortalName(name));
        yield* refuseWith(checkUpstream(upstream));

        return yield* receipt("add", ["add", name, upstream], decodeAdd);
      });

      const remove = Effect.fn("PorchClient.remove")(function* (name: string) {
        yield* refuseWith(checkName("rm", name));

        return yield* receipt("rm", ["rm", name], decodeRemove);
      });

      const list = receipt("ls", ["ls"], decodeRows).pipe(
        Effect.withSpan("PorchClient.list")
      );

      const apply = receipt("apply", ["apply"], decodeApply).pipe(
        Effect.withSpan("PorchClient.apply")
      );

      // `doctor` exits 1 when any check fails and still prints every check.
      const doctor = receipt(
        "doctor",
        ["doctor"],
        decodeDoctor,
        (code) => code === 0 || code === 1
      ).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(30),
          orElse: () =>
            Effect.fail(
              cairnFailure(
                "doctor",
                "timeout",
                "porch doctor did not finish within 30 seconds; its DNS or certificate probe hung. Run it by hand to see which.",
                "",
                Option.none()
              )
            ),
        }),
        Effect.withSpan("PorchClient.doctor")
      );

      return PorchClient.of({
        version,
        machine,
        publish,
        add,
        remove,
        list,
        apply,
        doctor,
      });
    })
  );

  /** The real binary with Node's spawner and file system. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(NodeServices.layer)
  );

  /** An in-memory porch over a real artifacts folder (`FakePorch`), for tests. */
  static readonly layerFake = (options: FakePorchOptions) =>
    Layer.effect(
      PorchClient,
      Effect.map(makeFakePorch(options), (fake) => fake.client)
    ).pipe(Layer.provide(NodeServices.layer));
}
