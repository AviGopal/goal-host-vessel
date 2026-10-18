// OBSERVE IS SIDE-EFFECT-FREE — WIRING (source pins on index.ts; it boots a server on import, so the side-effect
// functions cannot be called here). Measured on one observe probe: the early edit-intent route handed the goal to
// feature_compose with land:true, and the dispatch REMEMBERED its failure, tombstoned a reached command and mirrored
// a reach-gate lesson to concept-db. Every such side effect asks observeSkip() (observe-mode.ts) first, and the
// dispatch's learning mode is in the dispatch context wherever one is decided.
import { describe, expect, test } from "bun:test";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
/** The body of a function from its signature to the next top-level function. */
const fnBody = (sig: string, span = 2500): string => {
  const i = src.indexOf(sig);
  expect(i).toBeGreaterThan(0);
  return src.slice(i, i + span);
};
const firstLines = (sig: string, n: number): string => fnBody(sig).split("\n").slice(0, n).join("\n");

describe("the learning mode is in the dispatch context", () => {
  test("the context carries it and the walk egress guard reads it", () => {
    expect(src).toContain("const dispatchContext = new AsyncLocalStorage<{ dispatchId: string; decomposeGapId?: string; learningMode?: \"observe\" | \"learn\"; /** the dispatch's own goal, for the content check */ goal?: string }>();");
    expect(src).toContain("setWalkEgressLearningModeReader(() => dispatchContext.getStore());");
  });
  test("every place the context is entered carries the mode", () => {
    expect(src).toContain("dispatchContext.enterWith({ ...dispatchContext.getStore(), dispatchId: opts.variables.dispatch_id, ...(opts.learningMode ? { learningMode: opts.learningMode } : {}), ...(goal ? { goal } : {}) });");
    expect(src).toContain("dispatchContext.enterWith({ ...dispatchContext.getStore(), dispatchId: _costDid, ...(learningMode ? { learningMode } : {}) });");
    expect(src).toContain("dispatchContext.enterWith({ ...dispatchContext.getStore(), dispatchId, ...(learningMode ? { learningMode } : {}) });");
    expect(src).toContain("dispatchContext.run({ ...dispatchContext.getStore(), dispatchId, ...(_floorGapId ? { decomposeGapId: _floorGapId } : {}), ...(_floorMode ? { learningMode: _floorMode } : {}), goal }, () => universalToolFallback(");
    expect(src).toContain("const _floorMode = walkContext?.learningMode;");
    // (each entry spreads the existing store, so the whole line is the entry: L2a's decomposeGapId rides the same entries)
    const entries = src.match(/dispatchContext\.(enterWith|run)\(\{[^\n]*/g) ?? [];
    expect(entries.length).toBe(4);
    expect(entries.every((m) => m.includes("learningMode") && m.includes("...dispatchContext.getStore()"))).toBe(true);
    expect(src.match(/priorFeedback: priorFailureFeedbackFor\(goal\), (skipFailedReplays: \[\.\.\._failedReplays\], )?decomposeGapId: typeof opts\.variables\["decompose_gap_id"\] === "string" \? opts\.variables\["decompose_gap_id"\] : undefined, learningMode: opts\.learningMode \}/g)?.length).toBe(2);
  });
  test("the /run-goal background run enters it before any side effect of the dispatch", () => {
    const i = src.indexOf("dispatchContext.enterWith({ ...dispatchContext.getStore(), dispatchId, ...(learningMode ? { learningMode } : {}) });");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(src.indexOf("const seek = await runGoalWithRecovery(goal, {", i));
    expect(i).toBeLessThan(src.indexOf("rememberDispatchFailures(record.goal, walkStepSink, record.goalReachReason, record.selectedTemplateId", i));
  });
});

describe("each side effect asks observeSkip first", () => {
  test("failure memory: rememberGoalFailure (so rememberDispatchFailures) and markGoalReached", () => {
    expect(firstLines("function rememberGoalFailure(", 2)).toContain('if (observeSkip("failure_memory")) return;');
    expect(firstLines("function markGoalReached(", 3)).toContain('if (observeSkip("failure_memory")) return;');
    expect(fnBody("export function rememberDispatchFailures(", 400)).toContain("rememberGoalFailure(goalText, r, pick, shapes, attempts)");
  });
  test("reached-command cache: the bank, the donation and the evict/tombstone all skip", () => {
    expect(firstLines("function persistReachedCommand(", 2)).toContain('if (observeSkip("reached_command_bank")) return;');
    expect(firstLines("function evictReachedCommand(", 2)).toContain('if (observeSkip("reached_command_evict")) return;');
    expect(src).toContain('if (!reachedCommandCache.has(donorHash) && !observeSkip("reached_command_bank")) {');
    // the walk's own bank site was already gated on the walk's opts
    expect(src).toContain('if (opts.learningMode !== "observe" && producedShapes.has(sh) && typeof cmd === "string" && cmd.trim()) {');
  });
  test("reach-gate lesson: penaliseHollowTemplate returns before the β POST and the concept-db mirror", () => {
    const body = fnBody("async function penaliseHollowTemplate(", 6000);
    const guard = body.indexOf('if (observeSkip("beta_penalty")) { observeSkip("reach_gate_lesson"); return { templateId: activityId, dAlpha: 0, dBeta: 0 }; }');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(body.indexOf("/v2/activities/feedback"));
    expect(guard).toBeLessThan(body.indexOf('type: "concept_create_write"'));
  });
  test("oracle label and verifier recipes", () => {
    expect(firstLines("function recordDeterministicLabel(", 3)).toContain('if (observeSkip("oracle_label")) return;');
    expect(src.match(/!observeSkip\("verifier_recipe"\)/g)?.length).toBe(2);
  });
  test("gap writes from the walk and the dispatch are refused", () => {
    for (const sig of ["async function fileCapabilityGap(", "async function fileReachabilityGap("]) expect(firstLines(sig, 2)).toContain('if (observeSkip("gap_write")) return null;');
    expect(firstLines("async function fileMissingVerifierGap(", 2)).toContain('if (observeSkip("gap_write")) return;');
    expect(src).toContain('if (_reachVerdict && !observeSkip("gap_write")) {');
    expect(src).toContain('if (observeSkip("gap_write")) return; // OBSERVE (observe-mode.ts): the case is kept, no gap is seeded');
    expect(src).toContain('if (earlyOwners.length > 1 && !_dupOwnerFiled.has(earlyTargetVessel) && !observeSkip("gap_write")) {');
    expect(src).toContain('if (isOperator && isUnservable && typeof goal === "string" && !observeSkip("gap_write")) {');
    expect(fnBody("async function emitAuthoringDecision(", 400)).toContain('if (observeSkip("authoring_decision")) return;');
    expect(firstLines("async function closeAuthoringDecisions(", 2)).toContain('if (observeSkip("authoring_decision")) return;');
    expect(src).toContain('if (operator && walkStepSink.length > 0 && !observeSkip("vault_note")) {');
  });
  test("a child dispatch is not spawned as learn; a requeue keeps the mode", () => {
    expect(fnBody("function escalateNoProducerToInvestigation(", 400)).toContain('if (observeSkip("child_dispatch")) return;');
    expect(src).toContain("...(learningMode ? { learningMode } : {}) };");
    expect(src).toContain("dispatchId: r.dispatchId, ...(r.learningMode ? { learning_mode: r.learningMode } : {}) })");
  });
  test("the walk's target and terminal sets drop a gap-write target", () => {
    expect(src).toContain("observeDropFrom(terminalShapes, opts.learningMode, dispatchContext.getStore()?.dispatchId, tap);");
    expect(src).toContain("observeDropFrom(target, opts.learningMode, dispatchContext.getStore()?.dispatchId, tap);");
  });
});

describe("the feature_compose hand-off under observe", () => {
  test("both edit-intent pointers carry the dispatch's learning mode beside land:true", () => {
    const m = src.match(/type: "feature_compose",[\s\S]{0,2600}?land: true,\n[^\n]*\n?\s*\.\.\.observeComposeFields\(opts\.learningMode\),/g);
    expect(m?.length).toBe(2);
  });
  test("an observe dispatch ends at the compose's answer: no grade, walk, landing probe or patch_with_tools escalation", () => {
    const early = src.indexOf('const earlyVerdict = String(earlyBody.verdict ?? "");');
    const earlyObs = src.indexOf('if (opts.learningMode === "observe") {', early);
    expect(earlyObs).toBeGreaterThan(early);
    expect(earlyObs).toBeLessThan(src.indexOf('if (earlyVerdict === "FAVORABLE") {', early));
    const probe = src.indexOf("// A LANDING ENDS THE DISPATCH (value-per-cost-selection 3.1).");
    expect(src.lastIndexOf('if (opts.learningMode === "observe") {', probe)).toBeGreaterThan(src.lastIndexOf("} catch (earlyErr) {", probe));
    const post = src.indexOf('let verdict = String(body.verdict ?? "");');
    const postObs = src.indexOf('if (opts.learningMode === "observe") {', post);
    expect(postObs).toBeGreaterThan(post);
    expect(postObs).toBeLessThan(src.indexOf('if (verdict === "BUSY") {', post));
    expect(postObs).toBeLessThan(src.indexOf('type: "patch_with_tools"', post));
  });
  test("the skip counters are published on /health", () => {
    expect(src).toContain("observe_skips: observeSkipCounters(),");
  });
});
