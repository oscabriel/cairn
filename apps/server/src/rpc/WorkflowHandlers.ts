// `workflow.stop` and `workflow.stopNode` (ADR 0012 as amended, workflows note W6): thin handlers
// over `WorkflowStops`, which aborts the script call or the node's task and answers once the stop
// is marked. A stop of an ended workflow or node succeeds and changes nothing.

import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Layer } from "effect";

import { WorkflowStops } from "../workflows/WorkflowStop.ts";

/** The two stop RPCs. Needs `WorkflowStops`. */
export const WorkflowHandlers = Layer.mergeAll(
  CairnRpcs.toLayerHandler(
    "workflow.stop",
    WorkflowStops.useSync((stops) => (input) => stops.stop(input))
  ),
  CairnRpcs.toLayerHandler(
    "workflow.stopNode",
    WorkflowStops.useSync((stops) => (input) => stops.stopNode(input))
  )
);
