// A thread's reach through Executor: the Executor app's tools refused and hidden, and GitHub calls
// held to the project's own repo. Ported from cairn-v1, apps/server/test/executor-scope.test.ts at
// 1a5cd4a. Changed: no per-project app list or account pin (the scope is the repo alone).
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import type { JsonObject } from "./ExecutorReply.ts";
import {
  appOfPath,
  callRefusal,
  canonicalPath,
  discoveryRefusal,
  executeRefusal,
  filterDescribe,
  filterSearch,
  gitHubRefusal,
} from "./ExecutorScope.ts";
import type { ExecutorScopeValue } from "./ExecutorScope.ts";

const SCOPE: ExecutorScopeValue = { repo: Option.some("oscabriel/cairn") };

const NO_REPO: ExecutorScopeValue = { repo: Option.none() };

const refusal = (why: Option.Option<string>) => Option.getOrElse(why, () => "");

const paths = (value: JsonObject, key: string) =>
  JSON.stringify(value[key] ?? null);

describe("paths", () => {
  it("reads the app of a dotted path and a tool expression, as Executor does", () => {
    assert.strictEqual(
      canonicalPath("tools.github.issues.list"),
      "github.issues.list"
    );
    assert.strictEqual(
      canonicalPath('tools["my-app"].issues'),
      "my-app.issues"
    );
    assert.strictEqual(canonicalPath("github.issues"), "github.issues");
    assert.strictEqual(appOfPath('tools["github"].repos.get'), "github");
    assert.strictEqual(appOfPath("tools.linear"), "linear");
  });
});

describe("the Executor app", () => {
  it("is refused and left out of results, while its skills stay readable", () => {
    assert.match(
      refusal(callRefusal(SCOPE, "tools.executor.apps.install", {})),
      /manage Executor itself/u
    );
    assert.match(
      refusal(callRefusal(SCOPE, 'tools["executor"].accounts.list', {})),
      /manage Executor itself/u
    );
    assert.match(
      refusal(discoveryRefusal("search", { namespace: "executor" })),
      /not for threads/u
    );
    assert.match(
      refusal(
        discoveryRefusal("describe", { paths: ["tools.executor.apps.list"] })
      ),
      /tools\.executor\.apps\.list/u
    );
    assert.isTrue(
      Option.isNone(
        discoveryRefusal("skills", { app: "executor", name: "code-mode" })
      )
    );

    const { value, hidden } = filterSearch({
      items: [
        { path: "tools.github.issues.list" },
        { path: "tools.executor.apps.install" },
      ],
      namespaces: [{ path: "tools.github" }, { path: "tools.executor" }],
    });

    assert.strictEqual(
      paths(value, "items"),
      JSON.stringify([{ path: "tools.github.issues.list" }])
    );
    assert.strictEqual(
      paths(value, "namespaces"),
      JSON.stringify([{ path: "tools.github" }])
    );
    assert.strictEqual(hidden, 1);

    const described = filterDescribe({
      items: [{ path: "tools.executor.apps.list" }],
      namespaces: [],
      missing: [
        {
          path: "tools.executor.apps",
          matches: ["tools.executor.apps.list", "tools.github.repos.get"],
        },
      ],
    });

    assert.strictEqual(paths(described.value, "items"), "[]");
    assert.strictEqual(
      paths(described.value, "missing"),
      JSON.stringify([
        {
          path: "tools.executor.apps",
          matches: ["tools.github.repos.get"],
        },
      ])
    );
  });

  it("refuses a program that names it", () => {
    assert.match(
      refusal(executeRefusal("await tools.executor.apps.install({})")),
      /manage Executor itself/u
    );
    assert.match(
      refusal(executeRefusal("await tools[ 'executor' ].accounts.list()")),
      /manage Executor itself/u
    );
    assert.isTrue(
      Option.isNone(
        executeRefusal(
          "await tools.github.issues.list({}); await tools.search({ query: 'executor' })"
        )
      )
    );
    assert.isTrue(Option.isNone(executeRefusal("await tools.executorish.x()")));
  });
});

describe("executor_call on GitHub", () => {
  it("lets a call on the project's own repo through, in either input shape and any case", () => {
    assert.isTrue(
      Option.isNone(
        callRefusal(SCOPE, "tools.github.repos.get", {
          path: { owner: "oscabriel", repo: "cairn" },
        })
      )
    );
    assert.isTrue(
      Option.isNone(
        callRefusal(SCOPE, "tools.github.issues.create", {
          accountId: "acct_1",
          input: {
            path: { owner: "OscAbriel", repo: "Cairn" },
            body: { title: "x" },
          },
        })
      )
    );
    assert.isTrue(
      Option.isNone(callRefusal(SCOPE, "tools.linear.issues.create", {}))
    );
  });

  it("refuses a call on another repo, or a second copy naming one", () => {
    assert.match(
      refusal(
        callRefusal(SCOPE, "tools.github.repos.get", {
          path: { owner: "oscabriel", repo: "other" },
        })
      ),
      /only on its own repo, oscabriel\/cairn/u
    );
    assert.match(
      refusal(
        callRefusal(SCOPE, "tools.github.repos.get", {
          path: { owner: "someone", repo: "cairn" },
        })
      ),
      /names owner someone/u
    );
    assert.match(
      refusal(
        gitHubRefusal(SCOPE, {
          path: { owner: "oscabriel", repo: "cairn" },
          input: { path: { owner: "oscabriel", repo: "secret" } },
        })
      ),
      /names repo secret/u
    );
    assert.match(
      refusal(
        gitHubRefusal(SCOPE, {
          input: {
            path: { owner: "oscabriel", repo: "cairn" },
            body: { owner: "evil" },
          },
        })
      ),
      /names owner evil/u
    );
    assert.match(
      refusal(
        gitHubRefusal(SCOPE, {
          path: { owner: "oscabriel", repo: "cairn" },
          query: { repo: 7 },
        })
      ),
      /repo is not a name/u
    );
  });

  it("refuses a call with no repo in its path, and every call for a project with no repo", () => {
    assert.match(
      refusal(gitHubRefusal(SCOPE, { query: { q: "repo:oscabriel/other" } })),
      /names no repo in its path/u
    );
    assert.match(
      refusal(gitHubRefusal(SCOPE, { path: { owner: "oscabriel" } })),
      /names no repo in its path/u
    );
    assert.match(
      refusal(
        callRefusal(NO_REPO, "tools.github.repos.get", {
          path: { owner: "oscabriel", repo: "cairn" },
        })
      ),
      /no GitHub repo/u
    );
  });
});
