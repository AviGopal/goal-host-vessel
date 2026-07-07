import { executeVesselAuthoringScenarioConsumer } from "../executors/vessel-authoring-scenario-executor";

export interface ResolverResult {
  shape: string;
  body: unknown;
}

export async function resolveVesselScaffoldDispatch(
  _impulseBody: Record<string, unknown>
): Promise<ResolverResult> {
  const result = await executeVesselAuthoringScenarioConsumer();
  return {
    shape: "vesselScaffoldDispatchResult",
    body: result,
  };
}
