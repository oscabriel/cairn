// The brain's settings: where it listens, who it admits, where its data lives. Read once at boot.
// The deployed brain reads `~/.config/cairn/cairn.json` (written by `ops/cairn/install.sh`) and
// `CAIRN_*` variables, a variable winning over the file and the file over the defaults. Dev and
// judge brains read only `CAIRN_*`, with loopback defaults, so they never pick up the deployed
// brain's host or data dir.

import os from "node:os";
import path from "node:path";

import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";

/** The settings `cairn.json` may carry. Every key is optional; unknown keys are ignored. */
const CairnFile = Schema.Struct({
  owner: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(Schema.String),
  origin: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Int),
  dataDir: Schema.optionalKey(Schema.String),
});

type CairnFile = typeof CairnFile.Type;

const decodeCairnFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CairnFile)
);

const isListenPort = Schema.is(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65_535 }))
);

/** A settings file or variable that cannot be used. Boot stops; fix the named setting. */
export class ServerConfigError extends Schema.TaggedError<ServerConfigError>()(
  "ServerConfigError",
  {
    message: Schema.String,
    setting: Schema.String,
  }
) {}

/** The values every part of the brain reads; parsed once, never re-read. */
export interface ServerSettings {
  /** The `Host` header every request must carry (`code.gneiss.run`); otherwise 421. */
  readonly host: string;
  /** The exact `Origin` of Cairn's page (`https://code.gneiss.run`). */
  readonly origin: string;
  /** The one Tailscale login Cairn admits, exactly (`oscabriel@github`). */
  readonly owner: string;
  /** The address the listener binds; loopback only, Caddy is the way in. */
  readonly listenHost: string;
  /** The listener's port; 0 asks the kernel for a free one (dev and judges). */
  readonly port: number;
  /** The NVMe directory holding `cairn.sqlite`, `brain.sqlite` and attachments. */
  readonly dataDir: string;
  /** The directory holding `cairn.json`, signing keys and `brain.env`. */
  readonly configDir: string;
  /** The user's state directory (`$XDG_STATE_HOME`, else `~/.local/state`): the Executor lock. */
  readonly stateDir: string;
  /** The built web client (`apps/web/dist`), served as static files. */
  readonly webRoot: string;
  /** tailscaled's socket, for LocalAPI `whois`. */
  readonly tailscaleSocket: string;
  /** The `tailscale` CLI, the fallback when LocalAPI does not answer. */
  readonly tailscaleCli: string;
}

const home = os.homedir();

const defaultConfigDir = path.join(home, ".config", "cairn");

/** The web build beside this app, anchored to this file rather than the working directory. */
const defaultWebRoot = path.join(
  import.meta.dirname,
  "..",
  "..",
  "web",
  "dist"
);

/** What a brain falls back to when neither a variable nor the file sets a value. */
interface Defaults {
  /** Whether `cairn.json` is read at all. */
  readonly readFile: boolean;
  /** `None`: boot fails without an owner. */
  readonly owner: Option.Option<string>;
  readonly origin: string;
  readonly port: number;
  readonly dataDir: string;
}

const deployed: Defaults = {
  readFile: true,
  owner: Option.none(),
  origin: "https://code.gneiss.run",
  port: 3774,
  dataDir: path.join(home, ".local", "share", "cairn"),
};

const local: Defaults = {
  readFile: false,
  owner: Option.some("owner@loopback"),
  origin: "http://127.0.0.1",
  port: 0,
  dataDir: path.join(home, ".local", "share", "cairn-dev"),
};

const optionalString = (name: string) => Config.option(Config.String(name));

/** The user's home directory: `HOME` when set and not empty, else the platform's answer. */
export const homeDirectory: Effect.Effect<string> = Effect.gen(function* () {
  const fromEnv = yield* optionalString("HOME");

  return Option.getOrElse(
    Option.filter(fromEnv, (dir) => dir !== ""),
    () => home
  );
}).pipe(Effect.orElseSucceed(() => home));

/** `$XDG_STATE_HOME` when set and not empty, else `~/.local/state`. */
const stateDirectory = Effect.gen(function* () {
  const fromEnv = (yield* optionalString("XDG_STATE_HOME")).pipe(
    Option.filter((dir) => dir !== "")
  );

  if (Option.isSome(fromEnv)) {
    return fromEnv.value;
  }

  return path.join(yield* homeDirectory, ".local", "state");
});

const readCairnFile = Effect.fn("ServerConfig.readCairnFile")(function* (
  file: string
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));

  if (!exists) {
    return Option.none<CairnFile>();
  }

  const text = yield* fs.readFileString(file).pipe(
    Effect.mapError(
      () =>
        new ServerConfigError({
          message: `ServerConfig could not read ${file}. Check its permissions, or remove it to use the defaults and CAIRN_* variables.`,
          setting: file,
        })
    )
  );

  return Option.some(
    yield* decodeCairnFile(text).pipe(
      Effect.mapError(
        () =>
          new ServerConfigError({
            message: `ServerConfig found ${file} but it is not a JSON object with string host, origin, owner and dataDir and an integer port. Fix the file and restart.`,
            setting: file,
          })
      )
    )
  );
});

const hostOf = (origin: string) => {
  const parsed = URL.parse(origin);

  return parsed === null ? Option.none<string>() : Option.some(parsed.host);
};

const readSettings = Effect.fn("ServerConfig.readSettings")(
  function* (
    defaults: Defaults
  ): Effect.fn.Return<
    ServerSettings,
    ServerConfigError | Config.ConfigError,
    FileSystem.FileSystem
  > {
    const configDir = yield* Config.String("CAIRN_CONFIG_DIR").pipe(
      Config.withDefault(defaultConfigDir)
    );

    const file: CairnFile = defaults.readFile
      ? Option.getOrElse(
          yield* readCairnFile(path.join(configDir, "cairn.json")),
          () => ({})
        )
      : {};

    const owner = (yield* optionalString("CAIRN_OWNER")).pipe(
      Option.orElse(() => Option.fromNullishOr(file.owner)),
      Option.orElse(() => defaults.owner),
      Option.filter((login) => login.trim() !== "")
    );

    if (Option.isNone(owner)) {
      return yield* new ServerConfigError({
        message:
          "ServerConfig has no owner login. Set `owner` in ~/.config/cairn/cairn.json (ops/cairn/install.sh writes it from `tailscale whois`) or CAIRN_OWNER, then restart.",
        setting: "owner",
      });
    }

    const port = Option.getOrElse(
      yield* Config.option(Config.Int("CAIRN_PORT")),
      () => file.port ?? defaults.port
    );

    const portText = String(port);

    if (!isListenPort(port)) {
      return yield* new ServerConfigError({
        message: `ServerConfig port ${portText} is not between 0 and 65535. Fix CAIRN_PORT or the port in cairn.json.`,
        setting: "port",
      });
    }

    const origin = Option.getOrElse(
      yield* optionalString("CAIRN_ORIGIN"),
      () => file.origin ?? defaults.origin
    );

    const host = (yield* optionalString("CAIRN_HOST")).pipe(
      Option.orElse(() => Option.fromNullishOr(file.host)),
      Option.orElse(() => hostOf(origin))
    );

    if (Option.isNone(host)) {
      return yield* new ServerConfigError({
        message: `ServerConfig origin ${origin} is not a URL, so no host follows from it. Fix CAIRN_ORIGIN or set CAIRN_HOST.`,
        setting: "origin",
      });
    }

    return {
      host: host.value,
      origin,
      owner: owner.value,
      listenHost: Option.getOrElse(
        yield* optionalString("CAIRN_LISTEN_HOST"),
        () => "127.0.0.1"
      ),
      port,
      dataDir: Option.getOrElse(
        yield* optionalString("CAIRN_DATA_DIR"),
        () => file.dataDir ?? defaults.dataDir
      ),
      configDir,
      stateDir: yield* stateDirectory,
      webRoot: Option.getOrElse(
        yield* optionalString("CAIRN_WEB_ROOT"),
        () => defaultWebRoot
      ),
      tailscaleSocket: "/var/run/tailscale/tailscaled.sock",
      tailscaleCli: "tailscale",
    };
  },
  Effect.catchTag("ConfigError", (configError) =>
    Effect.fail(
      new ServerConfigError({
        message: `ServerConfig could not read a CAIRN_* variable: ${configError.message}. Fix the variable and restart.`,
        setting: "environment",
      })
    )
  )
);

/** The brain's settings. */
export class ServerConfig extends Context.Service<
  ServerConfig,
  ServerSettings
>()("cairn/server/Config/ServerConfig") {
  /**
   * The deployed brain's settings: `$CAIRN_CONFIG_DIR/cairn.json` (default `~/.config/cairn`), then
   * `CAIRN_HOST`, `CAIRN_ORIGIN`, `CAIRN_OWNER`, `CAIRN_LISTEN_HOST`, `CAIRN_PORT`,
   * `CAIRN_DATA_DIR`, `CAIRN_WEB_ROOT`. Port 3774, origin `https://code.gneiss.run`, the host from
   * the origin. Fails with `ServerConfigError` when no owner is set or a value is unusable.
   */
  static readonly layer = Layer.effect(ServerConfig, readSettings(deployed));

  /**
   * A dev or judge brain's settings: the same variables, no file. A free port, origin
   * `http://127.0.0.1` unless `CAIRN_ORIGIN` says otherwise, the host taken from the origin, owner
   * `owner@loopback` unless `CAIRN_OWNER` names one, data under `~/.local/share/cairn-dev`.
   */
  static readonly layerLocal = Layer.effect(ServerConfig, readSettings(local));

  /** Fixed settings for tests: a loopback listener on a free port and a temporary data dir. */
  static readonly layerWith = (overrides: Partial<ServerSettings>) =>
    Layer.succeed(
      ServerConfig,
      ServerConfig.of({
        host: "code.gneiss.run",
        origin: "https://code.gneiss.run",
        owner: "oscabriel@github",
        listenHost: "127.0.0.1",
        port: 0,
        dataDir: path.join(os.tmpdir(), "cairn-test"),
        configDir: path.join(os.tmpdir(), "cairn-test-config"),
        stateDir: path.join(os.tmpdir(), "cairn-test-state"),
        webRoot: defaultWebRoot,
        tailscaleSocket: "/var/run/tailscale/tailscaled.sock",
        tailscaleCli: "tailscale",
        ...overrides,
      })
    );
}
