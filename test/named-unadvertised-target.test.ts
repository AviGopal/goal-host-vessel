// A NAMED TARGET NO VESSEL ADVERTISES (openspec contained-self-development 8.14's recurring-demand half; 2026-10-13). A goal that
// names its deliverable verbatim keeps that shape as its target even when no vessel advertises it, so the walk's existing no-pick
// path files the missing producer instead of serving a substitute. Same construction as _namedShape's verb-object regex
// (produce|return|emit|generate|build) + NAMED-SHAPE BINDING's guard (isNamedShapeToken). Goals here are invented, not live ones.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inferGoalTargetDecision, namedUnadvertisedTarget, isNamedShapeToken } from "../src/goal-target-inference";

const KNOWN = ["shellResult", "llm_completion", "code_quality", "substrateGap", "memoryNote_write", "memoryNote", "web_search"];
// a model that would answer with the universal executor (the substitute), counting calls
const substituteLLM = () => { let calls = 0; return { calls: () => calls, complete: async () => { calls++; return JSON.stringify({ target_shapes: ["shellResult"], confidence: 0.6, alternatives: [] }); } }; };
const decide = async (goal: string, known = KNOWN) => { const llm = substituteLLM(); const d = await inferGoalTargetDecision(goal, known, { complete: llm.complete, maxTargetShapes: 6 }); return { d, calls: llm.calls() }; };

describe("a verbatim-named deliverable no vessel advertises is kept as the missing target", () => {
  it("MUST-FAIL: 'produce <unadvertised shape> …' keeps that shape (not substituted), without asking the model", async () => {
    const { d, calls } = await decide("produce quarryLedgerDigest via the quarry ledger tick: grouped entries per depot over the last 7 days");
    expect(d.shapes).toEqual(["quarryLedgerDigest"]);
    expect(calls).toBe(0);
  });
  it("every deliverable verb of the construction keeps it (return / emit / generate / build)", () => {
    for (const v of ["return", "emits", "generate", "build"]) expect(namedUnadvertisedTarget(`${v} the slateIndexReport for every quarry`, KNOWN).shape).toBe("slateIndexReport");
  });
  it("MUST-FAIL: identifiers outside the deliverable position never become targets (goal_hash, edit_site, dispatch_id, file names, env-like tokens)", async () => {
    for (const g of [
      "summarise the ledger rows; each row carries goal_hash and edit_site",
      "list the open rows for dispatch_id abc and the file quarry_ledger.json",
      "report whether QUARRY_LEDGER_URL is set for the importer",
      "count the depots whose edit_site moved",
    ]) {
      expect(namedUnadvertisedTarget(g, KNOWN)).toEqual({ shape: null, ambiguous: [] });
      const { d } = await decide(g);
      expect(d.shapes.some((s) => /goal_hash|edit_site|dispatch_id|quarry_ledger|QUARRY_LEDGER_URL/.test(s))).toBe(false);
    }
  });
  it("CONTROL: an ADVERTISED deliverable leaves today's behaviour (this route keeps nothing; the existing routes decide)", async () => {
    expect(namedUnadvertisedTarget("produce code_quality findings for the importer", KNOWN)).toEqual({ shape: null, ambiguous: [] });
    expect(namedUnadvertisedTarget("produce code_quality and also produce quarryLedgerDigest", KNOWN)).toEqual({ shape: null, ambiguous: [] });
    // a second deliverable joined by "and" is judged too (an advertised one anywhere keeps today's behaviour)
    expect(namedUnadvertisedTarget("produce quarryLedgerDigest and also produce code_quality", KNOWN)).toEqual({ shape: null, ambiguous: [] });
    // the decision is whatever the existing routes give: this route's own decision (the token, 0.85) never appears
    const { d } = await decide("produce code_quality findings for the importer");
    expect(d.confidence === 0.85 && d.shapes.length === 1 && !KNOWN.includes(d.shapes[0]!)).toBe(false);
    expect(d.shapes.every((s) => KNOWN.includes(s))).toBe(true);
  });
  it("MUST-FAIL: two or more unadvertised deliverables are ambiguous: none kept, no guess", async () => {
    expect(namedUnadvertisedTarget("produce quarryLedgerDigest, then build slateIndexReport", KNOWN)).toEqual({ shape: null, ambiguous: ["quarryLedgerDigest", "slateIndexReport"] });
    expect(namedUnadvertisedTarget("produce quarryLedgerDigest and also generate slateIndexReport", KNOWN).ambiguous).toEqual(["quarryLedgerDigest", "slateIndexReport"]);
    const { d } = await decide("produce quarryLedgerDigest, then build slateIndexReport");
    expect(d.shapes).not.toContain("quarryLedgerDigest");
    expect(d.shapes).not.toContain("slateIndexReport");
  });
  it("a composition ask (compute then persist) is left to the model's COMPOSITION RULE, like every shortcut", async () => {
    const { d, calls } = await decide("produce quarryLedgerDigest and write it to a memory note");
    expect(calls).toBe(1);
    expect(d.shapes).not.toContain("quarryLedgerDigest");
  });
  it("a plain word in the deliverable position is prose, not a shape (the shared guard)", () => {
    expect(namedUnadvertisedTarget("produce summaries of every depot", KNOWN).shape).toBeNull();
    expect(namedUnadvertisedTarget("build clusters of the open rows", KNOWN).shape).toBeNull();
  });
});

describe("NAMED-SHAPE BINDING's guard is one shared rule", () => {
  it("isNamedShapeToken: >= 6 chars, not excluded, carries a hump/underscore/colon", () => {
    for (const t of ["substrateGap", "test_suite", "obsidian:write_note", "quarryLedgerDigest"]) expect(isNamedShapeToken(t)).toBe(true);
    for (const t of ["cluster", "summary", "goal", "shellResult", "fileContent", "dispatch_id", "abc_d"]) expect(isNamedShapeToken(t)).toBe(false);
  });
  it("structural: index.ts's NAMED-SHAPE BINDING uses the shared guard, and the old inline copy is gone", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    expect(src).toContain("if (!isNamedShapeToken(nb)) continue;");
    expect(src).not.toContain("const NAMED_BIND_EXCLUDE = new Set(");
  });
});

describe("a contained named shape is filed but never sent and never authored", () => {
  // goal-host cannot see vessel declarations; a declared-but-unadvertised (contained) shape is refused downstream by the existing
  // development-vessel guards: the producer dispatcher (declaredBy, never sent) and the capability author route (containedRefusal,
  // before any compose), pinned by development-vessel c95344a1's tests. Here: the filer does NOT special-case containment.
  it("structural: fileCapabilityGap carries no containment special case (the refusal lives in development-vessel)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    const start = src.indexOf("async function fileCapabilityGap(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(0);
    expect(/declaredBy|containedRefusal|isContained|contained_shape/.test(body)).toBe(false);
  });
});
