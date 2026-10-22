# Phase 1 notes: the Effect 4 server and Foldkit client skeleton

Researched 2026-10-22 against installed source: `effect@4.0.5`, `@effect/platform-node@4.0.5`, `@effect/platform-browser@4.0.5`, `@effect/sql-sqlite-node@4.0.5`, `@effect/vitest@4.0.5`, `foldkit@0.169.0`, `@foldkit/ui@0.169.0`, `@foldkit/vite-plugin@0.28.0`, `@foldkit/oxlint-plugin@0.15.3`, TypeScript 7.0.2, vitest 5.0.5, Node 26.11. Paths below are relative to the package root unless they start with `~`. The Foldkit clone at `~/Developer/clones/github.com/foldkit/foldkit` sits at `76fa0d1e` (0.168 era); every Foldkit shape quoted here was compiled and run against the installed 0.169.0.

This note covers the Effect and Foldkit building blocks. `server.md` owns the t3code protocol, shell store and harness design; `client.md` owns the t3code surfaces. Where they overlap this note adds what was measured or what breaks.

## Summary

- A complete walking skeleton was built and run outside the repo: a pnpm workspace with `packages/protocol`, `apps/server` and `apps/web`, using the real 4.0.5 and 0.169.0 packages and the repo's own lint stack. It typechecks under TS 7.0.2, passes 11 `@effect/vitest`, Story and Scene tests, builds with Vite 8.3.5 (342 KB, 112 KB gzip), and was driven in headless Chromium. The probe lived in `/tmp/cairn-ws` and `/tmp/effect-probe`; both are throwaway, so the code shapes below are the deliverable.
- One RPC group in `packages/protocol` (imports only `effect`) is used unchanged by the Node server, a Node test client and the Foldkit browser client. Foldkit's own `packages/typing-game/{shared,server,client}` uses the same split, so this is the supported shape. Schemas also export to JSON Schema, with one workaround for stream RPCs.
- The server shape that works: `NodeHttpServer.layer(createServer, {host, port, gracefulShutdownTimeout})` under `HttpRouter.serve`, a global Origin guard, `RpcServer` over `/ws` with `RpcSerialization.layerJson`, `HttpStaticServer.layer({spa: true})`, `SqliteClient` plus `SqliteMigrator.fromRecord`, and `NodeRuntime.runMain(Layer.launch(app))`. Measured on the Beelink: 0.16 ms p50 RPC round trip, 1,000 inserts with publish in 256 ms, a 1,000-row snapshot in 7 ms (65 KB).
- The browser client is a Foldkit `ManagedResource` that owns one `RpcClient` built with `Layer.build` inside `acquire`, with `retryPolicy: Schedule.recurs(0)` and a Model-owned backoff plus epoch. Under `kill -9` of the server, the page showed Backoff, and the first snapshot frame arrived about 230 ms after the restarted server listened (5 of 5 rounds, backoff capped at 2 s).
- Multi-page Foldkit is route union plus one Submodel per page (`Update.foldChild`, `Subscription.lift`, `h.submodel` with `viewInputs`). A file-paste Mount on the composer textarea was verified in Chromium (file paste default-prevented and delivered as a Message, text paste untouched). Story and Scene tests run under vitest 5 and happy-dom.
- Real traps found, each reproduced: `Effect.provide(layer)` closes a client socket as soon as `RpcClient.make` returns; SIGTERM with one open WebSocket takes 20 s unless `gracefulShutdownTimeout` is set; the SPA fallback only fires when the request says `Accept: text/html`; OTLP export stays off unless `OTEL_TRACES_EXPORTER=otlp` (and the logs equivalent) is set; handler stubs that return `never` silently turn the layer's `R` into `unknown`; `Schema.Number` is a lint warning (use `Schema.Finite` or `Schema.Int`).
- The repo's gate needs additions before this code can pass `pnpm check`: five new entries in `allowedUnstableApis`, an `oxc/no-barrel-file` override for Foldkit page folders, `vitest` `projects`, per-app tsconfigs, a `pnpm-workspace.yaml` catalog and override block (given below), and `@foldkit/oxlint-plugin` scoped to `apps/web`.
- Telemetry: `Otlp.layerFromConfig` is a no-op until the OTEL variables are set, and per-signal headers with URL-encoded values were verified against a local collector, which is the whole recipe for Axiom. It can be deferred at zero cost.
- Open choices with a recommendation are in "Risks and open questions"; the largest are connection state naming (do not report Connected before the first snapshot), the dev-server port (3775 and 3776 are taken), and whether to keep per-connection RPC servers (recommended yes).

## Facts with evidence

### Effect 4.0.5 packages and import paths

- `effect` contains the former platform, rpc, sql core, cli, ai and cluster under `effect/<name>` (`effect/rpc`, `effect/http`, `effect/http-api`, `effect/sql`, `effect/socket`, `effect/observability`, `effect/persistence`, `effect/schema`, `effect/testing`, `effect/process`, `effect/reactivity`). `effect/unstable/*` does not exist. `effect/src/index.ts` is the barrel; `import { Effect, Schema } from "effect"` works for the core modules.
- Separate packages, all `4.0.5` with peer `effect ^4.0.5`: `@effect/platform-node`, `@effect/platform-browser`, `@effect/sql-sqlite-node`, `@effect/vitest`. `@effect/sql-sqlite-node` has no dependency besides the peer and imports `node:sqlite` (`DatabaseSync`, `backup`): `@effect/sql-sqlite-node/src/SqliteClient.ts:1-16, 36`.
- Not yet in the repo's `node_modules`: `@effect/sql-sqlite-node`, `@effect/platform-browser`, `foldkit`, `@foldkit/*`. The repo currently has `effect`, `@effect/platform-node`, `@effect/vitest` only (`pnpm-workspace.yaml` catalog).
- Stability tags (the `@stability` doc line in each module) decide what `effecttsgo/unstable-api-usage` flags. Stable: `Config`, `PubSub`, `Stream`, `testing/TestClock`. Unstable: `rpc`, `http`, `http-api`, `sql`, `socket`, `schema/Model`, `persistence/KeyValueStore`, `FileSystem`, `observability`, `process`, `reactivity`, and every module in `@effect/platform-node`, `@effect/platform-browser`, `@effect/sql-sqlite-node`, `@effect/vitest`.
- `Schema.TaggedError` is at `effect/src/Schema.ts:16653`; `Schema.toJsonSchemaDocument` at `:17040`; `Schema.Finite` at `:7458`.
- Yieldable fibers: a `Fiber` is an Effect in v4, so tests join with `Fiber.join(fiber)` and `yield* fiber` works. A `Context.Service` class is not an Effect with `.asEffect()`; read it with `yield* Service` or `Service.use((s) => ...)`.

### RPC server and client

- `Rpc.make(tag, {payload, success, error, stream})`: payload may be a struct of fields; `stream: true` wraps `success` and `error` into `RpcSchema.Stream` and sets the plain error schema to `Never` (`effect/src/rpc/Rpc.ts:941`). Errors are declared with `Schema.TaggedError` and cross the socket typed: a real-WebSocket test received `ThreadNotFound` with its message intact.
- `RpcGroup.make(...)`, `.add`, `.merge`, `.prefix`, `.middleware(Mw)`, `.toLayer(handlers | Effect<handlers>)`, `.of(handlers)` (`rpc/RpcGroup.ts:37-178`).
- Server entry points (`rpc/RpcServer.ts`): `make(group, {disableTracing, spanPrefix, concurrency, disableFatalDefects})` at `:602` needs a `Protocol` and the handler context; `layerHttp({group, path, protocol: "websocket" | "http"})` at `:946` registers one shared server on the `HttpRouter`; `makeProtocolWithHttpEffectWebsocket` at `:1060` returns `{protocol, httpEffect}` so a route can build one server per socket (what t3code does at `~/Developer/clones/github.com/pingdotgg/t3code` `fe27e8e3:apps/server/src/ws.ts:3129-3180`, and what v1 did in `~/Developer/projects/cairn-v1/apps/server/src/Http.ts:77-104`).
- `disableFatalDefects: true` (`:129, 326-331`): without it a handler defect is sent as a connection-level defect; with it the defect fails only that request. t3code and v1 both set it.
- Stream flow control: with WebSocket the server writes a chunk, then waits on a per-request latch for the client's `Ack` before the next (`:443-455`). A slow client therefore stalls its own stream, and whatever the handler's source queue buffers in the meantime is the handler's problem.
- Connection headers: the WebSocket upgrade request's headers are appended to every RPC request's `headers` (`:1659-1660`). An `RpcMiddleware.Service` reads them (`options.headers`), so identity decided at the upgrade reaches handlers as a service without being in any payload. Verified: a `Viewer` service provided by `ViewerMiddleware` from header `x-cairn-login`, with a missing header failing as a typed `Unauthorized`.
- Client (`rpc/RpcClient.ts`): `make(group)` at `:643` needs `Protocol | Scope`; `layerProtocolSocket({pingInterval, pingTimeout, retryTransientErrors, retryPolicy, onTransientError, onPingTimeout})` at `:1293` needs `Socket | RpcSerialization`; the default retry is `min(exponential(500, 1.5), spaced(5000))` forever (`:1239`); ping defaults to 5 s and the timeout measures time since the last decoded frame. `RpcClient.withHeaders` (`:850`) and per-call `{headers}` exist.
- Sockets: `Socket.layerWebSocket(url | Effect<string>, {openTimeout, protocols, headers, highWaterMark})` (`effect/src/socket/Socket.ts:1226`) with `Socket.layerWebSocketConstructorGlobal` (`:877`) in the browser. `@effect/platform-browser` also has `BrowserSocket.layerWebSocket(url: string)` but takes a string only. In Node, `NodeSocket.layerWebSocket(url, {headers})` uses the global WebSocket for plain calls and `ws` when headers are given (`@effect/platform-node/src/NodeSocket.ts:25-90`), which is how a Node test client sends an `Origin`.
- Serialization: `RpcSerialization.layerJson` carries streams over WebSocket. `layerNdjson` is for HTTP.
- `RpcTest.makeClient(group)` connects a client to the group's handlers in memory with no serialization (`rpc/RpcTest.ts`), which is the right unit-level judge for handlers and streams.
- `RpcSchema.isStreamSchema` is typed; `RpcSchema.getStreamSchemas` exists at runtime but is missing from the published `.d.ts`. Use `RpcSchema.isStreamSchema(s) ? s.success : s`.
- Typing trap: a handler stub that returns `never` (for example `() => { throw ... }`) makes `group.toLayer(...)` come out as `Layer<..., never, unknown>`, and every later requirement check passes silently. Stub with `Effect.die("unused")` or `Stream.empty`.

### HTTP server

- `NodeHttpServer.layer(evaluate, options)` at `@effect/platform-node/src/NodeHttpServer.ts:479` provides `HttpServer | HttpPlatform | Etag.Generator | NodeServices`. Options extend `net.ListenOptions` plus `gracefulShutdownTimeout` (default 20 s), `disablePreemptiveShutdown` and `websocket` (forwarded to `ws`, for example `{perMessageDeflate: true}`) (`:77-95`). `layerTest` at `:522` serves on an ephemeral port with a fetch client.
- `HttpRouter` (`effect/src/http/HttpRouter.ts`): `add(method, path, handler)` `:572` returns a Layer; `middleware(fn, {global: true})` `:1069` returns a Layer to merge into the routes; `serve(layer, {disableLogger, middleware})` `:1387` builds the layer in a forked `MemoMap` and returns a Layer needing `HttpServer`. Default request logging prints an Info line per request, including each WebSocket upgrade when it closes; v1 passed `disableLogger: true`.
- `HttpStaticServer.layer({root, index, spa, cacheControl, mimeTypes, prefix})` (`http/HttpStaticServer.ts:242`) registers `GET /*`. The SPA fallback fires only for a missing path with no extension whose request has an `Accept` containing `text/html` (`:195-203`, `acceptsHtml` at `:424`). A `curl` without that header gets 404 on `/t/abc`, a browser gets `index.html`. Specific routes (`/ws`, `/healthz`) win over `/*`.
- Graceful shutdown with an open WebSocket: measured 20 s from SIGTERM to exit by default, and 2 s with `gracefulShutdownTimeout: "2 seconds"`; the client sees close code 1001 either way. `NodeRuntime.runMain` exits 130 on SIGTERM, so a systemd unit needs `SuccessExitStatus=130`.
- `HttpApi` (`effect/src/http-api`) covers schema-first REST with `HttpApiSchema.asUint8Array`, `asMultipart`, `asMultipartStream`, `asText`, `asJson`, `StreamSse`, `HttpApiMiddleware`, `HttpApiSecurity`, `HttpApiClient`, `HttpApiTest`, `HttpApiScalar` (OpenAPI). v1 wrote uploads by hand with `HttpIncomingMessage.MaxBodySize` (`~/Developer/projects/cairn-v1/apps/server/src/Http.ts:109-130`).

### SQL on node:sqlite

- `SqliteClient.layer({filename, readonly, disableWAL, busyTimeout, prepareCacheSize, prepareCacheTTL, spanAttributes, transformResultNames, transformQueryNames})` (`@effect/sql-sqlite-node/src/SqliteClient.ts:401`). One connection, WAL on, 5 s busy timeout, `BEGIN IMMEDIATE` for writable transactions, no streaming queries, `backup(destination)` and `loadExtension`. `ExperimentalWarning` did not print on Node 26.11.
- `SqliteMigrator.layer({loader, table?, schemaDirectory?})` (`SqliteMigrator.ts:87`) is `Layer.effectDiscard(run(...))`. Loaders: `fromRecord({"0001_name": Effect})` (`effect/src/sql/Migrator.ts:410`), `fromFileSystem(dir)` `:441` (dynamic imports `<id>_<name>.ts|js|mjs|mts`), `fromGlob`. Combine with `Layer.provideMerge(SqliteClient.layer(...))` so anything built on top sees a migrated database.
- `SqlSchema.findAll/findOne/findOneOption/findNonEmpty/void`, `SqlModel.makeRepository`, `Model.Class` (`effect/schema`), and `sql.withTransaction` exist. `sql.reactive(keys, effect)` and `reactiveMailbox` give query-invalidation streams; not used in the probe.
- Measured with a file database on the Beelink NVMe (WAL): 1,000 sequential `threads.create` calls over the socket (two statements in a transaction plus a publish) took 256 ms.

### Observability

- `Otlp.layerFromConfig({resource})` (`effect/src/observability/Otlp.ts:104`) needs `HttpClient | OtlpSerialization`, so provide `OtlpSerialization.layerJson` and `FetchHttpClient.layer`. With no configuration it returns only a flusher layer, which is a no-op.
- Export requires `OTEL_EXPORTER_OTLP_ENDPOINT` (base URL; `/v1/traces` and `/v1/logs` are appended) and also `OTEL_TRACES_EXPORTER=otlp` and `OTEL_LOGS_EXPORTER=otlp` (the exporter list defaults to empty, `observability/internal/otlpEnv.ts`). Verified against a local collector: POSTs to `/v1/logs` and `/v1/traces` with JSON bodies.
- Headers: `OTEL_EXPORTER_OTLP_TRACES_HEADERS` and `..._LOGS_HEADERS` override `OTEL_EXPORTER_OTLP_HEADERS`; values are URI-decoded (`Authorization=Bearer%20<token>,X-Axiom-Dataset=<dataset>`). Verified with a fake token that the collector received `Authorization: Bearer ...` and the per-signal dataset. This is everything ADR 0006's Axiom path needs from the server side; the datasets and token come from the Alchemy stack.
- Logging: `Logger.layer([Logger.consolePretty()], {mergeWithExisting: false})` plus `Layer.succeed(References.MinimumLogLevel, level)` from `Config.LogLevel("CAIRN_LOG_LEVEL")`; `Logger.consoleJson` for structured output (v1 `Logger.ts`).

### Testing

- `@effect/vitest`: `it.effect`, `it.live`, `layer(L)(name, it => ...)`, `it.effect.each`, `it.effect.prop`, `TestClock` from `effect/testing`. Inside `layer(...)` the `it` is `MethodsNonLive`, so there is no `it.live`; pass `layer(L, {excludeTestServices: true})` to run `it.effect` with the real clock (needed for real sockets). `RpcTest.makeClient` needs a `Scope`: use `Effect.scoped` in plain `it.effect`.
- A real-socket test needs the client socket tied to the test's scope: build the protocol with `Layer.build` and provide the resulting context to `RpcClient.make`. The first attempt used `Effect.provide(protocolLayer)`, the socket closed as `make` returned, and both tests timed out at 5 s.
- Incremental `pnpm install` after a dependency change left two `vitest` instances in the virtual store and every `@effect/vitest` suite failed with "Vitest failed to find the current suite" or "Cannot read properties of undefined (reading 'config')". `rm -rf node_modules && pnpm install` fixed it twice. The repo's own store already holds two `@effect/vitest` variants; its single test file works today.
- `vitest` 5 `test.projects: ["apps/*", "packages/*"]` works with a per-app `vitest.config.ts` (`apps/web` uses `environment: "happy-dom"`, a setup file that calls `setup()` from `foldkit/test/vitest`, and `server.deps.inline: ["foldkit", "@foldkit/ui"]`); an app without a config runs in Node.

### Foldkit 0.169.0

- Peer pins: `foldkit` and `@foldkit/ui` peer `effect: 4.0.0` and `@effect/platform-browser: 4.0.0`; `@foldkit/vite-plugin@0.28.0` depends on `@effect/platform-node: 4.0.0` and `@effect/platform-node-shared: 4.0.0`. With pnpm `overrides` for those four names set to 4.0.5, a clean install shows no unmet-peer warning and exactly one copy of `effect` and of `@effect/platform-node-shared`. Without the `platform-node-shared` override a second copy (4.0.0) stays in the store (stale installs hide this, so check after a clean install).
- 0.169.0 is `latest` on npm (2026-10-21). The Blocks and Layers redesign (`foldkit/foldkit#1655`) is still open, last updated 2026-10-21. #1697 (keystroke loss) is closed and fixed in 0.169.0 (`spikes/2-foldkit/NOTES.md`).
- Public surface (`foldkit/dist/index.d.ts`): `Command`, `ManagedResource`, `Message` (`defineMessageUnion`), `Mount`, `Navigation` (`pushUrl`, `load`, `UrlRequest`), `Route`, `Runtime`, `Schema` (`defineTaggedUnion`), `Struct` (`modifyFields`), `Submodel` (`defineView`), `Subscription`, `Update` (`foldChild`, `foldChildAt`, `combine`, `withOutMessage`), `Url`, `Dom`, `File`, `Http`, `Render`, `AsyncData`, plus `foldkit/story`, `foldkit/scene`, `foldkit/test/vitest`.
- `ManagedResource.make<Model, Message>()(entry => ({key: entry(requirementsSchema, {resource, modelToMaybeRequirements, acquire, release, onAcquired, onReleased, onAcquireError})}))` (`foldkit/dist/managedResource/managedResource.d.ts`); `acquire` runs in the resource's `Scope`, so `Layer.build` and finalizers are torn down on release; reading it from a Command or Subscription is `Resource.get`, failing with `ResourceNotAvailable`.
- `Subscription.make<Model, Message, Services>()(entry => ({key: entry(depFields, {modelToDependencies, dependenciesToStream})}))`, `Subscription.lift(childSubs)({read, toParentMessage, when})`, `Subscription.aggregate(a, b)`, `Subscription.persistentEntry(stream)`. The stream's error type is `never`; a defect crashes the runtime, so map `catchCause` to a Message.
- `Mount.define` and `Mount.defineStream(name, {args?, messages, execute({element, viewStateChanges, ...args})})`, attached with `h.OnMount(Def())`. `foldkit/dom` gives `streamFromEventFilterMapPreventDefault({target, type, filterMapEvent, options})`, which calls `preventDefault` only for events the filter keeps.
- Routing: `defineRouteUnion`, `literal`, `slash`, `string`, `Route.root`, `Route.mapTo`, `Route.oneOf`, `Route.parseUrlWithFallback`, `Route.query`. `makeApplication({routing: {onUrlRequest, onUrlChange}})`; `init(url)` receives the URL when routing is configured.
- Submodel pattern, taken from `~/Developer/clones/github.com/foldkit/foldkit/packages/typing-game/client/src`: root `Model` holds `route` plus one child model per page; root `Message` has `GotXMessage` wrappers; `Update.foldChild({update, read, write, toParentMessage, foldOutMessage})`; the view embeds `h.submodel({slotId, model, view, viewInputs, toParentMessage})` in an `AppRoute.match`; page folders re-export `Model`, `Message`, `OutMessage`, `init`, `update`, `view`, `subscriptions` from an `index.ts`.
- `@foldkit/oxlint-plugin@0.15.3` works with oxlint 1.89: its `recommended.json` ran over the probe and caught `no-hardcoded-route-strings` (`Href("/t/...")` should print through the router). ratstack scopes it to `apps/web/src` with an `overrides` block (`~/Developer/clones/github.com/joelhooks/rat-stack/oxlint.config.ts`).

### What the repo's gate does to this code

Running the repo's own `oxlint.config.ts`, `tools/oxlint` and `tsconfig.base.json` (copied, with `effect-tsgo patch --oxlint`) over the probe:

- `effecttsgo/unstable-api-usage` warnings (warnings fail the gate): `effect/socket/Socket#layerWebSocket`, `Socket#layerWebSocketConstructorGlobal`, `@effect/sql-sqlite-node/SqliteClient#layer`, `SqliteMigrator#layer`. Add to `allowedUnstableApis`: `@effect/sql-sqlite-node`, `@effect/platform-browser`, `effect/socket`, `effect/persistence`, `effect/schema`. `effect/process` joins when git/process work lands. Tests are already exempt for `@effect/vitest`.
- `effecttsgo/schema-number` warnings on every `Schema.Number`: use `Schema.Finite`, `Schema.Int` or `Schema.NonNegativeInt`. It also keeps `"Infinity"` out of the exported JSON Schema.
- `anti-slop-effect/no-manual-tagged-construction` on object literals like `{_tag: "Snapshot", ...}` and `no-manual-tag-comparison` on `x._tag === "Snapshot"`: build with `Schema.TaggedStruct(...).make` or the union member's constructor and branch with `Match.tag`/`Predicate.isTagged`. Define each union member as its own named `TaggedStruct`, then `Schema.Union([...])`.
- `oxc/no-barrel-file` rejects Foldkit's page `index.ts` re-exports (`export * as Model from "./model"` reported 455 and 1,127 loaded modules). Add an override for `apps/web/src/page/**/index.ts`; Foldkit's conventions, the oxlint plugin and its skills assume the barrel (`packages/website/src/page/projectOrganization.md`). The alternative is one file per page, which loses the folder structure.
- Style rules that fire on ordinary Effect code: `anti-slop/require-readable-spacing` (54 hits, fixed by `oxlint --fix`), `typescript/dot-notation` (`request.headers.origin`, not `["origin"]`), `import/consistent-type-specifier-style`, `typescript/consistent-type-imports`, `eslint/curly`, `typescript/no-non-null-assertion` (`document.getElementById("root")!` in `main.ts`), `vitest/consistent-test-it` (use `it`, not `test`, inside `describe`), `typescript/promise-function-async` (listeners passed to pi-durable's `WatchHandle.start` must be `async`), `anti-slop/no-known-value-widening` (an explicit return type on `init`), `unicorn/filename-case` (`jsonSchema.ts` must be `JsonSchema.ts` or `json-schema.ts`).
- `Effect.runPromiseWith(context)` inside an `Effect.fnUntraced` body (the pi-durable watch bridge below) did not trigger the `runPromise` ban.

## What Cairn should build

### Workspace, catalog and gate changes (one commit, before any feature)

`pnpm-workspace.yaml` catalog additions (all verified together): `"@effect/platform-browser": 4.0.5`, `"@effect/sql-sqlite-node": 4.0.5`, `foldkit: 0.169.0`, `"@foldkit/ui": 0.169.0`, `"@foldkit/vite-plugin": 0.28.0`, `"@foldkit/oxlint-plugin": 0.15.3`, `vite: 8.3.5`, `happy-dom: 20.14.6`, `tailwindcss: 4.3.3`, `"@tailwindcss/vite": 4.3.3`. Move `typescript: 7.0.2` and `vitest: 5.0.5` into the catalog too; the root `package.json` pins them directly today although the rule says the catalog. `@effect/sql-sqlite-do` waits for Phase 3. `@effect/atom-react` and `@effect/opentelemetry` are not needed.

Overrides block (extend the existing one):

```yaml
overrides:
  effect: 4.0.5
  "@effect/platform-browser": 4.0.5
  "@effect/platform-node": 4.0.5
  "@effect/platform-node-shared": 4.0.5
```

Other gate changes:

- `tsconfig.base.json`: add the five `allowedUnstableApis` entries above. Apps get their own tsconfig extending it: `apps/server` (`lib: ["ESNext"]`, `types: ["node"]`), `apps/web` (`lib` with `DOM`, `DOM.Iterable`, `types: ["vite/client"]`), `packages/protocol` (`lib: ["ESNext"]`, no types). Each has a `typecheck` script `tsc -p .` so root `pnpm typecheck` (`pnpm -r --if-present typecheck`) picks them up. Do not put `foldkit` imports in `apps/server`.
- `vitest.config.ts`: `test: { projects: ["apps/*", "packages/*"] }` and keep the `spikes/**` exclude. Put `vitest` and `@effect/vitest` in the root `package.json` only; keep `happy-dom` in `apps/web`.
- `oxlint.config.ts`: the `no-barrel-file` override for `apps/web/src/page/**/index.ts`; the Foldkit plugin scoped as ratstack does (`foldkitRecommended.rules` and `.overrides` rewritten under `apps/web/src/`), with severities mapped to `error` or `off` because `denyWarnings` is on.
- `apps/web/vite.config.ts`: `plugins: [foldkit(), tailwindcss()]`, `server: {host: "127.0.0.1"}`, `build: {outDir: "dist"}`. The port question is under "Risks".

### Package and file layout (the skeleton slice)

`server.md` and `client.md` list the full Phase 1 trees. The skeleton slice that proves every seam, and the only files this note defines:

```
packages/protocol/src/
  Ids.ts            ProjectId, ThreadId (branded strings)
  Shell.ts          ThreadRow, ShellEvent, ShellItem (Snapshot | Event)
  Rpc.ts            CairnRpcs, error schemas, ViewerMiddleware (see shapes)
  JsonSchema.ts     rpcJsonSchemas() for the GPUI path
apps/server/src/
  main.ts           composition root: Layer.launch, NodeRuntime.runMain
  Config.ts         ServerConfig (Config.* with defaults)
  Observability.ts  LoggingLive, TelemetryLive
  Database.ts       SqliteClient + SqliteMigrator.fromRecord; DatabaseTest (:memory:)
  migrations/0001_*.ts ...   one Effect per file, imported into the record
  http/Guard.ts     Origin + identity middleware (global)
  http/Http.ts      routes, RPC mount, static, healthz
  rpc/Handlers.ts   CairnRpcs.toLayer, thin calls into services
  shell/Shell.ts    event log + snapshot + PubSub (server.md owns the design)
  harness/WatchStream.ts   pi-durable WatchHandle -> Stream (S42 boundary helper)
apps/web/src/
  main.ts model.ts message.ts update.ts view.ts subscription.ts command.ts route.ts connection.ts
  page/<name>/{index,model,message,update,view,mount,subscription}.ts   one folder per route
```

### Shapes (compiled against the installed packages)

The probe used Effect's own style; port with Cairn's ids (`cairn/server/...`), JSDoc and the lint adjustments listed above.

Protocol, importable by Node, the browser and a test (only `effect` is imported):

```ts
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export const ShellItem = Schema.Union([
  Schema.TaggedStruct("Snapshot", { snapshot: ShellSnapshot }),
  Schema.TaggedStruct("Event", { event: ShellEvent }),
]);

export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()(
  "ThreadNotFound",
  { id: ThreadId, message: Schema.String }
) {}

export const CairnRpcs = RpcGroup.make(
  Rpc.make("shell.watch", {
    payload: { afterSequence: Schema.optionalKey(Schema.Int) },
    success: ShellItem,
    stream: true,
  }),
  Rpc.make("threads.rename", {
    payload: { id: ThreadId, title: Schema.String },
    success: Schema.Void,
    error: ThreadNotFound,
  })
);
```

Per-request identity from the upgrade headers (protocol side declares, server side implements):

```ts
export class Viewer extends Context.Service<Viewer, { readonly login: string }>()("cairn/protocol/Viewer") {}
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", { message: Schema.String }) {}
export class ViewerMiddleware extends RpcMiddleware.Service<ViewerMiddleware, { provides: Viewer }>()(
  "cairn/protocol/ViewerMiddleware", { error: Unauthorized }
) {}
export const CairnRpcsWithViewer = CairnRpcs.add(WhoAmI).middleware(ViewerMiddleware);

// server
const ViewerLive = Layer.succeed(ViewerMiddleware, ViewerMiddleware.of((effect, { headers }) =>
  Effect.gen(function* () {
    const login = headers["x-cairn-login"];
    if (login === undefined) return yield* new Unauthorized({ message: "No login on the request." });
    return yield* Effect.provideService(effect, Viewer, { login });
  })
));
```

Server composition (verified by running it as `node apps/server/src/main.ts`; Node 26 strips types, and a workspace package whose `exports` point at `./src/index.ts` resolves through the symlink without the `node_modules` type-stripping refusal):

```ts
const ServerLive = Layer.unwrap(Effect.gen(function* () {
  const { host, port } = yield* ServerConfig;
  return NodeHttpServer.layer(createServer, { host, port, gracefulShutdownTimeout: "2 seconds" });
}));

const AppLive = HttpLive.pipe(
  Layer.provide(Shell.layerNoDeps),
  Layer.provide(DatabaseLive),
  Layer.provide(ServerLive),
  Layer.provide(ServerConfig.layer),
  Layer.provide(TelemetryLive),
  Layer.provide(LoggingLive)
);
NodeRuntime.runMain(Layer.launch(AppLive));
```

HTTP: a global guard, the RPC route, static files.

```ts
export const OriginGuard = HttpRouter.middleware(
  (httpEffect) => Effect.gen(function* () {
    const config = yield* ServerConfig;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
    if ((upgrade || !SAFE_METHODS.has(request.method)) && request.headers.origin !== config.origin)
      return HttpServerResponse.text("Origin refused.\n", { status: 403 });
    return yield* httpEffect;
  }),
  { global: true }
);

// Skeleton: one shared server per route. Phase 1 (per-connection state, see Risks): build
// RpcServer.makeProtocolWithHttpEffectWebsocket in the GET /ws handler and run
// RpcServer.make(CairnRpcs, { disableTracing: true, disableFatalDefects: true }) with Effect.forkScoped.
const RpcRoute = RpcServer.layerHttp({ group: CairnRpcs, path: "/ws", protocol: "websocket" }).pipe(
  Layer.provide(HandlersLive),
  Layer.provide(RpcSerialization.layerJson)
);
const StaticRoutes = HttpStaticServer.layer({ root: webRoot, index: "index.html", spa: true, cacheControl: "no-cache" });
export const HttpLive = HttpRouter.serve(Layer.mergeAll(RpcRoute, Health, StaticRoutes, OriginGuard));
```

`/api/*`, `/ws` and `/assets/*` need their own 404 handling ahead of the static route (v1 `Http.ts:219-250`): a browser request for `/api/missing` with `Accept: text/html` would otherwise get `index.html`. Hashed `/assets/*` can take `cache-control: immutable` through a second `HttpStaticServer.make` (`index: undefined`).

Database:

```ts
const migrations = SqliteMigrator.fromRecord({
  "0001_shell": Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; yield* sql`CREATE TABLE ...`; }),
});
export const DatabaseLive = Layer.unwrap(Effect.gen(function* () {
  const { dbPath } = yield* ServerConfig;
  return SqliteMigrator.layer({ loader: migrations }).pipe(Layer.provideMerge(SqliteClient.layer({ filename: dbPath })));
}));
export const DatabaseTest = SqliteMigrator.layer({ loader: migrations }).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })));
```

Prefer `fromRecord` with explicit imports over `fromFileSystem`: it is type-checked, needs no `FileSystem`/`Path` services, and survives bundling. Keep the snapshot-then-events stream pattern (subscribe to the `PubSub` first, read the head, then drop events at or below it): the probe's `Shell.watch` does this and passed live, resume and `kill -9` checks.

pi-durable watch as an RPC stream (S42 helper; the structural `WatchHandleLike` mirrors `WatchHandle<T>` in `pi-durable/dist/types.d.ts:905`; `start`'s listener returns a Promise, which is the backpressure channel):

```ts
export const watchToStream = <T, Ops, E>(open: Effect.Effect<WatchHandleLike<T, Ops>, E>) =>
  Stream.callback<WatchFrame<T, Ops>, E>(
    Effect.fnUntraced(function* (queue) {
      const handle = yield* Effect.acquireRelease(open, (h) => Effect.promise(() => h.stop()));
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      yield* Queue.offer(queue, { kind: "snapshot", value: handle.value });
      handle.start(async (value, ops) => run(Queue.offer(queue, { kind: "ops", value, ops }).pipe(Effect.asVoid)));
      yield* Effect.promise(() => handle.closed).pipe(Effect.andThen(Queue.end(queue)), Effect.forkScoped);
    }),
    { bufferSize: 1, strategy: "suspend" }
  );
```

Two vitest cases passed against a fake handle: snapshot then ops, with the handle stopped when the consumer stops taking; and the stream ending when the watch closes by itself. `Queue.offer` on a bounded suspending queue does not resolve until the consumer pulls, so a slow client slows pi-durable's bounded frame buffer instead of growing ours. `server.md` suggests `bufferSize: 16`; either is fine, the point is `strategy: "suspend"`.

Browser connection (Foldkit `ManagedResource`, Model-owned reconnect):

```ts
export const CairnConnection = ManagedResource.tag<CairnClient>()("CairnConnection");

const ProtocolLive = RpcClient.layerProtocolSocket({ retryPolicy: Schedule.recurs(0), pingInterval: "3 seconds" }).pipe(
  Layer.provide(Socket.layerWebSocket(Effect.sync(() => `${location.origin.replace(/^http/, "ws")}/ws`))),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson)
);
export const acquireClient = Effect.gen(function* () {
  const context = yield* Layer.build(ProtocolLive);               // not Effect.provide(layer)
  return yield* RpcClient.make(CairnRpcs).pipe(Effect.provide(context));
});

export const managedResources = ManagedResource.make<Model, Message>()((entry) => ({
  connection: entry(Schema.Option(Schema.Struct({ epoch: Schema.Int })), {
    resource: CairnConnection,
    modelToMaybeRequirements: (model) => Option.some({ epoch: model.epoch }),
    acquire: () => acquireClient,
    release: () => Effect.void,
    onAcquired: () => Message.AcquiredConnection(),
    onReleased: () => Message.ReleasedConnection(),
    onAcquireError: (error) => Message.FailedAcquireConnection({ reason: String(error) }),
  }),
}));
```

Update side: `LostConnection` and `FailedAcquireConnection` move to `Backoff{attempt}` and return `WaitForBackoff`; `WaitedForBackoff` bumps `epoch` and sets `Connecting`; `AcquiredConnection` is the only place that clears the Backoff. Gate every stream on the connection state, not on user intent.

Shell subscription, gated by connection and re-issued on every new epoch:

```ts
shell: entry({ epoch: Schema.Int, isConnected: Schema.Boolean }, {
  modelToDependencies: (model) => ({ epoch: model.epoch, isConnected: model.connection._tag === "Connected" }),
  dependenciesToStream: ({ isConnected }) => (isConnected ? shellStream(0) : Stream.empty),
})
const shellStream = (after: number) => Stream.unwrap(CairnConnection.get.pipe(
  Effect.map((client) => client["shell.watch"](after === 0 ? {} : { afterSequence: after }).pipe(
    Stream.map((item) => Message.ReceivedShellItem({ item })),
    Stream.concat(Stream.make(Message.LostConnection({ reason: "shell.watch ended" }))),
    Stream.catchCause((cause) => Stream.make(Message.LostConnection({ reason: Cause.pretty(cause) }))))),
  Effect.catchTag("ResourceNotAvailable", () => Effect.succeed(Stream.empty))));
```

Pages as Submodels, parent side (shape from the typing-game):

```ts
const foldThread = Update.foldChild({
  update: Thread.update,
  read: (model: Model) => Option.some(model.thread),
  write: (model: Model, thread: Thread.Model.Model) => modifyFields(model, { thread: () => thread }),
  toParentMessage: (message: Thread.Message): Message => Message.GotThreadMessage({ message }),
  foldOutMessage: (_out: Thread.OutMessage): Update.Step<Model, Message, Services> => (model) => ({ model }),
});
// view: AppRoute.match(model.route, { Thread: ({ threadId }) => h.submodel({ slotId: "thread", model: model.thread,
//   view: Thread.view, viewInputs: { threadId, title }, toParentMessage: (message) => Message.GotThreadMessage({ message }) }), ... })
```

Page state lives in the parent Model under its own key, so leaving and returning to a page keeps its draft. Per-route subscriptions use `Subscription.lift(Thread.subscriptions)({read, toParentMessage, when: ({route}) => route._tag === "Thread"})` and `Subscription.aggregate`.

File paste as a Mount (verified in Chromium: a `ClipboardEvent` with a `File` was default-prevented and reported as `PastedFiles`; a text paste was untouched):

```ts
export const ListenForPaste = Mount.defineStream("ListenForPaste", {
  messages: [Message.PastedFiles],
  execute: ({ element }) => streamFromEventFilterMapPreventDefault({
    target: element, type: "paste",
    filterMapEvent: (event: ClipboardEvent) => {
      const files = Array.fromIterable(event.clipboardData?.files ?? []);
      return Array.isArrayNonEmpty(files) ? Option.some(Message.PastedFiles({ files })) : Option.none();
    },
  }),
});
// textarea attributes: h.OnMount(ListenForPaste())
```

A Tiptap or other editor is hosted the same way: a Mount `execute` creates the editor on `element` and returns a `Stream` of change Messages; a Command finds the instance by id for imperative calls (`client.md` owns the editor decision).

JSON Schema export for the GPUI client:

```ts
export const rpcJsonSchemas = () => [...CairnRpcs.requests.values()].map((rpc) => {
  const success = RpcSchema.isStreamSchema(rpc.successSchema) ? rpc.successSchema.success : rpc.successSchema;
  return { tag: rpc._tag, payload: Schema.toJsonSchemaDocument(rpc.payloadSchema), success: Schema.toJsonSchemaDocument(success) };
});
```

Without the `isStreamSchema` branch a stream RPC's success schema exports as `{}`. Errors and the middleware error need the same treatment when the GPUI client lands.

### Testing shapes

Handler and stream tests with no socket, a real database and the real service:

```ts
const TestLayer = HandlersLive.pipe(Layer.provideMerge(Shell.layerNoDeps), Layer.provideMerge(DatabaseTest));
layer(TestLayer)("shell stream over RPC", (it) => {
  it.effect("snapshot, then events", () => Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(CairnRpcs);
    ...
  }));
});
```

Real server on an ephemeral port, real `ws` client with an Origin header:

```ts
const ServerTest = HttpLive.pipe(
  Layer.provide(Shell.layerNoDeps), Layer.provide(DatabaseTest),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
  Layer.provide(Config));
layer(ServerTest, { excludeTestServices: true })("real server", (it) => { ... connect(origin) uses HttpServer.formatAddress ... });
```

Foldkit update and view: `story(update, given(model), message(m), Command.resolve(Def, resultMessage), model(fn))` (reconnect state machine, shell reducer) and `scene({update, view}, given(model), Mount.resolve(Def, rawChildMessage), type(role("textbox", {name}), "hello"), expect(...))`. A Mount inside a Submodel is resolved with the child's raw Message. The weak spot in the probe's RPC stream test is `Effect.yieldNow` to let a subscription register; replace it with a `Deferred` or `TestClock` hand-off before the test lands.

## Risks and open questions

1. **Per-connection RPC server or one shared server.** `RpcServer.layerHttp` builds one server for all sockets; `makeProtocolWithHttpEffectWebsocket` builds one per socket (t3code and v1 do this). Recommendation: per connection from the start, because Phase 1 needs per-socket scope (subscriptions end with the socket), the identity re-check timer (`server.md` Identity and Origin), and the viewer service. The probe's shared server passed every judge, so this is a design choice, not a defect.
2. **Do not call it Connected before the first snapshot.** `Layer.build(ProtocolLive)` returns before the WebSocket opens, so `AcquiredConnection` fires early; with the server down the page flashes Connected, then Backoff. Recommendation: `Connecting` until the client is acquired, `Syncing` until the first `Snapshot`, then `Live`; gate sends and the offline banner on `Live`. The reconnect timing numbers below were taken to the first Snapshot frame, not to the label.
3. **Backoff schedule.** `server.md` proposes a 250 ms base, factor 2, jitter, 5 s cap; the probe's 2 s cap gave 222 to 246 ms to first snapshot after a restarted server, 5 of 5. The Durability target says every client converges within 2 s of reconnecting, which this satisfies; make the worst wait explicit in the judge. Add `online` and `visibilitychange` triggers as `server.md` says (iOS suspends sockets silently).
4. **Ping timing.** Defaults are 5 s interval and timeout. `server.md` recommends 3 s and 8 s; if both are used, set `pingTimeout` explicitly because it defaults to the interval and a single late frame would drop a healthy socket. Recommendation: interval 3 s, timeout 8 s.
5. **Graceful shutdown.** Set `gracefulShutdownTimeout: "2 seconds"` and add `SuccessExitStatus=130` to the user unit. Browsers reconnect on their own, so the short window costs nothing; the default 20 s makes every restart feel hung.
6. **Dev server port.** Cairn's server is 3774; 3775 and 3776 belong to cairn-bridges. Vite's dev server needs a port. Options: Vite on 3774 and the API on a dev port when Cairn is not running in production (spike 2 did this); or ask for a fourth loopback port. Recommendation: ask the user for 3777 as the dev API port, with Vite on 3774 proxying `/ws` and `/api` (`server.proxy['/ws'] = {target, ws: true}`) and `CAIRN_ORIGIN` set to the Vite origin so the Origin guard needs no header injection. Not run end to end here; v1 verified the Model-preserving reload on 0.168.
7. **Barrels and Foldkit.** The `no-barrel-file` override is a deviation from the repo's lint stance. Recommendation: accept it, scoped to page folders only (see Facts).
8. **Unstable modules.** Every API above except `Config`, `Stream`, `PubSub` and `TestClock` is `@stability unstable` and can change in a minor release. Pin exactly, read changesets on each Effect bump, and keep each unstable module behind one Cairn service (S42), so a break touches one file. The probe found no 4.0.5 defect in these paths.
9. **Foldkit risk is unchanged.** Pre-1.0, one maintainer, #1655 open. The skeleton reduces the cost of a migration: pages are self-contained Submodels with their own tests. Re-run the S2 typing judge and the parity judge on every Foldkit bump.
10. **Duplicate vitest instances.** After changing the dependency graph, run `rm -rf node_modules && pnpm install` before trusting a failing `@effect/vitest` suite.
11. **Telemetry.** Axiom can wait: `TelemetryLive` is already a no-op. When wanted, set the OTEL variables from the Alchemy stack's output, one dataset per signal, and keep the token out of logs (S56). `RpcServer.make(..., {disableTracing: true})` for the firehose streams, as t3code does; service methods keep their `Effect.fn` spans.
12. **Sharing contracts with t3code ports.** t3code `fe27e8e3` already imports `effect/rpc/Rpc`, `effect/rpc/RpcGroup` and `effect/Schema` and pins Effect 4.0.5 (`pnpm-workspace.yaml` catalog), so its contract files port with import-path tidying, not a version migration. Contracts must not import Node or browser modules, or Foldkit drags them into the bundle.

## Judges

- **Walking-skeleton gate (kept code).** `pnpm check` over the three packages: format, lint (with the new allowlist and overrides), typecheck of each package, and vitest `projects`. Currently the probe is red against the repo's lint until the listed fixes are applied; the judge is that it goes green with no rule disabled except the page-barrel override.
- **Protocol shared by both clients.** A vitest case in `packages/protocol` that imports the package from a Node test and, in `apps/web`, a Scene/Story test that imports the same schemas; plus `vite build` succeeding with `packages/protocol` in the bundle (342 KB, 112 KB gzip for the probe). A guard test asserts `packages/protocol` imports nothing but `effect`.
- **RPC without sockets.** `RpcTest.makeClient` cases for every handler and for each stream's snapshot, event, resume and typed-error behavior; run in the default `it.effect` (TestClock).
- **RPC with sockets.** The real-server test above (`excludeTestServices`, ephemeral port): a client with Cairn's Origin streams, a foreign Origin is refused, a typed error crosses the wire, and the viewer middleware rejects a missing identity header.
- **Reconnect and convergence (kept judge in `judges/`).** Playwright drives the built page against the real server, `kill -9`s the server five times, restarts it, and records time from the server's "Listening" log line to the first `Snapshot` frame (use `page.on("websocket")` and `framereceived`). Pass: every round at most 2 s, the final thread list equals the database, and no page error. Probe result: 222 to 246 ms, five rounds. Add the half-dead socket case (drop packets, do not close) to exercise the ping timeout.
- **SPA and static.** `curl -H 'Accept: text/html'` on `/t/abc` returns the shell; `/api/nothing` and `/ws` without upgrade return 404 JSON or text, not HTML; `/assets/<hash>.js` carries the immutable cache header.
- **Shutdown.** Start the server, hold a WebSocket open, send SIGTERM, assert exit within the configured timeout and the client's close code 1001.
- **Paste.** The Chromium ClipboardEvent check (file default-prevented and delivered, text untouched) becomes a kept script beside `judges/typing.ts`; the Phase 1 paste-to-model target reuses it with a real upload.
- **Telemetry.** A test with a local OTLP collector asserts that, with the three OTEL variables set, spans and logs arrive and per-signal headers are decoded, and that with none set nothing is sent and the server still boots.
- **JSON Schema.** A golden file generated from `rpcJsonSchemas()` committed under `packages/protocol/schema/`, with a test that regenerates it and fails on drift, plus one assertion that a stream RPC's element schema is not `{}`.
