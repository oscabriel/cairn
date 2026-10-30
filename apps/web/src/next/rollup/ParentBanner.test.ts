// Scene tests for the parent banner (plan 6D): a child's approval shows on its parent's page with the
// child named and "Open approval" linking to it; two asking children are both named; the banner
// hides while the parent asks the user itself, on a child's own page, and when no child asks.

import {
  asking,
  NOW,
  rowId,
  shellRow,
} from "@cairn/client-logic/ShellRowTestKit";
import { ApprovalId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import * as Scene from "foldkit/scene";

import { AppRoute, threadRouter } from "../../Route.ts";
import { appOf, given } from "../ui/SceneFixture.ts";
import { parentBanner, parentBannerFor } from "./ParentBanner.ts";

const PARENT = 1;

const childOf = (
  n: number,
  title: string,
  overrides: Partial<ThreadShell> = {}
): ThreadShell =>
  shellRow(n, {
    title,
    lineage: Option.some({
      parentThreadId: rowId(PARENT),
      relationshipToParent: "subagent",
      rootThreadId: rowId(PARENT),
    }),
    ...asking(`apr_${String(n)}`),
    ...overrides,
  });

/** A child's tool call waiting for the user's approval. */
const approval = (n: number): Partial<ThreadShell> => ({
  pendingRuntimeRequest: Option.some({
    id: ApprovalId.make(`apr_${String(n)}`),
    kind: "tool-call",
    createdAt: NOW,
    origin: Option.none(),
  }),
});

const modelOf = (open: number, threads: ReadonlyArray<ThreadShell>) => ({
  route: AppRoute.Thread({ threadId: rowId(open) }),
  shell: Option.some({ snapshotSequence: 1, projects: [], threads }),
});

const sceneOf = (open: number, threads: ReadonlyArray<ThreadShell>) =>
  appOf((h) => [parentBanner(modelOf(open, threads), h)]);

describe("the parent banner", () => {
  it("names a child that needs approval and opens it", () => {
    const threads = [
      shellRow(PARENT, { title: "Plan the port" }),
      childOf(2, "Fetch the page", approval(2)),
    ];

    Scene.scene(
      sceneOf(PARENT, threads),
      given,
      Scene.expect(Scene.testId("parent-banner")).toHaveAttr(
        "data-request",
        "approval"
      ),
      Scene.expect(Scene.testId("parent-banner")).toContainText(
        "Subagent needs approval"
      ),
      Scene.expect(Scene.testId("parent-banner-child")).toHaveText(
        "Fetch the page"
      ),
      Scene.expect(Scene.testId("parent-banner-child")).toHaveAttr(
        "href",
        threadRouter({ threadId: rowId(2) })
      ),
      Scene.expect(Scene.testId("parent-banner-open")).toHaveText(
        "Open approval"
      ),
      Scene.expect(Scene.testId("parent-banner-open")).toHaveAttr(
        "href",
        threadRouter({ threadId: rowId(2) })
      ),
      // The banner draws links only: it sends nothing of its own.
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("names every asking child, and opens the first one's question", () => {
    const threads = [
      shellRow(PARENT, { title: "Plan the port" }),
      childOf(2, "Pick a folder"),
      childOf(3, "Fetch the page", approval(3)),
    ];

    const banner = parentBannerFor(modelOf(PARENT, threads));

    assert.deepStrictEqual(
      Option.map(banner, (found) => [
        found.title,
        found.children.map((child) => child.title),
        found.request,
      ]),
      Option.some([
        "2 subagents need you",
        ["Pick a folder", "Fetch the page"],
        "input",
      ])
    );

    Scene.scene(
      sceneOf(PARENT, threads),
      given,
      Scene.expect(Scene.testId("parent-banner")).toContainText(
        "Pick a folder, Fetch the page"
      ),
      Scene.expect(Scene.testId("parent-banner-open")).toHaveText(
        "Open question"
      )
    );
  });

  it("hides while the parent asks the user, on the child's page, and when nothing asks", () => {
    const child = childOf(2, "Pick a folder");

    const cases: ReadonlyArray<[number, ReadonlyArray<ThreadShell>]> = [
      [PARENT, [shellRow(PARENT, asking("esc-1")), child]],
      [2, [shellRow(PARENT), child]],
      [
        PARENT,
        [
          shellRow(PARENT),
          childOf(2, "Pick a folder", { pendingRuntimeRequest: Option.none() }),
        ],
      ],
      [PARENT, []],
    ];

    for (const [open, threads] of cases) {
      assert.isTrue(Option.isNone(parentBannerFor(modelOf(open, threads))));

      Scene.scene(
        sceneOf(open, threads),
        given,
        Scene.expect(Scene.testId("parent-banner")).not.toExist()
      );
    }

    assert.isTrue(
      Option.isNone(
        parentBannerFor({ route: AppRoute.Hero(), shell: Option.none() })
      )
    );
  });
});
