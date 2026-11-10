// A fake porch for tests and the judge and dev brains (moved out of `PorchClient.ts`, so the
// deployed brain, which loads `PorchClient.ts`, loads no fake; ADR 0053). It refuses what porch
// refuses with the client's own input checks, and `judges/porch-contract.ts` holds it to the real
// binary through `PorchScenarios.ts`.

import { createHash } from "node:crypto";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Option, Ref } from "effect";

import {
  cairnFailure,
  checkName,
  checkPortalName,
  checkPublish,
  checkUpstream,
  PorchClient,
  porchRefusal,
} from "./PorchClient.ts";
import type { PorchKind, PorchRow } from "./PorchClient.ts";

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

/** `PorchClient` as a fake porch over a real artifacts folder (`makeFakePorch`). */
export const FakePorchLayer = (options: FakePorchOptions) =>
  Layer.effect(
    PorchClient,
    Effect.map(makeFakePorch(options), (fake) => fake.client)
  ).pipe(Layer.provide(NodeServices.layer));
