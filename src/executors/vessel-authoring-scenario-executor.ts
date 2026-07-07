import { vesselAuthoringScenarioQueueConsumer } from "../consumers/vessel-authoring-scenario-queue-consumer";
import type { GoalTask } from "../types/goal-compose";
import { Config } from "../config";

export interface VesselScaffoldDispatchResult {
  consumer: string;
  tags: string[];
  outputShape: string;
  tasks: GoalTask[];
  resolvedAt: string;
}

export function buildVesselScaffoldDispatchResult(): VesselScaffoldDispatchResult {
  return {
    consumer: vesselAuthoringScenarioQueueConsumer.name,
    tags: vesselAuthoringScenarioQueueConsumer.tags,
    outputShape: vesselAuthoringScenarioQueueConsumer.outputShape,
    tasks: vesselAuthoringScenarioQueueConsumer.tasks,
    resolvedAt: new Date().toISOString(),
  };
}

export async function executeVesselAuthoringScenarioConsumer(
  overrideUrl?: string
): Promise<VesselScaffoldDispatchResult> {
  const executeTaskEndpoint = overrideUrl ?? `${Config.goalHostEndpoint}/execute-task`;
  // Step 1: fs_list
  const listTask = vesselAuthoringScenarioQueueConsumer.tasks[0];
  const listParams = listTask?.params as {
    path: string;
    glob: string;
    shuffle: boolean;
  };

  const listResponse = await fetch(executeTaskEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "fs_list",
      params: listParams,
    }),
  });
  const listResult = (await listResponse.json()) as { files: string[] };
  const firstFile = listResult.files[0] ?? "";

  // Step 2: json_path_extract
  const extractResponse = await fetch(executeTaskEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "json_path_extract",
      params: { input: firstFile, path: "$" },
    }),
  });
  const extractResult = (await extractResponse.json()) as { value: string };
  const scenarioPath = extractResult.value ?? firstFile;

  // Step 3: fs_read
  const readResponse = await fetch(executeTaskEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "fs_read",
      params: { path: scenarioPath },
    }),
  });
  const readResult = (await readResponse.json()) as { content: string };
  const scenarioContent = readResult.content ?? "{}";

  // Step 4: llm_completion_dispatch
  const llmResponse = await fetch(executeTaskEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "llm_completion_dispatch",
      params: {
        input: scenarioContent,
        requiredFields: [
          "vessel_name",
          "port",
          "advertised_shapes_literal",
          "description",
          "commit_message",
          "pr_title",
          "pr_body",
        ],
        systemPrompt:
          "You are a vessel authoring assistant. Given a scenario JSON, extract or derive the following fields: vessel_name, port, advertised_shapes_literal, description, commit_message, pr_title, pr_body. The pr_body MUST include a Substrate-Authored-By trailer line. Respond with a JSON object containing exactly these fields.",
      },
    }),
  });
  const llmResult = (await llmResponse.json()) as {
    vessel_name: string;
    port: string;
    advertised_shapes_literal: string;
    description: string;
    commit_message: string;
    pr_title: string;
    pr_body: string;
  };

  // Step 5: http_fetch POST to /run-goal
  const goalUrl = overrideUrl ?? `${Config.goalHostEndpoint}/run-goal`;
  await fetch(goalUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      goal: "development-vessel:scaffold-and-publish-vessel",
      vessel_name: llmResult.vessel_name,
      port: llmResult.port,
      advertised_shapes_literal: llmResult.advertised_shapes_literal,
      description: llmResult.description,
      commit_message: llmResult.commit_message,
      pr_title: llmResult.pr_title,
      pr_body: llmResult.pr_body,
      cwd: "/workspace",
      owner: "metabob",
      repo: "metabob-devbob",
      base_branch: "dev",
      target_branch: `substrate-authored/${llmResult.vessel_name}-scaffold`,
    }),
  });

  return buildVesselScaffoldDispatchResult();
}
