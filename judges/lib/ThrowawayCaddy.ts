// A throwaway Caddy for judges: a Docker container from the live Caddy's own image, on loopback
// ports nothing else holds, with its config folder mounted at `/etc/caddy` as the live container
// has it, so `docker exec <name> caddy reload --config /etc/caddy/Caddyfile` is the live reload
// command with only the container's name changed. It never touches the live container, `~/caddy`
// or ports 80 and 443: every site binds 127.0.0.1 on a port the judge picked, and the admin API
// listens on another.
//
//   const caddy = yield* startCaddy({ conf, mounts: [root], waitPort, image })
//
// The container runs with `--rm` and is removed when the scope closes, and again on process exit.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";

import { Duration, Effect, Option, Predicate, Schedule, Schema } from "effect";

/** The live Caddy's image (`~/caddy`'s compose builds it); a judge's `--image` picks another. */
export const DEFAULT_CADDY_IMAGE = "caddy-caddy:latest";

/** A throwaway Caddy did not start, or a `caddy` call inside it failed. */
export class ThrowawayCaddyError extends Schema.TaggedError<ThrowawayCaddyError>()(
  "ThrowawayCaddyError",
  { message: Schema.String }
) {}

/** A free TCP port on 127.0.0.1, found by binding port 0 and letting it go. */
export const freePort = Effect.callback<number>((resume) => {
  const server = createServer();

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();

    const port =
      address === null || Predicate.isString(address) ? 0 : address.port;

    server.close(() => {
      resume(Effect.succeed(port));
    });
  });
});

/** Whether something accepts TCP connections on 127.0.0.1:`port`. */
export const answers = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = connect(port, "127.0.0.1");

    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });
    socket.once("error", () => {
      resume(Effect.succeed(false));
    });
  });

/** What a command printed and how it exited. */
export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `command <args>` to its end, with `env` added to the judge's own. */
export const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
  cwd?: string
) =>
  Effect.sync((): CommandResult => {
    const result = spawnSync(command, [...args], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    return {
      status: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });

/** Runs `docker <args>` to its end. */
export const docker = (args: ReadonlyArray<string>) =>
  runCommand("docker", args);

/** A running throwaway Caddy. */
export interface ThrowawayCaddy {
  readonly name: string;
  /** `docker exec <name> caddy <args>`. */
  caddy(args: ReadonlyArray<string>): Effect.Effect<CommandResult>;
  /** The live reload command, aimed at this container. */
  readonly reloadCommand: string;
  /** Reloads `/etc/caddy/Caddyfile`; fails with Caddy's words when it refuses. */
  readonly reload: Effect.Effect<void, ThrowawayCaddyError>;
  /** `caddy adapt` of `/etc/caddy/Caddyfile`, as JSON. */
  readonly adapt: Effect.Effect<Schema.Json, ThrowawayCaddyError>;
}

/** Where the container's config comes from and which host folders it may read. */
export interface CaddyOptions {
  /** A host folder holding `Caddyfile`, mounted read-only at `/etc/caddy`. */
  readonly conf: string;
  /** Host folders mounted read-only at their own paths (snippets, artifacts). */
  readonly mounts: ReadonlyArray<string>;
  /** A port the Caddyfile serves on; the start waits until it answers. */
  readonly waitPort: number;
  readonly image: string;
}

const live = new Set<string>();

process.once("exit", () => {
  for (const name of live) {
    spawnSync("docker", ["rm", "-f", name]);
  }
});

const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Json)
);

const CONFIG = ["--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"];

/** `caddy adapt` output from any container (the live one, read-only, in a live check). */
export const adaptIn = (container: string) =>
  Effect.gen(function* () {
    const adapted = yield* docker([
      "exec",
      container,
      "caddy",
      "adapt",
      ...CONFIG,
    ]);

    if (adapted.status !== 0) {
      return yield* new ThrowawayCaddyError({
        message: `caddy adapt failed in ${container}: ${adapted.stderr.trim().slice(-400)}`,
      });
    }

    return yield* decodeJson(adapted.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new ThrowawayCaddyError({
            message: `caddy adapt in ${container} printed no JSON: ${cause.message}`,
          })
      )
    );
  });

/** Starts the container, waits until `waitPort` answers (up to 20 s), and removes it with the scope. */
export const startCaddy = (options: CaddyOptions) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const name = `cairn-judge-caddy-${randomBytes(4).toString("hex")}`;

      const mounts = options.mounts.flatMap((dir) => [
        "-v",
        `${dir}:${dir}:ro`,
      ]);

      const started = yield* docker([
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "--network",
        "host",
        "-v",
        `${options.conf}:/etc/caddy:ro`,
        ...mounts,
        options.image,
        "caddy",
        "run",
        ...CONFIG,
      ]);

      if (started.status !== 0) {
        return yield* new ThrowawayCaddyError({
          message: `docker run ${options.image} failed: ${started.stderr.trim()}`,
        });
      }

      live.add(name);

      const up = yield* answers(options.waitPort).pipe(
        Effect.repeat({
          until: (answered) => answered,
          schedule: Schedule.spaced(Duration.millis(100)),
        }),
        Effect.timeoutOption(Duration.seconds(20))
      );

      if (Option.isNone(up)) {
        const logs = yield* docker(["logs", "--tail", "20", name]);

        return yield* new ThrowawayCaddyError({
          message: `the throwaway Caddy never answered on ${String(options.waitPort)}: ${logs.stderr.trim()}`,
        });
      }

      const caddy = (args: ReadonlyArray<string>) =>
        docker(["exec", name, "caddy", ...args]);

      const reload = caddy(["reload", ...CONFIG]).pipe(
        Effect.flatMap((result) =>
          result.status === 0
            ? Effect.void
            : Effect.fail(
                new ThrowawayCaddyError({
                  message: `caddy reload refused: ${result.stderr.trim().slice(-400)}`,
                })
              )
        )
      );

      const handle: ThrowawayCaddy = {
        name,
        caddy,
        reloadCommand: `docker exec ${name} caddy reload ${CONFIG.join(" ")}`,
        reload,
        adapt: adaptIn(name),
      };

      return handle;
    }),
    (caddy) =>
      Effect.gen(function* () {
        live.delete(caddy.name);
        yield* docker(["rm", "-f", caddy.name]);
      })
  );

/** One `reverse_proxy` handler of an adapted Caddy config: its upstreams and its close delay. */
export interface ProxyHandler {
  readonly dials: ReadonlyArray<string>;
  /** Whether it sets a non-zero `stream_close_delay`. */
  readonly closeDelay: boolean;
  /**
   * Whether it is a `forward_auth` subrequest: Caddy adapts `forward_auth` to a `reverse_proxy`
   * that rewrites the request to a GET and answers through `handle_response`. It carries no
   * long-lived stream, so it needs no close delay.
   */
  readonly forwardAuth: boolean;
}

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray =>
  Array.isArray(value);

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const hasDelay = (delay: Schema.Json | undefined) =>
  (Predicate.isNumber(delay) && delay > 0) ||
  (Predicate.isString(delay) && delay !== "" && delay !== "0");

/** Every `reverse_proxy` handler anywhere in `caddy adapt`'s JSON. */
export const proxyHandlers = (
  config: Schema.Json
): ReadonlyArray<ProxyHandler> => {
  const found: Array<ProxyHandler> = [];
  const pending: Array<Schema.Json> = [config];

  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isJsonArray(node)) {
      pending.push(...node);
    } else if (isJsonObject(node)) {
      if (node.handler === "reverse_proxy") {
        const { upstreams } = node;
        const dials: Array<string> = [];

        if (upstreams !== undefined && isJsonArray(upstreams)) {
          for (const upstream of upstreams) {
            if (isJsonObject(upstream) && Predicate.isString(upstream.dial)) {
              dials.push(upstream.dial);
            }
          }
        }

        const { rewrite } = node;

        const forwardAuth =
          node.handle_response !== undefined &&
          rewrite !== undefined &&
          isJsonObject(rewrite) &&
          rewrite.method === "GET";

        found.push({
          dials,
          closeDelay: hasDelay(node.stream_close_delay),
          forwardAuth,
        });
      }

      pending.push(...Object.values(node));
    }
  }

  return found;
};

/** What the close-delay check found for one required upstream. */
export interface DelayFinding {
  readonly dial: string;
  /** How many `reverse_proxy` handlers dial it, `forward_auth` subrequests aside. */
  readonly handlers: number;
  /** How many of those have no `stream_close_delay`. */
  readonly withoutDelay: number;
}

/**
 * Checks that every `reverse_proxy` dialing each of `required` sets `stream_close_delay`, leaving
 * out `forward_auth` subrequests. Passes only when each required upstream has at least one handler
 * and none lacks the delay.
 */
export const checkCloseDelay = (
  config: Schema.Json,
  required: ReadonlyArray<string>
) => {
  const handlers = proxyHandlers(config).filter(
    (handler) => !handler.forwardAuth
  );

  const findings: ReadonlyArray<DelayFinding> = required.map((dial) => {
    const dialing = handlers.filter((handler) => handler.dials.includes(dial));

    return {
      dial,
      handlers: dialing.length,
      withoutDelay: dialing.filter((handler) => !handler.closeDelay).length,
    };
  });

  return {
    ok: findings.every(
      (finding) => finding.handlers > 0 && finding.withoutDelay === 0
    ),
    findings,
  };
};
