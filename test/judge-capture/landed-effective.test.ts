// LANDED, AS THE GATE SEES IT: the reach-gate capture records the gate's EFFECTIVE landed value
// (evidence.landed_effective = landedEdit || writeEvidence.landed, exactly what writeGoalArtifactGate is handed), not only
// the caller's flag (evidence.landed, kept as is). A replay built from `landed` alone would grade a landed edit as
// unlanded. This drives the REAL gate (index.ts verifyGoalReached) under a bound dispatch, with every fetch stubbed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCaptureTarget, type CaptureTarget } from "../../src/judge/capture";

const realFetch = globalThis.fetch;
const prevRoot = process.env["WORKSPACE_ROOT"];
const root = mkdtempSync(join(tmpdir(), "landed-effective-"));
type Gate = (goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string, commandEvidence?: string, walkEvidence?: unknown, judgeView?: unknown, deliverables?: string[], poolEvidence?: unknown, writeEvidence?: { persistedWrites: string[]; targets?: string[]; landed?: boolean; postReachSink?: boolean }, captureSurface?: string) => Promise<unknown>;
let verifyGoalReached: Gate;

beforeAll(async () => {
  mkdirSync(join(root, "policies"), { recursive: true });
  process.env["WORKSPACE_ROOT"] = root;
  // index.ts builds its LLM port at import; every request below is answered by the stub, never sent.
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "stub: not served" }), { status: 404, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
  const mod = (await import("../../src/index")) as Record<string, unknown>;
  verifyGoalReached = mod["verifyGoalReached"] as Gate;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevRoot === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = prevRoot;
  rmSync(root, { recursive: true, force: true });
});

const GOAL = "Change the retry cap in repos/example-vessel/src/backoff.ts to five attempts";
const LANDED_DIGEST = '- fileEditResult: {"path":"repos/example-vessel/src/backoff.ts","push_status":"pushed","new_git_sha":"abcdef1234567"}';
const UNLANDED_DIGEST = '- fileEditResult: {"path":"repos/example-vessel/src/backoff.ts","status":"staged"}';

async function evidenceOf(shapes: string[], digest: string, landed: boolean): Promise<Record<string, unknown>> {
  const target: CaptureTarget = {};
  await withCaptureTarget(target, () => verifyGoalReached(GOAL, shapes, "walk(1 steps): a", digest, undefined, undefined, undefined, undefined, undefined, { persistedWrites: [], targets: ["fileEditResult"], landed }, "walk"));
  const rec = target.metadata?.judge_input?.reachGate;
  expect(rec).toBeDefined();
  return rec!.input["evidence"] as Record<string, unknown>;
}

describe("reachGate capture: evidence.landed_effective is the gate's own landed value", () => {
  test("MUST-FAIL: an edit-result shape with landing evidence and writeEvidence.landed false records landed_effective:true", async () => {
    const ev = await evidenceOf(["goal", "fileEditResult"], LANDED_DIGEST, false);
    expect(ev["landed"]).toBe(false);
    expect(ev["landed_effective"]).toBe(true);
  });

  test("CONTROL: an edit-result shape with no landing evidence and landed false records landed_effective:false", async () => {
    const ev = await evidenceOf(["goal", "fileEditResult"], UNLANDED_DIGEST, false);
    expect(ev["landed_effective"]).toBe(false);
  });

  test("CONTROL: the caller's landed flag alone still counts", async () => {
    const ev = await evidenceOf(["goal", "memoryNote_write"], "- memoryNote_write: {\"id\":\"n\"}", true);
    expect(ev["landed"]).toBe(true);
    expect(ev["landed_effective"]).toBe(true);
  });
});
