// FIX: the walk's emit-time capture enters the judge view as entries, inside its budget and cut record
// (gap slice-v-judge-digest-outside-cut-accounting-and-edges-not-persisted-as-resolvable-ids, part 1).
// On the parent the walk appended a 600-per-shape / 4,000-total string AFTER the view: a captured
// 4,470-char report reached the judge as 600 chars with no cut recorded, and the view's cut record
// described a digest the judge was not actually shown.
import { describe, expect, test } from "bun:test";
import { buildJudgeView, capturedPoolEntries, DELIVERABLE_CAP } from "./judge-view";

const REPORT = "Here's a report on what's happening today, October 2, 2026:\n" + "1. Headline (Al Jazeera). Commentary. ".repeat(110);

describe("captured step outputs are view entries, not an appended digest", () => {
  test("a captured deliverable is shown whole, first, with no cut (the 600-char clip is gone)", () => {
    const entries = capturedPoolEntries([{ shape: "llm_completion", content: { resolved: true, content: REPORT } }]);
    const v = buildJudgeView([{ shape: "llm_completion", content: { producedBy: "activity:x", executionId: "exec_1" } }, ...entries], new Set());
    expect(REPORT.length).toBeGreaterThan(4000);
    expect(v.digest.startsWith(`- llm_completion: ${REPORT}`)).toBe(true);
    expect(v.cuts).toEqual([]);
    expect(v.deliverableCut).toBe(false);
  });
  test("identical captured and pool content is folded once", () => {
    const c = { resolved: true, content: REPORT };
    const v = buildJudgeView([{ shape: "llm_completion", content: c }, ...capturedPoolEntries([{ shape: "llm_completion", content: c }])], new Set());
    expect(v.digest.split("- llm_completion:").length - 1).toBe(1);
  });
  test("a capture bound is a RECORDED cut: a clipped deliverable abstains, a clipped intermediate is named", () => {
    const big = "x".repeat(DELIVERABLE_CAP + 500);
    const d = buildJudgeView(capturedPoolEntries([{ shape: "llm_completion", content: big }]), new Set());
    expect(d.deliverableCut).toBe(true);
    expect(d.cuts).toEqual([{ shape: "llm_completion", shown: DELIVERABLE_CAP, produced: DELIVERABLE_CAP + 500 }]);
    const r = buildJudgeView(capturedPoolEntries([{ shape: "problem_detection", content: big }]), new Set());
    expect(r.deliverableCut).toBe(false);
    expect(r.cuts).toContainEqual({ shape: "problem_detection", shown: 1500, produced: DELIVERABLE_CAP + 500 });
  });
  test("null / undefined captured content is skipped", () => {
    expect(capturedPoolEntries([{ shape: "a", content: null }, { shape: "b" }])).toEqual([]);
  });
});

describe("source: nothing is joined onto the judge view after it is built", () => {
  const src = require("node:fs").readFileSync(`${import.meta.dir}/index.ts`, "utf8") as string;
  test("the end-of-walk digest IS the view", () => {
    expect(src).not.toMatch(/\[judgeView\.digest, capturedDigest\]/);
    expect(src).toContain("const contentDigest = judgeView.digest;");
  });
  test("the interim digest IS the view", () => {
    expect(src).not.toMatch(/\[interimCaptured, interimView\.digest\]/);
    expect(src).toContain("const interimDigest = interimView.digest;");
  });
  test("both walk sites feed the captured entries into buildJudgeView", () => {
    expect(src).toContain("...capturedEntries],");
    expect(src).toContain("[...interimCaptured, ...poolImpulses.map(");
    expect(src).toContain("reachContentEntries.set(execId, entries);");
  });
});

// FULL VIEW OR ABSTAIN: a nested step's output reaches the judge only through this capture, so the capture bound decides
// whether a deliverable over the view can be read in full. At the view's own width every such deliverable was
// "clipped at capture" and could only abstain.
describe("the capture holds a deliverable over the view whole, for the full read", () => {
  const src = require("node:fs").readFileSync(`${import.meta.dir}/index.ts`, "utf8") as string;
  test("[MUST-FAIL] the walk's capture is bounded at a memory ceiling of 8 view-widths, not at the view's own width", () => {
    expect(src).toContain("const REACH_CAPTURE_CAP = DELIVERABLE_CAP * 8;");
    expect(src).toContain("const entries = capturedPoolEntries(captured.map((imp) => ({ shape: imp.metadata?.shape, content: imp.content })), REACH_CAPTURE_CAP);");
  });
  test("captured under that bound, a deliverable over the view is whole in hand at the end-of-walk view", () => {
    const big = "y".repeat(DELIVERABLE_CAP + 5000);
    const v = buildJudgeView([{ shape: "llm_completion", content: { producedBy: "activity:x", executionId: "exec_1" } }, ...capturedPoolEntries([{ shape: "llm_completion", content: big }], DELIVERABLE_CAP * 8)], new Set(), new Set(), { full: true });
    expect(v.deliverableCut).toBe(true);
    expect(v.deliverablePreClipped).toBe(false);
    expect(v.full?.deliverable).toBe(`- llm_completion: ${big}`);
  });
});
