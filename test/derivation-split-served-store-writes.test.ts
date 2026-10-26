// THE DERIVATION SPLIT DEFERS ANY SERVED STORE WRITE WITHOUT THE LLM (law 1).
//
// inferDerivationSplit partitions a multi-shape target into derive -> emit stages. Its deterministic half was a
// constant of three write terminals (memoryNote_write, concept_write, substrateGap_write); every other store write a
// vessel serves needed the non-deterministic LLM split, and with no LLM answer it was not deferred at all. The emit
// set is now read at use time: write-door.ts isStoreWrite (the judge/shapes.ts mutation class minus change primitives
// and the walk's pool write), intersected with the shapes discovery says a vessel serves.
//
//   [MUST-FAIL] a served store write of a non-surface vessel (llmModelPolicy_write, llm-resolver-vessel's model
//               policy store) is deferred behind its read with no LLM call.
//   [MUST-FAIL] the goal-host split call site passes the served set.
//   [MUST-FAIL] a served vault write (obsidian:write_note) on a store goal is deferred the same way.
//   [CONTROL]   five read-only questions infer no write target, even when the chooser proposes store writes.
//   [CONTROL]   "which gaps closed in 24 h?" infers no substrateGap_write.
//   [CONTROL]   memoryNote_write / concept_write / substrateGap_write still split deterministically.
//   [CONTROL]   a read question that names a store noun beside a SERVED write (a surface panel) infers no write
//               terminal through the real decision path, though the chooser proposes the write. The landing-page wording
//               is a READ-control fixture qa requires, not a PREREG-UIVIEW goal; no view shape is used or special-cased.
//   [CONTROL]   an unserved store write, a change primitive, the pool write and activityVariant_write are never
//               deferred deterministically; with no served set nothing is.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { inferDerivationSplit, inferGoalTargetDecision } from "../src/goal-target-inference";
import { isMutationShape } from "../src/judge/shapes";
import { isStoreWrite, isWriteShape } from "../src/write-door";
import { isReadQuestionGoal } from "../src/read-goal";

const KNOWN = [
  "webSearchResult", "substrateGap", "substrateGap_write", "memoryNote_write", "concept_write",
  "llmModelPolicy", "llmModelPolicy_write", "docFixPolicy_write",
];
const SERVED: ReadonlySet<string> = new Set(KNOWN);
const chooser = (shapes: string[]) => ({ complete: async () => `Here:\n${JSON.stringify({ target_shapes: shapes })}\n` });
const noLlm = () => {
  const calls: string[] = [];
  return { calls, complete: async (p: string) => { calls.push(p); return null; } };
};

const MF_SHAPE = "llmModelPolicy_write";
const MF_GOAL = "Look up which language model currently answers routine summarisation requests, then save a policy that sends those requests to the cheaper model instead.";

describe("a served store write is deferred without the LLM split", () => {
  it("[MUST-FAIL] llmModelPolicy_write is classified a store write and deferred behind its read", async () => {
    expect(isMutationShape(MF_SHAPE)).toBe(true);
    expect(isWriteShape(MF_SHAPE)).toBe(false);
    expect(isStoreWrite(MF_SHAPE)).toBe(true);
    const llm = noLlm();
    const split = await inferDerivationSplit(MF_GOAL, ["llmModelPolicy", MF_SHAPE], { servedShapes: SERVED, complete: llm.complete });
    expect(split).toEqual({ intermediate: ["llmModelPolicy"], terminal: [MF_SHAPE] });
    expect(llm.calls.length).toBe(0);
  });

  it("[MUST-FAIL] the split call site passes the shapes discovery serves", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const at = src.indexOf("const split = await inferDerivationSplit(goal, seededOutputShapes, {");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toContain("servedShapes: new Set([...shapeEndpointMap.keys(), ...discoveredProxyShapes]),");
  });
});

describe("read-only goals infer no write terminal", () => {
  const READS = [
    "What advice from old public-health pamphlets on handling anger during hardship is still reusable today?",
    "How does the honeybee waggle dance tell other bees where a feast of nectar is, and how does that compare with how scuba divers signal underwater?",
    "When does holding unexpired petroleum futures become more lucrative than a broad index fund, and when does the index fund outrank it?",
    "Is filler enough to fix a small crevice in a wall, or does a crack that keeps enlarging need more than that?",
    "Does surrounding a microphone with cardboard of different widths change how clearly prolonged, carefully enunciated speech is picked up?",
  ];
  for (const [i, goal] of READS.entries()) {
    it(`[CONTROL] read goal ${i + 1}: a proposed store write is dropped and nothing is deferred as a write`, async () => {
      const d = await inferGoalTargetDecision(goal, KNOWN, chooser(["webSearchResult", "memoryNote_write", MF_SHAPE]));
      expect(d.shapes).toContain("webSearchResult");
      expect([...d.shapes, ...d.alternatives.flat()].filter(isMutationShape)).toEqual([]);
      const llm = noLlm();
      const split = await inferDerivationSplit(goal, d.shapes, { servedShapes: SERVED, complete: llm.complete });
      expect(split.terminal.filter(isMutationShape)).toEqual([]);
      expect(split.intermediate.filter(isMutationShape)).toEqual([]);
    });
  }

  it("[CONTROL] probe 'which gaps closed in 24 h?' infers no substrateGap_write", async () => {
    const goal = "which gaps closed in 24 h?";
    const d = await inferGoalTargetDecision(goal, KNOWN, chooser(["substrateGap", "substrateGap_write"]));
    expect([...d.shapes, ...d.alternatives.flat()]).not.toContain("substrateGap_write");
    const split = await inferDerivationSplit(goal, d.shapes, { servedShapes: SERVED, complete: noLlm().complete });
    expect(split.terminal).not.toContain("substrateGap_write");
  });
});

describe("a read question naming a store noun beside a served write infers no write terminal", () => {
  const VAULT_WRITE = "obsidian:write_note";
  const PANEL_WRITE = "uiPanel_write";
  const NEAR = ["memoryNote", VAULT_WRITE, "obsidian:ui_screenshot", PANEL_WRITE];
  const served: ReadonlySet<string> = new Set([...KNOWN, ...NEAR]);
  const tempting = (shapes: string[]) => {
    const proposed: string[][] = [];
    return { proposed, complete: async () => { proposed.push(shapes); return JSON.stringify({ target_shapes: shapes }); } };
  };
  const CASES: Array<[string, string[], string]> = [
    ["What does the landing page currently show?", ["obsidian:ui_screenshot", PANEL_WRITE], PANEL_WRITE],
  ];
  for (const [goal, proposal, write] of CASES) {
    it(`[CONTROL] "${goal}": the proposed ${write} is dropped by the read rule and nothing is deferred as a write`, async () => {
      expect(isStoreWrite(write)).toBe(true);
      expect(isReadQuestionGoal(goal)).toBe(true);
      const stub = tempting(proposal);
      const d = await inferGoalTargetDecision(goal, [...KNOWN, ...NEAR], { complete: stub.complete });
      expect(stub.proposed.flat()).toContain(write);
      expect([...d.shapes, ...d.alternatives.flat()].filter(isMutationShape)).toEqual([]);
      const split = await inferDerivationSplit(goal, d.shapes, { servedShapes: served, complete: noLlm().complete });
      expect([...split.intermediate, ...split.terminal].filter(isMutationShape)).toEqual([]);
    });
  }

  const STORE_GOAL = "Save a summary of yesterday's meeting as an Obsidian note.";
  it("[CONTROL] the same tempting proposal on a store goal keeps the vault write (the stub tempts; the read rule decides)", async () => {
    const d = await inferGoalTargetDecision(STORE_GOAL, [...KNOWN, ...NEAR], tempting(["memoryNote", VAULT_WRITE]));
    expect(d.shapes).toContain(VAULT_WRITE);
  });

  it("[MUST-FAIL] on that store goal the served vault write is deferred without the LLM split (the widening)", async () => {
    const llm = noLlm();
    const split = await inferDerivationSplit(STORE_GOAL, ["memoryNote", VAULT_WRITE], { servedShapes: served, complete: llm.complete });
    expect(split).toEqual({ intermediate: ["memoryNote"], terminal: [VAULT_WRITE] });
    expect(llm.calls.length).toBe(0);
  });
});

describe("the three prior write terminals and the class's edges", () => {
  for (const sink of ["memoryNote_write", "concept_write", "substrateGap_write"]) {
    it(`[CONTROL] ${sink} still splits deterministically`, async () => {
      const llm = noLlm();
      const split = await inferDerivationSplit("Search for the latest release notes and record what changed", ["webSearchResult", sink], { servedShapes: SERVED, complete: llm.complete });
      expect(split).toEqual({ intermediate: ["webSearchResult"], terminal: [sink] });
      expect(llm.calls.length).toBe(0);
    });
  }

  it("[CONTROL] an unserved store write goes to the LLM split", async () => {
    const llm = noLlm();
    const split = await inferDerivationSplit(MF_GOAL, ["llmModelPolicy", MF_SHAPE], { servedShapes: new Set(["llmModelPolicy"]), complete: llm.complete });
    expect(llm.calls.length).toBe(1);
    expect(split.intermediate).toEqual([]);
  });

  it("[CONTROL] with no served set, nothing is deferred without the LLM split", async () => {
    const llm = noLlm();
    const split = await inferDerivationSplit(MF_GOAL, ["llmModelPolicy", MF_SHAPE], { complete: llm.complete });
    expect(llm.calls.length).toBe(1);
    expect(split.intermediate).toEqual([]);
  });

  it("[CONTROL] a change primitive and the walk's pool write are never deterministic emits", async () => {
    for (const sh of ["code_modification_proposal_write", "poolImpulse_write"]) {
      expect(isStoreWrite(sh)).toBe(false);
      const llm = noLlm();
      const split = await inferDerivationSplit(MF_GOAL, ["llmModelPolicy", sh], { servedShapes: new Set(["llmModelPolicy", sh]), complete: llm.complete });
      expect(llm.calls.length).toBe(1);
      expect(split.intermediate).toEqual([]);
    }
  });

  it("[CONTROL] activityVariant_write stays single-stage", async () => {
    const llm = noLlm();
    const split = await inferDerivationSplit("Repair the failing template", ["problem_detection", "activityVariant_write"], { servedShapes: new Set(["problem_detection", "activityVariant_write"]), complete: llm.complete });
    expect(split).toEqual({ intermediate: [], terminal: ["problem_detection", "activityVariant_write"] });
    expect(llm.calls.length).toBe(0);
  });
});
