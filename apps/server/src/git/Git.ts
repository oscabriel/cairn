// The one way Cairn runs `git`: argv only (never a shell string), in a given folder, with a fixed
// set of `-c` options that keep Cairn's own plumbing from running the repository's hooks or its
// file-system monitor. The user's real `HOME` and global config stay in effect, because these are
// the user's own repositories (signing, `safe.directory` and worktree settings must keep working).
// `CAIRN_*` variables never reach the child.
//
// The safe option set is drawn from cairn-v1, apps/server/src/sandbox/Mirror.ts (`SAFE`) at
// 1a5cd4a, without its `HOME=/nonexistent` and `GIT_CONFIG_GLOBAL=/dev/null`, which suit a hostile
// mirror and not the user's checkouts.
import { NodeServices } from "@effect/platform-node";
import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Options every Cairn `git` call starts with. */
export const SAFE_GIT_OPTIONS: ReadonlyArray<string> = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
];

/** How long a `git` call may take unless the caller says otherwise. */
export const DEFAULT_GIT_TIMEOUT = Duration.seconds(60);

/** The most of stderr an error keeps, from its end. */
const STDERR_TAIL_CHARS = 2000;

/** A `git` call could not run, ran too long, or (for `stdout`) exited non-zero. */
export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  message: Schema.String,
  /** The Cairn operation that ran git, such as `Worktrees.create`. */
  operation: Schema.String,
  cwd: Schema.String,
  /** git's subcommand, such as `worktree`. */
  subcommand: Schema.String,
  reason: Schema.Literals(["spawn_failed", "timeout", "exit_nonzero"]),
  exitCode: Schema.OptionFromNullOr(Schema.Int),
  /** The end of git's stderr, for the log and for a message's detail. */
  stderr: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** What one `git` call printed and how it exited. */
export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Options of one `git` call. */
export interface GitRunOptions {
  /** Defaults to `DEFAULT_GIT_TIMEOUT`. */
  readonly timeout?: Duration.Input;
  /** Extra environment variables for this call. */
  readonly env?: Readonly<Record<string, string>>;
}

const subcommandOf = (args: ReadonlyArray<string>) => {
  // Skip leading `-c key=value` pairs and other global options to name the subcommand.
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "-c" || arg === "-C") {
      index += 1;
    } else if (!arg.startsWith("-")) {
      return arg;
    }
  }

  return "git";
};

const tail = (text: string) =>
  text.length <= STDERR_TAIL_CHARS ? text : text.slice(-STDERR_TAIL_CHARS);

/** The environment a child sees: the brain's own, less every `CAIRN_*` variable, plus `extra`. */
const childEnv = (extra: Readonly<Record<string, string>>) => ({
  ...Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => name.startsWith("CAIRN_"))
      .map((name) => [name, undefined])
  ),
  // A prompt for credentials would hang a call with no terminal behind it.
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  ...extra,
});

/** Runs `git` for Cairn's own plumbing. */
export class Git extends Context.Service<
  Git,
  {
    /**
     * Runs `git <SAFE_GIT_OPTIONS> <args>` in `cwd` and returns its exit code and output, whatever
     * the exit code. Fails with `GitError` only when git could not run or ran past its timeout.
     */
    run(
      operation: string,
      cwd: string,
      args: ReadonlyArray<string>,
      options?: GitRunOptions
    ): Effect.Effect<GitResult, GitError>;
    /** Like `run`, but fails with `GitError` (`exit_nonzero`) unless git exits 0; returns stdout. */
    stdout(
      operation: string,
      cwd: string,
      args: ReadonlyArray<string>,
      options?: GitRunOptions
    ): Effect.Effect<string, GitError>;
  }
>()("cairn/server/git/Git") {
  /** Spawns through the ambient `ChildProcessSpawner`. */
  static readonly layerNoDeps = Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const run = Effect.fn("Git.run")(function* (
        operation: string,
        cwd: string,
        args: ReadonlyArray<string>,
        options?: GitRunOptions
      ) {
        const subcommand = subcommandOf(args);
        const timeout = options?.timeout ?? DEFAULT_GIT_TIMEOUT;

        yield* Effect.annotateCurrentSpan({ operation, subcommand });

        const failure = (
          reason: GitError["reason"],
          message: string,
          cause?: unknown
        ) =>
          new GitError({
            message,
            operation,
            cwd,
            subcommand,
            reason,
            exitCode: Option.none(),
            stderr: "",
            cause,
          });

        const command = ChildProcess.make(
          "git",
          [...SAFE_GIT_OPTIONS, ...args],
          {
            cwd,
            env: childEnv(options?.env ?? {}),
            extendEnv: true,
            stdin: "ignore",
          }
        );

        const result = yield* Effect.scoped(
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
            failure(
              "spawn_failed",
              `${operation} could not run git ${subcommand} in ${cwd}: ${cause.message}. Check that git is installed and the folder exists.`,
              cause
            )
          ),
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                failure(
                  "timeout",
                  `${operation} stopped git ${subcommand} in ${cwd} after ${Duration.format(Duration.fromInputUnsafe(timeout))}. Nothing after it ran; retry, or check the repository for a lock or a slow remote.`
                )
              ),
          })
        );

        return result;
      });

      const stdout = Effect.fn("Git.stdout")(function* (
        operation: string,
        cwd: string,
        args: ReadonlyArray<string>,
        options?: GitRunOptions
      ) {
        const result = yield* run(operation, cwd, args, options);

        if (result.exitCode !== 0) {
          const subcommand = subcommandOf(args);
          const detail = tail(result.stderr).trim();

          return yield* new GitError({
            message: `${operation} failed: git ${subcommand} exited ${String(result.exitCode)} in ${cwd}${detail === "" ? "." : `: ${detail}`}`,
            operation,
            cwd,
            subcommand,
            reason: "exit_nonzero",
            exitCode: Option.some(result.exitCode),
            stderr: tail(result.stderr),
          });
        }

        return result.stdout;
      });

      return Git.of({ run, stdout });
    })
  );

  /** Spawns with Node's process spawner. */
  static readonly layer = this.layerNoDeps.pipe(
    Layer.provide(NodeServices.layer)
  );
}
