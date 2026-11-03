// Scene tests for the brief card's Go (plan wave 6, 6B; ADR 0043): the model a brief names is
// checked with `models.check` as it shows, Go waits for the answer and is blocked with a plain
// reason while the model is not ready; a brief that names no model, or a role recorded before roles
// were removed, runs on its parent's model and is neither checked nor held; Check again asks again
// and an earlier answer does nothing; the connection coming back (a brain restart) asks again; a check that could not be made
// holds nothing; Send back needs notes and answers `revise` with them; Run on 1 first is a launch's
// only and answers `accept_sample`; and the notes typed on a brief settled elsewhere are kept.

import { ApprovalId, ThreadId } from "@cairn/protocol/Ids";
import type { ModelCheck } from "@cairn/protocol/ModelSpecs";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import type { Schema } from "effect";
import * as Scene from "foldkit/scene";

import { resolvedCheck, unreadyCheck } from "./CardFixtures.ts";
import { Message } from "./Message.ts";
import { initial } from "./Model.ts";
import type { Model } from "./Model.ts";
import { CheckModels, inform, RespondToRequest, update } from "./Update.ts";
import { view } from "./View.ts";

type Json = Schema.Json;

const threadId = ThreadId.make("01890a5d-ac96-774b-bcce-b302099a0001");

const budget = {
  maxListMicros: null,
  maxTokens: 200_000,
  maxTurns: null,
  maxMinutes: null,
  planGuard: null,
  warnAt: 0.8,
};

const record = (fields: { readonly [key: string]: Json }): Json => ({
  id: "b-1",
  toolTaskId: 1,
  tool: "subagent_spawn",
  kind: "brief",
  summary: "Count the files",
  status: "pending",
  askedAt: 1000,
  expiresAt: 9000,
  answeredAt: null,
  run: null,
  executorRequestId: null,
  payload: null,
  answer: null,
  decidedBy: null,
  reason: null,
  route: "user",
  escalatedAt: null,
  supersedes: null,
  started: null,
  briefHash: null,
  mirrorOf: null,
  ...fields,
});

const briefPayload = (role: string | null) => ({
  type: "brief",
  title: "Count the files",
  task: "Count the TypeScript files under src.",
  why: "To size the port.",
  avoid: [],
  doneWhen: [
    { text: "The parent accepts the result.", judge: { kind: "user" } },
  ],
  workspace: "shared",
  base: null,
  writes: [],
  role,
  model: null,
  thinking: null,
  mode: "full-access",
  mayCommit: false,
  budget,
  resultSchema: null,
  wake: "answer",
  decisions: [],
});

const brief = (role: string | null, id = "b-1"): Json =>
  record({ id, payload: briefPayload(role) });

const launch = (count: number): Json =>
  record({
    id: "w-1",
    tool: "workflow_plan",
    summary: "Review the port",
    payload: {
      type: "workflow",
      workflowId: "wf-1",
      name: "Review the port",
      description: "Reads each module and reviews it.",
      phases: [],
      scriptHash: "hash-1",
      scriptRef: "entry:1",
      args: null,
      callSites: [
        {
          spec: "faux/scripted:medium",
          label: "review",
          phase: null,
          schemaName: null,
          readonly: true,
          arms: "host",
          maxCount: null,
        },
      ],
      nodes: { count, unbounded: false },
      estimate: null,
      envelope: {
        scriptHash: "hash-1",
        maxNodes: Math.max(count, 1),
        maxConcurrent: 2,
        roles: [{ spec: "faux/scripted:medium", readonly: true, arms: "host" }],
        modes: ["full-access"],
        writes: [],
        budget,
      },
    },
  });

const doc = (...records: ReadonlyArray<Json>): Json => ({
  items: Object.fromEntries(
    records.map((found, index) => [`r${index}`, found])
  ),
});

const faux = { provider: "faux", modelId: "scripted" };

/** A model a brief names. */
const LUNA = "opencode-go/gpt-6-luna:high";

/** A model the catalog does not list. */
const NOPE = "opencode-go/nope";

const resolved = (spec: string) => resolvedCheck(spec, faux, "medium");

const unready = (spec: string) => unreadyCheck(spec, "unknown_model");

const context = (approvals: Json, hasClient = true) => ({
  threadId: Option.some(threadId),
  approvals,
  hasClient,
});

const bId = ApprovalId.make("b-1");

const wId = ApprovalId.make("w-1");

/** A workflow node's own brief, naming `spec`. */
const nodeBrief = (spec: string): Json =>
  record({ id: "n-1", tool: "agent", payload: briefPayload(spec) });

/** The card showing `approvals`, its first model check answered with `checks`. */
const checked = (
  approvals: Json,
  approvalId: ApprovalId,
  checks: ReadonlyArray<ModelCheck>
): Model =>
  update(
    inform(initial, context(approvals)).model,
    Message.ReceivedModelChecks({ approvalId, generation: 1, checks })
  ).model;

/** Commands as their names and arguments, which compare by value (their effects do not). */
const asked = (
  commands:
    | ReadonlyArray<{ readonly name: string; readonly args?: unknown }>
    | undefined
) => (commands ?? []).map(({ name, args }) => ({ name, args }));

const config = { update, view };

const goButton = Scene.role("button", { name: "Go" });

describe("the brief card", () => {
  it("checks the brief's model as it shows, holds Go until it resolves, then goes once", () => {
    const shown = inform(initial, context(doc(brief(LUNA))));

    assert.deepStrictEqual(
      asked(shown.commands),
      asked([
        CheckModels({
          approvalId: bId,
          generation: 1,
          specs: [LUNA],
        }),
      ])
    );

    Scene.scene(
      config,
      Scene.given(shown.model),
      Scene.expect(goButton).toBeDisabled(),
      Scene.inside(
        Scene.testId("request-card"),
        Scene.expect(Scene.selector("dl")).toContainText(
          "Runs onChecking the models…"
        )
      )
    );

    Scene.scene(
      config,
      Scene.given(
        update(
          shown.model,
          Message.ReceivedModelChecks({
            approvalId: bId,
            generation: 1,
            checks: resolved(LUNA),
          })
        ).model
      ),
      Scene.expect(goButton).not.toBeDisabled(),
      Scene.inside(
        Scene.testId("request-card"),
        Scene.expect(Scene.selector("dl")).toContainText(
          "Runs onfaux/scripted at medium"
        )
      ),
      Scene.expect(Scene.testId("request-card-go-blocked")).not.toExist(),
      Scene.click(goButton),
      Scene.Command.expectExact(
        RespondToRequest({
          threadId,
          approvalId: bId,
          decision: "accept",
          reason: Option.none(),
          answers: Option.none(),
        })
      ),
      Scene.Command.resolve(
        RespondToRequest,
        Message.SucceededRespond({ approvalId: bId })
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("blocks Go on a model that is not ready with a plain reason and Check again", () => {
    const blocked = checked(doc(brief(NOPE)), bId, unready(NOPE));

    Scene.scene(
      config,
      Scene.given(blocked),
      Scene.expect(goButton).toBeDisabled(),
      Scene.expect(Scene.testId("request-card-go-blocked")).toContainText(
        "Go is blocked: opencode-go/nope is not ready, as it is not in the model catalog."
      ),
      Scene.expect(
        Scene.role("button", { name: "Send back" })
      ).not.toBeDisabled(),
      Scene.expect(
        Scene.role("button", { name: "Decline" })
      ).not.toBeDisabled(),
      Scene.click(Scene.role("button", { name: "Check again" })),
      Scene.Command.expectExact(
        CheckModels({
          approvalId: bId,
          generation: 2,
          specs: [NOPE],
        })
      ),
      // Still held while the second check is out.
      Scene.expect(goButton).toBeDisabled(),
      Scene.Command.resolve(
        CheckModels,
        Message.ReceivedModelChecks({
          approvalId: bId,
          generation: 2,
          checks: resolved(NOPE),
        })
      ),
      Scene.expect(goButton).not.toBeDisabled(),
      Scene.expect(Scene.testId("request-card-go-blocked")).not.toExist()
    );

    // Go is refused by the update too, not only drawn disabled.
    const clicked = update(
      blocked,
      Message.ClickedAccept({ approvalId: bId, decision: "accept" })
    );

    assert.lengthOf(clicked.commands ?? [], 0);
    assert.isTrue(Option.isNone(clicked.model.sending));
  });

  it("takes only the answer to the check still out", () => {
    const shown = inform(initial, context(doc(brief(NOPE)))).model;

    const again = update(
      shown,
      Message.ClickedCheckModels({ approvalId: bId })
    ).model;

    // The first check's answer arrives after the second was asked: it does nothing.
    const stale = update(
      again,
      Message.ReceivedModelChecks({
        approvalId: bId,
        generation: 1,
        checks: resolved(NOPE),
      })
    ).model;

    assert.strictEqual(stale.modelChecks[bId]?._tag, "Checking");

    const fresh = update(
      stale,
      Message.ReceivedModelChecks({
        approvalId: bId,
        generation: 2,
        checks: unready(NOPE),
      })
    ).model;

    assert.strictEqual(fresh.modelChecks[bId]?._tag, "Checked");
  });

  it("asks again when the connection comes back, and not before", () => {
    const approvals = doc(brief(LUNA));
    const first = checked(approvals, bId, resolved(LUNA));

    const dropped = inform(first, context(approvals, false));

    assert.lengthOf(dropped.commands ?? [], 0);

    const back = inform(dropped.model, context(approvals, true));

    assert.deepStrictEqual(
      asked(back.commands),
      asked([
        CheckModels({
          approvalId: bId,
          generation: 2,
          specs: [LUNA],
        }),
      ])
    );

    // Shown with no client: asked once there is one.
    const offline = inform(initial, context(approvals, false));

    assert.lengthOf(offline.commands ?? [], 0);
    assert.lengthOf(
      inform(offline.model, context(approvals, true)).commands ?? [],
      1
    );
  });

  it("holds nothing when the check could not be made, and never waits on a brief with no model", () => {
    const failed = update(
      inform(initial, context(doc(brief(LUNA)))).model,
      Message.FailedModelChecks({
        approvalId: bId,
        generation: 1,
        message: "Cairn is reconnecting.",
      })
    ).model;

    Scene.scene(
      config,
      Scene.given(failed),
      Scene.expect(goButton).not.toBeDisabled(),
      Scene.inside(
        Scene.testId("request-card"),
        Scene.expect(Scene.selector("dl")).toContainText(
          "Not checked: Cairn is reconnecting. Go checks it again."
        )
      )
    );

    // No model named, or a role a brief recorded before roles were removed: the parent's model.
    for (const role of [null, "@worker"]) {
      const parentModel = inform(initial, context(doc(brief(role))));

      assert.lengthOf(parentModel.commands ?? [], 0);

      Scene.scene(
        config,
        Scene.given(parentModel.model),
        Scene.expect(goButton).not.toBeDisabled(),
        Scene.inside(
          Scene.testId("request-card"),
          Scene.expect(Scene.selector("dl")).not.toContainText("Runs on"),
          Scene.expect(Scene.selector("dl")).toContainText(
            "WhoThe parent's model"
          )
        )
      );
    }
  });

  it("sends a launch back with notes for its model, which runs nothing", () => {
    const shown = checked(
      doc(launch(5)),
      wId,
      resolved("faux/scripted:medium")
    );

    // Send back opens the notes field on the launch, as on a subagent's brief.
    assert.isTrue(
      Option.contains(
        update(shown, Message.ClickedSendBack({ approvalId: wId })).model
          .sendingBack,
        wId
      )
    );

    Scene.scene(
      config,
      Scene.given(shown),
      Scene.click(Scene.role("button", { name: "Send back" })),
      Scene.expect(
        Scene.role("button", { name: "Run on 1 first" })
      ).not.toExist(),
      Scene.type(Scene.label("What should change?"), "two nodes, not five"),
      Scene.click(Scene.role("button", { name: "Send back" })),
      Scene.Command.expectExact(
        RespondToRequest({
          threadId,
          approvalId: wId,
          decision: "revise",
          reason: Option.some("two nodes, not five"),
          answers: Option.none(),
        })
      ),
      Scene.Command.resolve(
        RespondToRequest,
        Message.SucceededRespond({ approvalId: wId })
      )
    );
  });

  it("checks a node's own brief, and blocks Go on a model that is not ready", () => {
    const nId = ApprovalId.make("n-1");

    const shown = inform(initial, context(doc(nodeBrief(NOPE))));

    assert.deepStrictEqual(
      asked(shown.commands),
      asked([CheckModels({ approvalId: nId, generation: 1, specs: [NOPE] })])
    );

    Scene.scene(
      config,
      Scene.given(checked(doc(nodeBrief(NOPE)), nId, unready(NOPE))),
      Scene.expect(Scene.testId("request-card-go-blocked")).toExist(),
      Scene.expect(goButton).toBeDisabled()
    );
  });

  it("neither checks nor blocks a workflow node's own brief that names a role from before roles were removed", () => {
    const olderNodeBrief = record({
      id: "n-1",
      tool: "agent",
      payload: briefPayload("@judge"),
    });

    const nId = ApprovalId.make("n-1");

    const shown = inform(initial, context(doc(olderNodeBrief)));

    assert.lengthOf(shown.commands ?? [], 0);

    Scene.scene(
      config,
      Scene.given(shown.model),
      Scene.expect(goButton).not.toBeDisabled(),
      Scene.expect(Scene.testId("request-card-go-blocked")).not.toExist(),
      Scene.inside(
        Scene.testId("request-card"),
        Scene.expect(Scene.selector("dl")).not.toContainText("Runs on")
      ),
      Scene.click(goButton),
      Scene.Command.expectExact(
        RespondToRequest({
          threadId,
          approvalId: nId,
          decision: "accept",
          reason: Option.none(),
          answers: Option.none(),
        })
      ),
      Scene.Command.resolve(
        RespondToRequest,
        Message.SucceededRespond({ approvalId: nId })
      )
    );
  });

  it("sends a brief back with the notes typed, and not without them", () => {
    Scene.scene(
      config,
      Scene.given(checked(doc(brief(LUNA)), bId, resolved(LUNA))),
      Scene.click(Scene.role("button", { name: "Send back" })),
      Scene.expect(goButton).not.toExist(),
      Scene.expect(Scene.role("button", { name: "Send back" })).toBeDisabled(),
      Scene.type(Scene.label("What should change?"), "  only src/next  "),
      Scene.click(Scene.role("button", { name: "Send back" })),
      Scene.Command.expectExact(
        RespondToRequest({
          threadId,
          approvalId: bId,
          decision: "revise",
          reason: Option.some("only src/next"),
          answers: Option.none(),
        })
      ),
      Scene.Command.resolve(
        RespondToRequest,
        Message.SucceededRespond({ approvalId: bId })
      ),
      Scene.expect(Scene.testId("request-card")).not.toExist()
    );

    // Blank notes are refused by the update too, as the brain refuses them.
    const opened = update(
      checked(doc(brief(LUNA)), bId, resolved(LUNA)),
      Message.ClickedSendBack({ approvalId: bId })
    ).model;

    const blank = update(
      update(opened, Message.ChangedNotes({ approvalId: bId, value: "   " }))
        .model,
      Message.ClickedConfirmSendBack({ approvalId: bId })
    );

    assert.lengthOf(blank.commands ?? [], 0);
    assert.isTrue(Option.isSome(blank.model.failure));
  });

  it("offers Run on 1 first on a launch of more than one node, and Send back", () => {
    const launched = inform(initial, context(doc(launch(5))));

    assert.deepStrictEqual(
      asked(launched.commands),
      asked([
        CheckModels({
          approvalId: wId,
          generation: 1,
          specs: ["faux/scripted:medium"],
        }),
      ])
    );

    Scene.scene(
      config,
      Scene.given(
        update(
          launched.model,
          Message.ReceivedModelChecks({
            approvalId: wId,
            generation: 1,
            checks: resolved("faux/scripted:medium"),
          })
        ).model
      ),
      Scene.expect(Scene.role("button", { name: "Send back" })).toExist(),
      // The numbers first, an unknown cost never read as zero, then what each node runs as.
      Scene.inside(
        Scene.testId("request-card"),
        Scene.expect(Scene.selector("dl")).toContainText(
          "No estimate yet: cost unknown"
        ),
        Scene.expect(Scene.selector("dl")).not.toContainText("$0.00"),
        Scene.expect(Scene.testId("request-card-call-site")).toContainText(
          "faux/scripted at medium · reads only · depends on the data"
        )
      ),
      Scene.click(Scene.role("button", { name: "Run on 1 first" })),
      Scene.Command.expectExact(
        RespondToRequest({
          threadId,
          approvalId: wId,
          decision: "accept_sample",
          reason: Option.none(),
          answers: Option.none(),
        })
      ),
      // One answer in flight: Go waits for it.
      Scene.expect(goButton).toBeDisabled(),
      Scene.Command.resolve(
        RespondToRequest,
        Message.SucceededRespond({ approvalId: wId })
      )
    );

    // One node: Run on 1 first is Go, so it is not offered, and the update refuses it.
    const single = checked(
      doc(launch(1)),
      wId,
      resolved("faux/scripted:medium")
    );

    Scene.scene(
      config,
      Scene.given(single),
      Scene.expect(
        Scene.role("button", { name: "Run on 1 first" })
      ).not.toExist()
    );

    assert.lengthOf(
      update(
        single,
        Message.ClickedAccept({ approvalId: wId, decision: "accept_sample" })
      ).commands ?? [],
      0
    );

    // A subagent's brief takes no Run on 1 first either.
    assert.lengthOf(
      update(
        checked(doc(brief(LUNA)), bId, resolved(LUNA)),
        Message.ClickedAccept({ approvalId: bId, decision: "accept_sample" })
      ).commands ?? [],
      0
    );
  });

  it("keeps the notes typed on a brief settled elsewhere", () => {
    const approvals = doc(brief(LUNA));

    const typed = update(
      update(
        checked(approvals, bId, resolved(LUNA)),
        Message.ClickedSendBack({ approvalId: bId })
      ).model,
      Message.ChangedNotes({ approvalId: bId, value: "narrower please" })
    ).model;

    const settled = inform(
      typed,
      context(
        doc(
          record({
            payload: briefPayload(LUNA),
            status: "accepted",
            answeredAt: 2000,
            decidedBy: { kind: "user" },
            answer: {
              decision: "accept",
              answers: null,
              note: null,
              launch: null,
            },
          })
        )
      )
    ).model;

    assert.isTrue(Option.isNone(settled.sendingBack));
    assert.deepStrictEqual(
      Option.map(settled.closed, (closed) => closed.typed),
      Option.some("narrower please")
    );
  });
});
