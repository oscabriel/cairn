# Cairn coding standards

Rules are numbered so reviews can cite them ("breaks S28"). Effect's own guidance in `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/` wins every conflict; if this document disagrees with it, fix this document. `pnpm check` (oxfmt, oxlint, tsc, vitest) is the gate. A rule marked _lint_ is enforced there, so the config is its source of truth and this document only gives the reason.

## Ground rules

- **S1.** Read the installed source before writing against an API: `node_modules/effect`, `node_modules/alchemy`, and the package's `AGENTS.md` or `ai-docs`. Effect v4 and Alchemy beta differ from training data and from web docs.
- **S2.** Keep the lint gate strict. Fix the code, not the rule. Suppress only through the S21 protocol. Allow-list the unstable Effect modules we adopt once, in `allowedUnstableApis` in `tsconfig.base.json` (today `@effect/platform-node`, `effect/FileSystem`, `effect/http`, `effect/http-api`, `effect/observability`, `effect/rpc`, `effect/sql`), never per line.
- **S3.** Write erasable TypeScript only: no `enum`, `namespace` or parameter properties (tsconfig `erasableSyntaxOnly`). Model a closed set with `Schema.Literals`.

## Modules and imports

- **S4.** Import Effect from its barrel, `import { Effect, Schema } from "effect"`, and its feature modules from their 4.0.5 entrypoints: `effect/http`, `effect/http-api`, `effect/sql`, `effect/observability`, `effect/testing` (_lint_). Alchemy modules keep Alchemy's namespace form: `import * as Cloudflare from "alchemy/Cloudflare"`.
- **S5.** Name a module file in PascalCase after its main export (`ThreadStore.ts`). Configs and scripts are kebab-case (_lint_).
- **S6.** Treat each `apps/*` as its own composition root: apps never import other apps, and `packages/*` never import apps. Move code into a package when a second consumer appears, not before. Inside an app, import by relative path.
- **S7.** Use `Predicate` helpers (`Predicate.isString`, `Predicate.hasProperty`) instead of hand-written guards or `typeof` checks (_lint_ for `typeof`).
- **S8.** Use `DateTime` and `Clock` for time, never `Date` or `Date.now()`, so `TestClock` controls it.
- **S9.** Order schema fields and object keys by meaning, not alphabetically: a schema's field order is its encoded order. Write arrays as `Array<A>` and `ReadonlyArray<A>`, as Effect does (_lint_). Data-first and pipe forms of combinators are both fine.

## Provenance and parsing

- **S10.** Choose handling from where a value came from:

  | Origin | Handling |
  | --- | --- |
  | Untrusted: request bodies, rows, storage, env, vendor data | Decode from `unknown` with the boundary's schema |
  | A known encoded form (a `string` the schema encodes to) | Typed decoder (`Schema.decodeEffect`) on exactly that encoded type |
  | A value our code already parsed or built | Pass it through unchanged |
  | A newly computed value with a new invariant | Owning constructor, refinement or `Schema.decodeTo` |

- **S11.** The adapter that owns an I/O boundary owns its decoding and its parse errors. Domain code and services receive parsed values, never bodies, rows or env strings. Encode only on the way out.
- **S12.** Build each codec once, privately, beside the schema's owner. Export a domain-named parser that takes the input type callers really hold. At a truly unknown boundary, call the private decoder directly instead of wrapping it in a function with an `unknown` parameter (_lint_). `HttpApi` decodes its own payloads; do not decode them twice.

  ```ts
  const ProjectPath = Schema.String.check(Schema.isPattern(/^\//u)).pipe(
    Schema.brand("ProjectPath")
  );
  export type ProjectPath = typeof ProjectPath.Type;

  const decodeProjectPath = Schema.decodeEffect(ProjectPath);

  /** Parse a path the user typed; fails with `SchemaError` unless it is absolute. */
  export const parseProjectPath = (input: string) => decodeProjectPath(input);
  ```

- **S13.** Use a typed decoder whenever the input already matches the schema's `Encoded` type (_lint_), and never cast an input to make a typed decoder accept it.
- **S14.** Skip tests that restate a schema's declaration. Test what we own (transformations, normalisation, round trips, past regressions) through the public boundary.

## Preserving type information

- **S15.** Keep the strongest type you have. Never widen a known value to `unknown`, `object` or a generic record to make an implementation easier (_lint_). Parameters and returns state what the function really takes and gives.
- **S16.** Establish a new invariant with its owner: a constructor, a refinement or a composed schema. Brands and `satisfies` do not prove computed facts. No JSON round trips to re-parse a value we already hold.
- **S17.** Reserve `unknown` for values that genuinely cross an untrusted runtime boundary, and parse them once at the nearest adapter. Inner code never re-narrows the same raw value.
- **S18.** Before adding `unknown`, a record type or `as`: find the value's origin, find the owner's type or schema, keep that type through the call chain, and if a library types something too broadly, prefer an upstream fix or a parsed adapter over a cast.
- **S19.** No `any`, no non-null `!`, no chained assertions such as `as unknown as T` (_lint_).
- **S20.** An assertion is allowed only at the smallest platform boundary where the runtime invariant is already established, or inside a library package's internals when it buys a better public API. Never inside an app's public signatures.
- **S21.** Every allowed assertion follows the SAFETY protocol, on one expression as close to the value's origin as possible: a `// SAFETY:` line proving the runtime type (_lint_), a `// Verified by:` line naming the tests that fail if the invariant breaks, and the narrowest disable for exactly the rules that fire.

  ```ts
  // SAFETY: `register` is the only writer and keys every entry by its own `kind`, so the
  // entry under `kind` is a `Handler<K>`. A Map cannot tie a key's type to its value's type.
  // Verified by: HandlerRegistry.test.ts "returns the handler registered for each kind"
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const handler = entries.get(kind) as Handler<K> | undefined;
  ```

## Optional values

- **S22.** Represent optional fields, parameters and results inside the app as `Option.Option<A>`, not `null`, `undefined` or `?:`.
- **S23.** Two carve-outs. Wire and serialized payloads (Workflow step outputs, DO storage, JSON over a link) keep a plain encoded side through `Schema.OptionFromNullOr` or `Schema.OptionFromOptionalKey`, and `HttpApi` query fields may use `Schema.optional`. A platform value narrowed locally (`map.get(id) === undefined`) is fine inside one function; convert it to `Option` before it leaves.

  ```ts
  const StepOutput = Schema.Struct({
    summary: Schema.OptionFromNullOr(Schema.String),
  });
  ```

## Effect style

- **S24.** Write inline Effect code with `Effect.gen`. Write a reusable function as `Effect.fn("Owner.method")` when it is a useful trace boundary, and as `Effect.fnUntraced` in library internals and hot paths. The span name matches the function's name. Never write a function that only returns an `Effect.gen` (_lint_).
- **S25.** Put business logic in generators: reading services, dependent steps, branches, loops and early returns. Use `.pipe` for cross-cutting policy (error translation, retry, timeout, spans, log annotations, provision) and for one pure `Effect.map`. Rewrite chains of dependent `map`/`flatMap`/`andThen` as a generator.
- **S26.** Pass policy to `Effect.fn` as extra arguments after the body, not with `.pipe`. Pass a pipeable combinator directly; use an `(effect, ...args) => ...` transform only when it needs the call's arguments.
- **S27.** Fail with `return yield* new SomeError({...})` (_lint_).
- **S28.** Keep `try`/`catch`, `async` functions and `new Promise` out of Effect code (_lint_ for `try`/`catch`). Promises enter through `Effect.tryPromise({ try, catch })`, whose `catch` builds a typed error carrying the cause.
- **S29.** Call `Effect.provide` only at entry points (_lint_). Run a process with `NodeRuntime.runMain` or `Layer.launch`.

## Error design

- **S30.** Define every expected failure with `Schema.TaggedError` from `"effect"`. Construct it with `new`, never by writing `_tag`, and never put the global `Error` in a failure channel (_lint_). Declare errors above the code that uses them.
- **S31.** Give each error typed context, not prose to parse: the operation, safe domain ids, a classified `reason`, whether retrying is safe, the `cause` (`Schema.Defect()`) where it helps diagnosis, and a `requestId` at public boundaries.
- **S32.** Write the message for the reader who must act. Name the operation that failed and the most specific safe reason, then the way forward: fix the input, retry (only if the operation is idempotent and nothing partially committed), inspect the named resource, or report the request id. Reassure only about what the code can prove. Stay calm and direct, with no blame or jokes. Start with words someone can search the codebase for.
- **S33.** When one operation fails in several ways that callers handle differently, use Effect's reason pattern: `reason: Schema.Union([...])` of tagged errors, handled with `Effect.catchReason`, `Effect.catchReasons` or `Effect.unwrapReason`. A plain literal `reason` is enough when callers only log or display it.
- **S34.** Translate errors per tag with `Effect.catchTag` or `Effect.catchTags`, and add no catch-all. Tags you do not list stay in the channel on purpose: the service's declared error type then turns a new failure into a compile error until someone decides its translation. `Effect.mapError` is fine when the whole channel has one meaning (_lint_ bans manual `_tag` branching in handlers).
- **S35.** Public errors are `HttpApi` error schemas: discriminated variants with literal codes and per-variant details, carrying `code`, `message`, `details`, `requestId` and `retryable`. Never expose secrets, tokens, raw bodies, SQL, stack traces, private causes or vendor responses, but keep the operation and the requested id.
- **S36.** Pick the status from what the caller can do: 400 fixable input, 401 not authenticated, 404 unknown id, 409 state conflict, 415 media type, 500 internal invariant, 503 temporarily unavailable.

## Services and layers

- **S37.** Define a service as `class X extends Context.Service<X, { ...shape }>()(id)` with the shape inline, its members written as method signatures as Effect's own examples do (`query(sql: string): Effect.Effect<...>`), and refer to its type as `X["Service"]`. The id is `"cairn/<pkg>/<path>/X"`, which also applies to `Schema.Class` identifiers. Name the capability (`ThreadStore`), with no `Tag` suffix and no `I`-prefixed interface.
- **S38.** Attach layers as statics: `layerNoDeps` builds the service and leaves its requirements in `R`; `layer` provides the production dependencies; `layerTest` provides faithful fakes. Build the implementation inline in `Layer.effect`, write methods with `Effect.fn("X.method")`, and return `X.of({...})`.
- **S39.** Keep dependencies in `R`: yield them inside the layer's Effect and let the composition root provide them. Never write `makeXLayer(dependency)` factories. Plain arguments are for parsed values and options only.
- **S40.** One service per file, in this order: imports, schemas and errors, then the service class with its layers. If construction is factored out, keep it module-private; an exported `makeX` may be imported only by tests (_lint_, relative imports only).
- **S41.** Use `Context.Reference` for a setting with a default, `Layer.unwrap` for a layer chosen from config, and `Config.Redacted` for secrets.

S30 to S41 together:

```ts
export class StartTurnError extends Schema.TaggedError<StartTurnError>()(
  "StartTurnError",
  {
    message: Schema.String,
    reason: Schema.Literals(["TurnAlreadyRunning", "HarnessUnavailable"]),
    retryable: Schema.Boolean,
    threadId: ThreadId,
  }
) {}

/** Starts agent turns on threads. */
export class TurnStarter extends Context.Service<
  TurnStarter,
  {
    /** Starts a turn on `threadId`; refuses while another turn is running. */
    start(
      threadId: ThreadId,
      prompt: Prompt
    ): Effect.Effect<TurnId, StartTurnError>;
  }
>()("cairn/server/threads/TurnStarter") {
  static readonly layerNoDeps = Layer.effect(
    TurnStarter,
    Effect.gen(function* () {
      const harness = yield* Harness;

      const start = Effect.fn("TurnStarter.start")(
        function* (threadId: ThreadId, prompt: Prompt) {
          const running = yield* harness.activeTurn(threadId);

          if (Option.isSome(running)) {
            return yield* new StartTurnError({
              message: `Thread ${threadId} is already running turn ${running.value}. Stop it or wait for it, then send again.`,
              reason: "TurnAlreadyRunning",
              retryable: false,
              threadId,
            });
          }

          return yield* harness.startTurn(threadId, prompt);
        },
        (effect, threadId) =>
          effect.pipe(
            Effect.catchTags({
              HarnessUnavailable: () =>
                Effect.fail(
                  new StartTurnError({
                    message: `The harness did not accept a turn for thread ${threadId}. Nothing started; send again.`,
                    reason: "HarnessUnavailable",
                    retryable: true,
                    threadId,
                  })
                ),
            })
          )
      );

      return TurnStarter.of({ start });
    })
  );

  static readonly layer = this.layerNoDeps.pipe(Layer.provide(Harness.layer));

  static readonly layerTest = this.layerNoDeps.pipe(
    Layer.provide(Harness.layerTest)
  );
}
```

## Plain TypeScript boundaries

- **S42.** Put each plain-JS library (the Sandbox SDK, the Agent SDK) behind exactly one Effect service. Only that service imports the library; its methods take and return Cairn schemas, and library types never escape it. Promises enter through `Effect.tryPromise`, and callbacks through `Effect.callback` or `Stream.callback`. A library that is the framework Cairn's code is written in gets a folder boundary instead of one service, because wrapping its API behind a Cairn service would only re-describe it: pi-durable is imported only under `apps/server/src/brain/`, in files named `*Extension.ts` and in `judges/fixtures/`; pi-ai at runtime only there, under `models/` and in `packages/bridge/`, while `import type` of its content types is fine anywhere in the server; pi-coding-agent's model runtime and skill loaders are imported only in `models/PiModelSource.ts`, `models/PiConfig.ts` and `skills/`. Everywhere else, code sees Cairn schemas and services. `no-restricted-imports` overrides in `oxlint.config.ts` enforce every boundary (_lint_), and `judges/lint-boundaries.test.ts` proves they fire.
- **S43.** Where non-Effect code calls into Cairn (a DO class, a pi-durable hook, a framework handler), build one `ManagedRuntime` per process or isolate from the app layer, run Effects through it at that edge, and dispose of it on shutdown. Never call `Effect.runPromise` from inside an Effect (_lint_).

  ```ts
  /** The isolate's one runtime; plain-JS entry points run Effects through it. */
  export const runtime = ManagedRuntime.make(StonesLayer, {
    memoMap: Layer.makeMemoMapUnsafe(),
  });

  // In the class the library requires:
  //   fetch(request: Request): Promise<Response> { return runtime.runPromise(handle(request)); }
  ```

## Durable Object HTTP boundary

- **S44.** Expose each Cairn Durable Object as an `HttpApi` served from its `fetch`, not through Alchemy's typed RPC. The HTTP boundary keeps the DO a separate logical service even inside one isolate. Define the API in a contracts module, apart from the server.
- **S45.** Name the DO `XServer` and the Effect service callers use `XClient`. Bindings, namespaces, stubs and generated clients stay inside the client module and the composition root.
- **S46.** Key every DO instance by its branded domain id (`getByName(workspaceId)`), never by a display name or caller label. Client methods take domain ids.
- **S47.** Build the stub and its HTTP client inside the current invocation, because a stub is tied to the caller's I/O context. Memoise per invocation with Alchemy's `makeExecutionMemo`, plus an unbounded `Cache` keyed by id when one invocation reaches several instances. Never hold a stub-backed client in a layer, `Layer.suspend`, `Layer.unwrap` or a global cache. Keep the resolver private to the client.

  ```ts
  // Inside WorkspaceClient.layerNoDeps; each method resolves its client with `clientFor(id)`.
  Effect.gen(function* () {
    const servers = yield* WorkspaceServer;

    const clients = yield* makeExecutionMemo(
      Cache.make({
        capacity: Number.POSITIVE_INFINITY,
        lookup: (id: WorkspaceId) =>
          Effect.suspend(() =>
            HttpApiClient.makeWith(WorkspaceApi, {
              baseUrl: "http://workspace.internal",
              httpClient: Cloudflare.toHttpClient(servers.getByName(id)),
            })
          ),
      })
    );

    const clientFor = (id: WorkspaceId) =>
      clients.pipe(Effect.flatMap((cache) => Cache.get(cache, id)));
  });
  ```

- **S48.** Version every route from `/v1`, with no unversioned aliases. Schema names carry no version suffix.
- **S49.** Exception: a DO that a library owns internally (pi-durable's, the Sandbox SDK's container DO) keeps that library's own protocol, RPC included. Wrap it per S42 and say so in the file header.

## Infrastructure and Alchemy

- **S50.** Import `alchemy/Cloudflare`, the beta.83 path. The `@alchemy.run/cloudflare` path shown at main.alchemy.run is not published yet; switch every file at once when it ships.
- **S51.** `alchemy.run.ts` is the composition root and the only Stack. It yields resources that live elsewhere, one resource or layer per file, next to the code that uses it.
- **S52.** Anchor every path a resource takes with `import.meta.url` or `import.meta.dirname`, never a cwd-relative string (_lint_ bans `__dirname`).

  ```ts
  export const Stones = Cloudflare.Worker("Stones", {
    compatibility: { date: "2026-10-01", flags: ["nodejs_compat"] },
    env: {
      WORKSPACE: Cloudflare.DurableObject("WorkspaceServer", {
        containers: [Workspace],
      }),
    },
    main: path.join(import.meta.dirname, "worker.ts"),
  });
  ```

- **S53.** Alchemy deploys, runs dev and tests. Never use wrangler: no `wrangler.toml`, no wrangler CLI.
- **S54.** Stages are `prod`, `live_$USER` (deploy), `dev_$USER` (`alchemy dev`) and `test_$USER` (`Test.make`). Every stage gets isolated infrastructure with the same topology. Use Alchemy's local providers where they exist; where one dependency has none, provision that whole connected subsystem per stage. Never route non-prod data through prod, and never point `alchemy dev` at `prod`.
- **S55.** Non-prod names are generated or stage-qualified, and retention follows the stage (`RemovalPolicy.retain()` for prod and permanent resources only). A resource shared across stages (an Axiom dataset, say) is a named exception: document its owner, lifecycle and local mode where it is declared.
- **S56.** Bind secrets with `Config.Redacted`. Never return them as Stack outputs or log them.

## Observability

- **S57.** Spans come from `Effect.fn("Owner.method")`; add `Effect.withSpan` and `Effect.annotateSpans` for meaningful sub-steps. Log with `Effect.log*` and `Effect.annotateLogs`, never `console`.
- **S58.** Export spans and logs over OTLP with `effect/observability`, into Axiom. Provision the datasets (`otel:traces:v1`, `otel:logs:v1`) and the ingest token with `alchemy/Axiom`. On hosts Alchemy runs, provide `Axiom.Telemetry({ token, traces, logs })`. On the homelab server, provide `Otlp.layerFromConfig` with `OtlpSerialization.layerJson` and `FetchHttpClient.layer` at the entry point, configured through the standard `OTEL_EXPORTER_OTLP_*` variables.
- **S59.** Give every inbound request one request id: return it in a response header, attach it to spans, and carry it in public errors. Keep span attribute names in one module.
- **S60.** Traces from a running system are the primary evidence that runtime behaviour works.

## Tests

- **S61.** Write tests with `@effect/vitest`: `it.effect` for Effect code, `layer(...)` and `it.layer` to share a layer across tests, and `TestClock` for time. Use `it.live` only when real time or real services are the point.
- **S62.** Replace dependencies with Layers, never module mocks (_lint_). A `layerTest` crosses the same service interface as production and behaves faithfully; it is not a partial stub.
- **S63.** Every claim needs an outside judge: a test that fails when the behaviour breaks, a trace from a deployed run, or an independent check. Watch a new test fail before trusting it pass. An assertion that recomputes the answer with the code under test proves nothing.

  ```ts
  layer(TurnStarter.layerTest)("TurnStarter", (it) => {
    it.effect("refuses a second turn while one is running", () =>
      Effect.gen(function* () {
        const starter = yield* TurnStarter;
        yield* starter.start(ThreadId.make("thr_1"), Prompt.make("hi"));

        const error = yield* Effect.flip(
          starter.start(ThreadId.make("thr_1"), Prompt.make("again"))
        );

        assert.strictEqual(error.reason, "TurnAlreadyRunning");
      })
    );
  });
  ```

## Ports from other repos

- **S64.** Port functionality and intent, not lines. Read the source to understand it, then write new code to these standards and Cairn's architecture: our services, schemas, errors and names.
- **S65.** Start every file that draws on another repo with a header naming the repo, the path and the commit. When the source is MIT, add its copyright line and permission notice. A repo with no license (cf-workflow-pool, effect-harness) supplies ideas only: no text, but still named.

  ```ts
  // Ported from github.com/pingdotgg/t3code, apps/server/src/<path>.ts
  // at 7e289ae1f77b9137580688aaccf00d48906984ad. Behaviour kept; code rewritten for Cairn.
  //
  // MIT License. Copyright (c) 2026 T3 Tools Inc.
  // Permission is hereby granted, free of charge, ... (full notice from the source LICENSE)
  ```

## Comments and JSDoc

- **S66.** Give every exported symbol, and every public member of an exported class, JSDoc at its original declaration. One sentence is enough when it states the sharpest fact the signature cannot; add more only for constraints, failures, side effects, invariants or trade-offs.
- **S67.** Describe typed failures in the summary or `@returns`; keep `@throws` for defects. Document a symbol once, where it is declared, with no `@inheritDoc`. Document object fields whose meaning goes beyond their name and type.
- **S68.** Use domain vocabulary readers will search for. Keep ticket names, phases and planning language out of names, docs and messages. Comment private code when a safe change depends on an invariant the code does not show.
