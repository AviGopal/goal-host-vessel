/**
 * Loop-C Consumer Activity: Vessel Designer
 *
 * Reads vessel-authoring scenarios from /workspace/validation/failure-modes/vessel-scenarios/,
 * extracts capability_shape and demanding_template_count, generates a deterministic vessel
 * design via constrained LLM completion, and dispatches to scaffold-and-publish-vessel.
 *
 * Tags: boredom_target_template, lift.autonomous.loop, vessel.addition
 * Closes: DECISION→DISPATCH gap for capability horizon expansion (ΔS, ΔA, ΔR)
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";

export interface VesselScenario {
  capability_shape: string;
  demanding_template_count: number;
  description?: string;
  rationale?: string;
  [key: string]: unknown;
}

export interface VesselDesign {
  vessel_name: string;
  capability_shape: string;
  demanding_template_count: number;
  impulse_types: string[];
  description: string;
  rationale: string;
  tags: string[];
}

export interface LoopCInput {
  scenarios_dir?: string;
  llm_endpoint?: string;
  llm_model?: string;
  dry_run?: boolean;
}

export interface LoopCResult {
  processed: number;
  dispatched: number;
  skipped: number;
  designs: VesselDesign[];
  errors: string[];
}

const DEFAULT_SCENARIOS_DIR =
  "/workspace/validation/failure-modes/vessel-scenarios";
const DEFAULT_LLM_ENDPOINT =
  process.env["LLM_ENDPOINT"] ?? "http://llm-resolver-vessel/v2/impulses/resolve";
const DEFAULT_LLM_MODEL = process.env["LLM_MODEL"] ?? "auto";
const SCAFFOLD_ENDPOINT =
  process.env["SCAFFOLD_ENDPOINT"] ??
  "http://discovery-vessel/v2/impulses/resolve";

async function readScenarios(dir: string): Promise<VesselScenario[]> {
  const entries = await readdir(dir);
  const jsonFiles = entries.filter(
    (f) => f.endsWith(".json") || f.endsWith(".jsonl")
  );

  const scenarios: VesselScenario[] = [];

  for (const file of jsonFiles) {
    const filePath = join(dir, file);
    const raw = await readFile(filePath, "utf-8");

    if (file.endsWith(".jsonl")) {
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as unknown;
          if (isVesselScenario(parsed)) {
            scenarios.push(parsed);
          }
        } catch {
          // skip malformed lines
        }
      }
    } else {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (isVesselScenario(item)) {
              scenarios.push(item);
            }
          }
        } else if (isVesselScenario(parsed)) {
          scenarios.push(parsed);
        }
      } catch {
        // skip malformed files
      }
    }
  }

  return scenarios;
}

function isVesselScenario(v: unknown): v is VesselScenario {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["capability_shape"] === "string" &&
    typeof obj["demanding_template_count"] === "number"
  );
}

function buildDesignPrompt(scenario: VesselScenario): string {
  return [
    "You are a vessel architect. Given a capability scenario, produce a concrete vessel design.",
    "Respond ONLY with a JSON object matching this exact shape:",
    "{\n" +
      '  "vessel_name": "<kebab-case-vessel-name>",\n' +
      '  "capability_shape": "<the capability shape>",\n' +
      '  "demanding_template_count": <number>,\n' +
      '  "impulse_types": ["<type1>", "<type2>"],\n' +
      '  "description": "<one sentence description>",\n' +
      '  "rationale": "<why this vessel expands capability horizon>",\n' +
      '  "tags": ["boredom_target_template", "lift.autonomous.loop", "vessel.addition"]\n' +
      "}",
    "",
    "Scenario:",
    `capability_shape: ${scenario.capability_shape}`,
    `demanding_template_count: ${scenario.demanding_template_count}`,
    scenario.description ? `description: ${scenario.description}` : "",
    scenario.rationale ? `rationale: ${scenario.rationale}` : "",
    "",
    "Rules:",
    "- vessel_name must be unique, descriptive, and end in -vessel",
    "- impulse_types must be non-empty strings matching the capability_shape domain",
    "- tags must include boredom_target_template, lift.autonomous.loop, vessel.addition",
    "- This vessel must expand capability horizon (ΔS, ΔA, ΔR) not just recombine existing",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

async function generateVesselDesign(
  scenario: VesselScenario,
  llmEndpoint: string,
  llmModel: string
): Promise<VesselDesign> {
  const prompt = buildDesignPrompt(scenario);

  // Deterministic seed from capability_shape for reproducibility
  const seed = scenario.capability_shape
    .split("")
    .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);

  const llmRequest = {
    pointer: {
      type: "llm.completion",
      model: llmModel,
    },
    body: {
      messages: [
        {
          role: "system",
          content:
            "You are a vessel architect. Respond ONLY with valid JSON, no prose, no markdown fences.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.2,
      seed,
      response_format: { type: "json_object" },
    },
  };

  const response = await fetch(llmEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(llmRequest),
  });

  if (!response.ok) {
    throw new Error(
      `LLM request failed: ${response.status} ${response.statusText}`
    );
  }

  const result = (await response.json()) as unknown;

  // Extract content from LLM resolver response
  let rawContent: string;
  if (
    typeof result === "object" &&
    result !== null &&
    "body" in result &&
    typeof (result as Record<string, unknown>)["body"] === "object"
  ) {
    const body = (result as Record<string, unknown>)["body"] as Record<
      string,
      unknown
    >;
    // Handle OpenAI-style response nested in body
    if (
      "choices" in body &&
      Array.isArray(body["choices"]) &&
      body["choices"].length > 0
    ) {
      const firstChoice = body["choices"][0] as Record<string, unknown>;
      const message = firstChoice["message"] as Record<string, unknown>;
      rawContent = message["content"] as string;
    } else if ("content" in body && typeof body["content"] === "string") {
      rawContent = body["content"];
    } else {
      rawContent = JSON.stringify(body);
    }
  } else if (typeof result === "string") {
    rawContent = result;
  } else {
    rawContent = JSON.stringify(result);
  }

  // Strip markdown fences if present
  rawContent = rawContent
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const design = JSON.parse(rawContent) as unknown;
  if (!isVesselDesign(design)) {
    throw new Error(
      `LLM returned invalid vessel design shape: ${rawContent.slice(0, 200)}`
    );
  }

  // Ensure required tags are present regardless of LLM output
  const requiredTags = [
    "boredom_target_template",
    "lift.autonomous.loop",
    "vessel.addition",
  ];
  for (const tag of requiredTags) {
    if (!design.tags.includes(tag)) {
      design.tags.push(tag);
    }
  }

  return design;
}

function isVesselDesign(v: unknown): v is VesselDesign {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["vessel_name"] === "string" &&
    typeof obj["capability_shape"] === "string" &&
    typeof obj["demanding_template_count"] === "number" &&
    Array.isArray(obj["impulse_types"]) &&
    typeof obj["description"] === "string" &&
    typeof obj["rationale"] === "string" &&
    Array.isArray(obj["tags"])
  );
}

async function dispatchToScaffold(
  design: VesselDesign,
  scaffoldEndpoint: string
): Promise<void> {
  const impulse = {
    pointer: {
      type: "scaffold-and-publish-vessel",
    },
    body: {
      vessel_name: design.vessel_name,
      capability_shape: design.capability_shape,
      demanding_template_count: design.demanding_template_count,
      impulse_types: design.impulse_types,
      description: design.description,
      rationale: design.rationale,
      tags: design.tags,
      source: "loop-c-vessel-designer",
    },
  };

  const response = await fetch(scaffoldEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(impulse),
  });

  if (!response.ok) {
    throw new Error(
      `Scaffold dispatch failed: ${response.status} ${response.statusText}`
    );
  }
}

export async function runLoopCVesselDesigner(
  input: LoopCInput
): Promise<LoopCResult> {
  const scenariosDir = input.scenarios_dir ?? DEFAULT_SCENARIOS_DIR;
  const llmEndpoint = input.llm_endpoint ?? DEFAULT_LLM_ENDPOINT;
  const llmModel = input.llm_model ?? DEFAULT_LLM_MODEL;
  const dryRun = input.dry_run ?? false;

  const result: LoopCResult = {
    processed: 0,
    dispatched: 0,
    skipped: 0,
    designs: [],
    errors: [],
  };

  let scenarios: VesselScenario[];
  try {
    scenarios = await readScenarios(scenariosDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Failed to read scenarios from ${scenariosDir}: ${msg}`);
    return result;
  }

  for (const scenario of scenarios) {
    result.processed++;

    let design: VesselDesign;
    try {
      design = await generateVesselDesign(scenario, llmEndpoint, llmModel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(
        `Failed to generate design for ${scenario.capability_shape}: ${msg}`
      );
      result.skipped++;
      continue;
    }

    result.designs.push(design);

    if (!dryRun) {
      try {
        await dispatchToScaffold(design, SCAFFOLD_ENDPOINT);
        result.dispatched++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(
          `Failed to dispatch ${design.vessel_name}: ${msg}`
        );
        result.skipped++;
      }
    } else {
      result.dispatched++;
    }
  }

  return result;
}
