import type { GoalCompose } from "../types/goal-compose";

export const vesselAuthoringScenarioQueueConsumer: GoalCompose = {
  name: "vessel-authoring-scenario-queue-consumer",
  tags: [
    "boredom_target_template",
    "lift.autonomous.loop",
    "vessel.addition",
  ],
  outputShape: "vesselScaffoldDispatchResult",
  tasks: [
    {
      id: "list_scenarios",
      type: "fs_list",
      params: {
        path: "/workspace/validation/failure-modes/vessel-scenarios",
        glob: "*.json",
        shuffle: true,
      },
    },
    {
      id: "extract_scenario_path",
      type: "json_path_extract",
      params: {
        input: "{{list_scenarios.files[0]}}",
        path: "$",
      },
    },
    {
      id: "read_scenario",
      type: "fs_read",
      params: {
        path: "{{extract_scenario_path.value}}",
      },
    },
    {
      id: "llm_dispatch",
      type: "llm_completion_dispatch",
      params: {
        input: "{{read_scenario.content}}",
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
    },
    {
      id: "dispatch_scaffold",
      type: "http_fetch",
      params: {
        url: "http://127.0.0.1:8210/run-goal",
        method: "POST",
        body: {
          goal: "development-vessel:scaffold-and-publish-vessel",
          vessel_name: "{{llm_dispatch.vessel_name}}",
          port: "{{llm_dispatch.port}}",
          advertised_shapes_literal: "{{llm_dispatch.advertised_shapes_literal}}",
          description: "{{llm_dispatch.description}}",
          commit_message: "{{llm_dispatch.commit_message}}",
          pr_title: "{{llm_dispatch.pr_title}}",
          pr_body: "{{llm_dispatch.pr_body}}",
          cwd: "/workspace",
          owner: "metabob",
          repo: "metabob-devbob",
          base_branch: "dev",
          target_branch: "substrate-authored/{{llm_dispatch.vessel_name}}-scaffold",
        },
      },
    },
  ],
};
