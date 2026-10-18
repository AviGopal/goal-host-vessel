// THE GAP ID IS A STRUCTURED FIELD: RECOVERED FROM TEXT ONCE, AT ADMISSION, AND GRADED ONLY FROM THE FIELD.
//
// Gap gap-goals-carry-their-gap-id-only-in-prose-…: the reach gate decided "which gap does this investigation answer"
// from the goal TEXT (isGapInvestigationGoal + the anchored gapIdOfGoalText parse), so a reworded goal lost its gap
// even when its dispatch sent variables.decompose_gap_id. The qa ruling: the exact-id fallback runs in ONE place,
// admission (runGoalWithRecoveryInner, where the walk's variables are first known), as a by-id gap-store lookup of the
// goal's own tokens; a hit is written into the field and observed. Every downstream step reads only the field, and the
// gap-investigation oracle is selected by the field's presence alone: a goal that only reads as an investigation takes
// the normal grading path, never re-parsed, and is observed (counted log) as gap_id_field_missing.
//
// Drives the REAL gate (index.ts verifyGoalReached) inside the dispatch context, with every fetch stubbed.
//   [MUST-FAIL] a reworded investigation whose dispatch carries the field is graded against that gap.
//   [MUST-FAIL] a goal naming an existing gap id with no field gets the field written at admission, and is observed.
//   [MUST-FAIL] an investigation-looking goal with no field is observed as gap_id_field_missing (counted log) and takes
//               the normal path - even when its text names a gap in the anchored form the old parse read - never graded
//               against a text-parsed or route-edit-<hash> id, and never abstained for it.
//   [CONTROL]   a non-existent id-shaped token writes nothing; a non-gap goal is untouched (no lookups, no gap grade);
//               an unreadable store stops the scan; the gate's region calls no text parse.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realFetch = globalThis.fetch;
const prevRoot = process.env["WORKSPACE_ROOT"];
const root = mkdtempSync(join(tmpdir(), "gap-id-admission-"));
const X = "gap-lane-picks-a-fixed-gap";
const STEP = `${X}-step-1`;
const PIPE = "novel-failure-auto-bridge-source_code|execution_error-abc";
const STORE: Record<string, { id: string; classification_metadata?: Record<string, unknown> }> = {
  [X]: { id: X },
  [STEP]: { id: STEP, classification_metadata: { parent_gap_id: X } },
  [PIPE]: { id: PIPE },
};
type Verdict = { reached?: boolean; reason?: string; deterministic?: boolean; abstain?: { kind?: string; family?: string } } | null;
type Gate = (goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string, commandEvidence?: string, walkEvidence?: unknown, judgeView?: unknown, deliverables?: string[], poolEvidence?: unknown, writeEvidence?: unknown, captureSurface?: string) => Promise<Verdict>;
type Ctx = { run: <T>(store: { dispatchId: string; decomposeGapId?: string }, fn: () => T) => T };
let verifyGoalReached: Gate;
let dispatchContext: Ctx | undefined;
let G: Record<string, any> = {};

beforeAll(async () => {
  mkdirSync(join(root, "policies"), { recursive: true });
  process.env["WORKSPACE_ROOT"] = root;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (String(url).includes("/v2/impulses/resolve") && body.includes('"substrateGap"')) {
      const id = (JSON.parse(body) as { impulse?: { pointer?: { id?: string } } }).impulse?.pointer?.id ?? "";
      return new Response(JSON.stringify({ success: true, body: { gaps: STORE[id] ? [STORE[id]] : [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "stub: not served" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  const mod = (await import("../src/index")) as Record<string, unknown>;
  verifyGoalReached = mod["verifyGoalReached"] as Gate;
  dispatchContext = mod["dispatchContext"] as Ctx | undefined;
  G = (await import("../src/compose-gap-id")) as Record<string, any>;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevRoot === undefined) delete process.env["WORKSPACE_ROOT"]; else process.env["WORKSPACE_ROOT"] = prevRoot;
  rmSync(root, { recursive: true, force: true });
});

const pool = [{ id: "imp-1", shape: "gapDecomposition", content: { body: { ok: true, gap_id: X, children: [STEP], created: [STEP], reason: "wrote steps" } } }];
const inDispatch = <T>(store: { dispatchId: string; decomposeGapId?: string }, fn: () => T): T => (dispatchContext ? dispatchContext.run(store, fn) : fn());
const grade = (goal: string, store: { dispatchId: string; decomposeGapId?: string }) =>
  inDispatch(store, () => verifyGoalReached(goal, ["gapDecomposition"], "walk(1 steps): decomposeGap", "- gapDecomposition: {...}", undefined, undefined, undefined, undefined, pool, { persistedWrites: [], targets: ["gapDecomposition"] }, "walk"));
const counting = () => {
  const calls: string[] = [];
  return { calls, readGap: async (id: string) => { calls.push(id); return STORE[id] ?? null; } };
};

describe("a gap investigation is graded only from the structured field", () => {
  test("[MUST-FAIL] a reworded investigation with variables.decompose_gap_id is graded against that gap", async () => {
    const v = await grade(`Look into ${X} and break it down into steps`, { dispatchId: "d-reworded", decomposeGapId: X });
    expect(v?.reason ?? "").toContain("gap-investigation-product");
    expect(v?.reason ?? "").toContain(X);
    expect(v?.reached).toBe(true);
  });

  test("[MUST-FAIL] an investigation-looking goal with no field is observed, not abstained, and never text-parsed", async () => {
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); realWarn(...a); };
    let noId: Verdict, anchored: Verdict;
    try {
      noId = await grade("please investigate this gap soon, it keeps reopening", { dispatchId: "d-no-id" });
      // the anchored form the old parse read is NOT re-parsed downstream: without the field it is not graded against X
      anchored = await grade(`investigate and decompose gap ${X}: the lane re-picks a gap whose fix already landed`, { dispatchId: "d-anchored" });
    } finally { console.warn = realWarn; }
    const obs = warned.filter((l) => l.includes("gap_id_field_missing #"));
    expect(obs.length).toBe(2);
    expect(Number(/#(\d+)/.exec(obs[1]!)?.[1])).toBe(Number(/#(\d+)/.exec(obs[0]!)?.[1]) + 1);
    for (const v of [noId!, anchored!]) {
      expect(v?.reason ?? "").not.toContain("gap_id_field_missing");
      expect(v?.reason ?? "").not.toContain("gap-investigation");
      expect(v?.reason ?? "").not.toContain("route-edit-");
      // the normal path: no abstain at all (no gap-investigation abstain, and no citation abstain by a text predicate)
      expect(v?.abstain).toBeUndefined();
    }
  });

  test("[CONTROL] a non-gap goal is not graded as a gap investigation", async () => {
    const v = await grade("Summarise the README of repos/goal-host-vessel in three bullet points", { dispatchId: "d-plain" });
    expect(v?.reason ?? "").not.toContain("gap_id_field_missing");
    expect(v?.reason ?? "").not.toContain("gap-investigation");
  });

  test("[CONTROL] the gate's gap branch makes no text-parse call", () => {
    const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
    const start = SRC.indexOf("const _gapGrade = gapIdForGrading(goal, dispatchContext.getStore()?.decomposeGapId);");
    const end = SRC.indexOf("const _wg = judge.reachGate(judgeInputs.reachInput({ goal, writeEvidence,");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(SRC.slice(start, end)).not.toMatch(/gapIdOfGoalText|composeGapIdOf|isGapInvestigationGoal|oracleAbstainVerdict/);
    // the oracle is selected by the field's presence
    expect(SRC.slice(start, end)).toContain("if (_gapGrade.gapId) {");
  });
});

describe("the gap id is recovered from text once, at admission, by exact lookup", () => {
  test("[MUST-FAIL] a goal naming an existing gap id, with no field, gets the field written and observed", async () => {
    expect(typeof G["recoverGapIdAtAdmission"]).toBe("function");
    for (const goal of [`investigate and decompose gap ${X}: the lane re-picks`, `Please investigate the gap "${X}", it keeps reopening.`, `investigate and decompose gap ${PIPE}: the bridge failed`]) {
      const vars: Record<string, unknown> = { dispatch_id: "d-1" };
      const seen: string[] = [];
      const want = goal.includes(PIPE) ? PIPE : X;
      const got = await G["recoverGapIdAtAdmission"](goal, vars, { readGap: counting().readGap, observe: (id: string) => seen.push(id) });
      expect(got).toBe(want);
      expect(vars["decompose_gap_id"]).toBe(want);
      expect(seen).toEqual([want]);
    }
  });

  test("[MUST-FAIL] wiring: admission runs where the dispatch context is entered, the record carries the observation", () => {
    const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
    const enter = SRC.indexOf("dispatchContext.enterWith({ dispatchId: opts.variables.dispatch_id });");
    const admit = SRC.indexOf("await recoverGapIdAtAdmission(goal, opts.variables, {");
    expect(enter).toBeGreaterThan(0);
    expect(admit).toBeGreaterThan(enter);
    expect(admit - enter).toBeLessThan(1200);
    expect(SRC).toContain("_store.decomposeGapId = _field;");
    expect(SRC).toContain("onGapIdRecovered: (gid) => { record.gapIdRecoveredFromText = gid; },");
    expect(SRC).toContain("gapIdRecoveredFromText: record.gapIdRecoveredFromText ?? null,");
    expect(SRC).toContain("gap_id_recovered_from_text #${_gapIdRecoveredFromText}");
  });

  test("[MUST-FAIL] wiring: the floor carries the field through its empty-store re-entry, from both callers", () => {
    const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
    expect(SRC).toContain("return await dispatchContext.run({ ...dispatchContext.getStore(), dispatchId, ...(_floorGapId ? { decomposeGapId: _floorGapId } : {}) }, () => universalToolFallback(goal, targetShapes, dispatchId, out, walkContext));");
    expect(SRC).toContain("|| (dispatchId && _floorGapId && !dispatchContext.getStore()?.decomposeGapId)) {");
    const carried = 'decomposeGapId: typeof opts.variables["decompose_gap_id"] === "string" ? opts.variables["decompose_gap_id"] : undefined });';
    expect(SRC.split(carried).length - 1).toBe(2);
  });

  test("[CONTROL] an id-shaped token the store does not hold writes nothing", async () => {
    const vars: Record<string, unknown> = {};
    const seen: string[] = [];
    const got = await G["recoverGapIdAtAdmission"]("investigate and decompose gap gap-that-is-not-in-the-store: lane", vars, { readGap: counting().readGap, observe: (id: string) => seen.push(id) });
    expect(got).toBeNull();
    expect("decompose_gap_id" in vars).toBe(false);
    expect(seen).toEqual([]);
  });

  test("[CONTROL] a non-gap goal, or a dispatch that sent the field, makes no lookup and is unchanged", async () => {
    const c = counting();
    const plain: Record<string, unknown> = { source: "x" };
    expect(await G["recoverGapIdAtAdmission"](`Summarise ${X} in the README`, plain, { readGap: c.readGap, observe: () => {} })).toBeNull();
    expect(plain).toEqual({ source: "x" });
    const sent: Record<string, unknown> = { decompose_gap_id: "gap-sent" };
    expect(await G["recoverGapIdAtAdmission"](`investigate and decompose gap ${X}: x`, sent, { readGap: c.readGap, observe: () => {} })).toBeNull();
    expect(sent["decompose_gap_id"]).toBe("gap-sent");
    expect(c.calls).toEqual([]);
  });

  test("[CONTROL] an unreadable gap store stops the scan at the first read and writes nothing", async () => {
    let reads = 0;
    let unreadable = 0;
    const vars: Record<string, unknown> = {};
    const got = await G["recoverGapIdAtAdmission"](`investigate and decompose gap ${X}: x`, vars, { readGap: async () => { reads++; throw new Error("down"); }, observe: () => {}, unreadable: () => { unreadable++; } });
    expect(got).toBeNull();
    expect(reads).toBe(1);
    expect(unreadable).toBe(1);
    expect("decompose_gap_id" in vars).toBe(false);
  });
});
