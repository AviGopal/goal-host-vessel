/**
 * Resolver module for the loop-c.vessel.designer impulse type.
 *
 * Wires the Loop-C consumer activity into goal-host-vessel's resolver dispatch
 * so it can be invoked via POST /v2/impulses/resolve with pointer.type = "loop-c.vessel.designer".
 */

import {
  runLoopCVesselDesigner,
  type LoopCInput,
  type LoopCResult,
} from "../activities/loopC-vessel-designer";

export const LOOP_C_SHAPE = "loop-c.vessel.designer";

export interface LoopCResolverBody extends LoopCInput {
  // inherits scenarios_dir, llm_endpoint, llm_model, dry_run
}

export interface LoopCResolverResult {
  shape: string;
  body: LoopCResult;
}

export async function resolveLoopCVesselDesigner(
  body: LoopCResolverBody
): Promise<LoopCResolverResult> {
  const result = await runLoopCVesselDesigner(body);
  return {
    shape: LOOP_C_SHAPE,
    body: result,
  };
}
