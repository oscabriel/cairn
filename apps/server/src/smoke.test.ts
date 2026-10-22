// Dependency smoke test: every library name a later package relies on, checked against the
// installed packages rather than a clone or a spike's node_modules. A pi or Effect bump that
// renames or moves one of these fails here first, with the name in the test title.
import { applyImmutable } from "@earendil-works/chord/delta";
import {
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemMessage,
  isContextOverflow,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  DefaultPackageManager,
  formatSkillsForPrompt,
  getAgentDir,
  loadProjectContextFiles,
  loadSkills,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, Harness } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { adaptOAuthProvider } from "@earendil-works/pi-mcp/oauth";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import { assert, describe, it } from "@effect/vitest";

const names = {
  // D10: the seven names Cairn imports from pi-coding-agent's root (its only other export is ./rpc-entry).
  ModelRuntime,
  SettingsManager,
  DefaultPackageManager,
  loadSkills,
  formatSkillsForPrompt,
  loadProjectContextFiles,
  getAgentDir,
  // 1B: the SQLite client and the migrator, whose loader `fromRecord` is re-exported from effect/sql/Migrator.
  "SqliteClient.layer": SqliteClient.layer,
  "SqliteMigrator.layer": SqliteMigrator.layer,
  "SqliteMigrator.fromRecord": SqliteMigrator.fromRecord,
  // D19: the code mode sandbox is exported from pi-codemode's root (there is no runtime/host subpath),
  // and the durable code mode extension from pi-durable's codemode subpath.
  CodemodeSandbox,
  createCodemodeExtension,
  // 1C: the harness, extensions, the arms, the image worker, the store's schema version (the
  // BrainStore sidecar compares it) and the conformance shape the seam suite follows.
  Harness,
  defineExtension,
  NodeExecutionEnv,
  createNodePhotonImages,
  CURRENT_SQLITE_SCHEMA_VERSION,
  registerEnvConformance,
  // 1C and 1F: faux models for the scripted side and the bridge's tests, and pi-ai's own error
  // classification the bridge's error texts must satisfy.
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  isRetryableAssistantError,
  isContextOverflow,
  // 1F: the provider factory, the instruction digests and the Anthropic catalog. `getBuiltinModels`
  // lives in `providers/all`, whose OAuth-bearing names stay refused by lint.
  createProvider,
  getCurrentSystemMessage,
  getBuiltinModels,
  // 2A: the models collection and the runtime's native provider registration.
  createModels,
  "ModelRuntime#registerNativeProvider": Object.hasOwn(
    ModelRuntime.prototype,
    "registerNativeProvider"
  )
    ? true
    : undefined,
  // 3D: Executor's MCP client and the shared OAuth refresh.
  McpClient,
  StreamableHttpTransport,
  adaptOAuthProvider,
  // Clients: the path-checking op applier.
  applyImmutable,
};

describe("installed dependencies", () => {
  it.each(Object.entries(names))("exports %s", ([, value]) => {
    assert.isDefined(value);
  });
});
