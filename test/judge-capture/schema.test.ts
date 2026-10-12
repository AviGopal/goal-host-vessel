// SCHEMA: every captured record carries its documented fields, at schema 1.
//
// The field lists below are written out HERE, not imported from src/judge/capture.ts: a builder that drops a field
// would otherwise agree with itself. A case built from a recorded input can only replay a decision if the record holds
// everything the decision read, so a missing field is a red, not a default.
//
// Fixtures are class-level (a write goal, a question goal, a pathless change goal); no recorded run is copied.
import { describe, expect, test } from "bun:test";
import {
  JUDGE_INPUT_SCHEMA, ROUTING_INPUT_SCHEMA,
  captureJudgeInput, creditOnHollowInput, floorShortcutInput, floorVerdictInput, noteCitationPort,
  noteGapHydration, noteLlmJudge, noteRoutingHandOff, observeWriteReadback, reachGateInput, reframeAcceptInput, routingRecorder,
  withCaptureTarget, attachRoutingInput,
  type CaptureTarget, type ReachGateCaptureArgs,
} from "../../src/judge/capture";
import { resolvePathlessCodeChangeGoal } from "../../src/goal-file-resolution";

const keys = (o: unknown): string[] => Object.keys(o as Record<string, unknown>).sort();

const REACH_ARGS: ReachGateCaptureArgs = {
  goal: "Record a note naming the three slowest stages of the build",
  originalTargets: ["memoryNote_write"],
  deliverables: ["memoryNote_write"],
  targetsSeenByWalk: ["memoryNote_write"],
  reframedFrom: null,
  persistedWrites: ["memoryNote_write"],
  landed: false,
  producedShapes: ["shellResult", "memoryNote_write"],
  postReachSink: true,
  toolsTotal: 2,
  groundedReads: 1,
  outputImpulses: 2,
  consumedInChain: 1,
  surface: "walk",
  digest: "- memoryNote_write: {\"id\":\"note-fixture\"}",
  taskSummary: "walk(2 steps): a → b",
  commandEvidence: "- shellResult was produced by RUNNING: `ls`",
  walkEvidence: { gapsFiled: 0, walkLog: ["step 1 ran a new_shapes=1", "unrelated line"] },
  judgeView: { deliverableCut: false, cuts: [] },
};

const REACH_GATE_FIELDS = ["deliverables", "digest_excerpt", "evidence", "gate_context", "goal", "original_targets", "reframed_from", "surface", "targets_seen_by_walk"];
const EVIDENCE_FIELDS = ["consumed_in_chain", "grounded_reads", "landed", "output_impulses", "persisted_writes", "post_reach_sink", "produced_shapes", "tools_total"];
const GATE_CONTEXT_FIELDS = ["command_evidence", "judge_view", "task_summary", "walk_gaps_filed", "walk_step_lines"];
const RECORD_FIELDS = ["calls", "entry", "input", "llm", "ports", "schema", "verdict"];
const ROUTING_FIELDS = ["compose_gap_id", "edit_site", "entry", "gap_hint", "goal", "is_edit_intent", "is_pathless_code_change", "resolution", "restated_goal", "routed_to", "schema", "trail"];
const RESOLUTION_FIELDS = ["candidates", "chosen_file", "method", "reads", "terms"];

describe("judge_input schema: each entry's input has its documented fields", () => {
  test("reachGate", () => {
    const r = reachGateInput(REACH_ARGS);
    expect(keys(r)).toEqual(REACH_GATE_FIELDS);
    expect(keys(r.evidence)).toEqual(EVIDENCE_FIELDS);
    expect(keys(r.gate_context)).toEqual(GATE_CONTEXT_FIELDS);
    expect((r.gate_context as Record<string, unknown>).walk_step_lines).toEqual(["step 1 ran a new_shapes=1"]);
    expect(r.surface).toBe("walk");
    expect(r.reframed_from).toBeNull();
  });

  test("floorVerdict = reachGate + the floor's own inputs", () => {
    const r = floorVerdictInput({ ...REACH_ARGS, surface: "floor", answerText: "The three slowest stages are a, b and c.", verdictReason: "the note was written", seededEvidence: false, toolsOk: 2, authoredAnswer: true });
    expect(keys(r)).toEqual([...REACH_GATE_FIELDS, "answer_text", "authored_answer", "seeded_evidence", "tools_ok", "verdict_reason"].sort());
    expect(keys(r.evidence)).toEqual(EVIDENCE_FIELDS);
  });

  test("floorShortcut", () => {
    const r = floorShortcutInput({ goal: "How many stages does the build have?", activities: ["universal-tool-fallback"], borrowed: false, targets: ["answer"] });
    expect(keys(r)).toEqual(["activities", "borrowed", "goal", "targets"]);
  });

  test("reframeAccept", () => {
    const r = reframeAcceptInput({
      goal: "Summarise the build stages", originalTargets: ["buildReport"], alternatives: [["buildReport"], ["fileContent"]], altTargets: ["fileContent"],
      altWalk: { reached: true, abstain: false, produced: ["fileContent"], substantiveShapes: ["fileContent"], onlyRawInput: true, skippedPlannedRetrieval: false },
      origWantedDerived: true, plannedRetrieval: [],
    });
    expect(keys(r)).toEqual(["alt_targets", "alt_walk", "alternatives", "goal", "orig_wanted_derived", "original_targets", "planned_retrieval"]);
    expect(keys(r.alt_walk)).toEqual(["abstain", "only_raw_input", "produced", "reached", "skipped_planned_retrieval", "substantive_shapes"]);
  });

  test("creditOnHollow", () => {
    const r = creditOnHollowInput({ templateId: "satisfier:memoryNote_write", verdict: { deterministic: false, reason: "deterministic:no-output — nothing" }, consumedInChain: 0, editEffectReach: null, lastPickProducedJudgedArtifact: true, noOracle: false });
    expect(keys(r)).toEqual(["consumed_in_chain", "edit_effect_reach", "history", "last_pick_produced_judged_artifact", "no_oracle", "template_id", "template_id_class", "verdict"]);
    expect(keys(r.verdict)).toEqual(["deterministic", "hollow_class"]);
    expect(r.template_id_class).toBe("satisfier");
    expect((r.verdict as Record<string, unknown>).hollow_class).toBe("deterministic:no-output");
  });
});

describe("judge_input record: schema, entry, the recorded LLM verdict and ports, on the bound dispatch", () => {
  test("a reach gate under a bound dispatch records llm.judge, citation re-reads and write read-backs", async () => {
    const target: CaptureTarget = {};
    await withCaptureTarget(target, async () => {
      await observeWriteReadback("memoryNote_write", Promise.resolve({ persisted: true as const, content: {} }));
      noteCitationPort({ path: "repos/example-vessel/src/stages.ts", line: 2, at: "/roots/repos/example-vessel/src/stages.ts", lines: ["// stages", "export const SLOWEST = 3;", ""], symbols: ["SLOWEST", "absentSymbol"] });
      noteCitationPort({ path: "repos/example-vessel/src/missing.ts", line: null, at: null, lines: null, symbols: ["SLOWEST"] });
      noteLlmJudge({ reached: true, reason: "the note was written" });
      captureJudgeInput("reachGate", () => reachGateInput(REACH_ARGS), { reached: true, reason: "the note was written", completion_shapes: ["memoryNote_write"] });
    });
    const rec = target.metadata!.judge_input!.reachGate!;
    expect(keys(rec)).toEqual(RECORD_FIELDS);
    expect(rec.schema).toBe(JUDGE_INPUT_SCHEMA);
    expect(rec.schema).toBe(1);
    expect(rec.entry).toBe("reachGate");
    expect(keys(rec.input)).toEqual(REACH_GATE_FIELDS);
    expect(keys(rec.llm)).toEqual(["consulted", "judge"]);
    expect(rec.llm).toEqual({ consulted: true, judge: { reached: true, reason: "the note was written", deterministic: false } });
    expect(keys(rec.ports)).toEqual(["citation", "write_readback"]);
    expect(rec.ports.write_readback).toEqual({ memoryNote_write: true });
    expect(rec.ports.citation).toEqual([
      { path: "repos/example-vessel/src/stages.ts", line: 2, read_at: "/roots/repos/example-vessel/src/stages.ts", contains: { SLOWEST: true, absentSymbol: false }, line_window_contains: { SLOWEST: true, absentSymbol: false } },
      { path: "repos/example-vessel/src/missing.ts", line: null, read_at: null, contains: null, line_window_contains: null },
    ]);
    expect(rec.verdict).toEqual({ reached: true, reason: "the note was written", completion_shapes: ["memoryNote_write"] });
    expect(rec.calls).toBe(1);
  });

  test("a gate that never consulted the judge records consulted:false (the previous gate's notes are not carried over); the floor verdict carries its gate's llm and ports; calls count", async () => {
    const target: CaptureTarget = {};
    await withCaptureTarget(target, async () => {
      noteLlmJudge({ reached: false, reason: "no answer" });
      noteCitationPort({ path: "repos/example-vessel/src/a.ts", line: null, at: null, lines: null, symbols: ["x"] });
      captureJudgeInput("reachGate", () => reachGateInput(REACH_ARGS), { reached: false });
      captureJudgeInput("reachGate", () => reachGateInput({ ...REACH_ARGS, surface: "floor" }), { reached: false, reason: "deterministic:no-output — nothing" });
      captureJudgeInput("floorVerdict", () => floorVerdictInput({ ...REACH_ARGS, surface: "floor", answerText: "", verdictReason: null, seededEvidence: true, toolsOk: 0, authoredAnswer: false }), { reached: false });
    });
    const gate = target.metadata!.judge_input!.reachGate!;
    expect(gate.calls).toBe(2);
    expect(gate.llm).toEqual({ consulted: false, judge: null });
    expect(gate.ports.citation).toEqual([]);
    const floor = target.metadata!.judge_input!.floorVerdict!;
    expect(keys(floor)).toEqual(RECORD_FIELDS);
    expect(floor.llm).toEqual(gate.llm);
    expect(floor.ports.citation).toEqual(gate.ports.citation);
  });

  test("every entry records schema + entry + input + llm + ports + verdict", async () => {
    const target: CaptureTarget = {};
    await withCaptureTarget(target, async () => {
      captureJudgeInput("floorShortcut", () => floorShortcutInput({ goal: "g", activities: [], borrowed: true, targets: [] }), { allowed: false, why: "fixture" });
      captureJudgeInput("reframeAccept", () => reframeAcceptInput({ goal: "g", originalTargets: [], alternatives: [], altTargets: [], altWalk: { reached: null, abstain: false, produced: [], substantiveShapes: [], onlyRawInput: false, skippedPlannedRetrieval: false }, origWantedDerived: false, plannedRetrieval: [] }), { accepted: false });
      captureJudgeInput("creditOnHollow", () => creditOnHollowInput({ templateId: "tpl-fixture", verdict: { deterministic: true, reason: "deterministic:x" }, consumedInChain: 1, editEffectReach: null, lastPickProducedJudgedArtifact: true, noOracle: false }), { beta: "charged" });
    });
    for (const e of ["floorShortcut", "reframeAccept", "creditOnHollow"] as const) {
      const rec = target.metadata!.judge_input![e]!;
      expect(keys(rec)).toEqual(RECORD_FIELDS);
      expect(rec.schema).toBe(1);
      expect(rec.entry).toBe(e);
    }
  });
});

describe("routing_input schema (entry editIntent)", () => {
  const PATHLESS = "Fix the retry budget so the backoff helper stops retrying after three attempts";
  const FILE = "repos/example-vessel/src/backoff.ts";

  test("a pathless change goal restated onto one file records terms, candidates, the chosen file, the method and the reads", async () => {
    const rr = routingRecorder();
    const taps: string[] = [];
    const out = await resolvePathlessCodeChangeGoal(
      PATHLESS,
      rr.search(async (t) => (t === "backoff helper" ? [FILE] : t === "retry budget" ? [FILE, "repos/example-vessel/src/other.ts"] : [])),
      rr.tap((m) => { taps.push(m); }),
      rr.symbolSearch(async () => []),
      rr.propose(async () => []),
      rr.read(async () => "export const backoffHelper = (n: number) => n; // the backoff helper\nconst x = 'backoff helper';\n"),
    );
    const rec = rr.finish(PATHLESS, out)!;
    expect(keys(rec)).toEqual(ROUTING_FIELDS);
    expect(keys(rec.resolution)).toEqual(RESOLUTION_FIELDS);
    expect(rec.schema).toBe(ROUTING_INPUT_SCHEMA);
    expect(rec.schema).toBe(1);
    expect(rec.entry).toBe("editIntent");
    expect(rec.is_pathless_code_change).toBe(true);
    expect(out).not.toBe(PATHLESS);
    expect(rec.restated_goal).toBe(out);
    expect(rec.resolution.chosen_file).toBe(FILE);
    expect(rec.resolution.method).toBe("unique-term-hit");
    expect(rec.resolution.terms.slice(0, 2)).toEqual(["retry budget", "backoff helper"]);
    expect(rec.resolution.candidates[0]).toEqual({ via: "term", term: "retry budget", scope: null, hits: [FILE, "repos/example-vessel/src/other.ts"], error: false });
    expect(rec.resolution.reads).toEqual([{ path: FILE, readable: true }]);
    expect(rec.routed_to).toBe("walk");
    expect(rec.compose_gap_id).toBeNull();
    expect(rec.trail).toEqual(taps);
  });

  test("a goal that is not a pathless change records method not-pathless and no restatement", async () => {
    const g = "What does the backoff helper do?";
    const rr = routingRecorder();
    const out = await resolvePathlessCodeChangeGoal(g, rr.search(async () => []), rr.tap(() => {}));
    const rec = rr.finish(g, out)!;
    expect(keys(rec)).toEqual(ROUTING_FIELDS);
    expect(rec.is_pathless_code_change).toBe(false);
    expect(rec.resolution).toEqual({ terms: [], candidates: [], chosen_file: null, method: "not-pathless", reads: [] });
    expect(rec.restated_goal).toBeNull();
  });

  test("the feature_compose hand-off sets routed_to, the compose gap id and the edit site on the bound dispatch's record", async () => {
    const target: CaptureTarget = {};
    const rr = routingRecorder();
    const goal = `Change the cap in ${FILE} to thirty seconds`;
    attachRoutingInput(target, rr.finish(goal, goal));
    await withCaptureTarget(target, async () => { noteRoutingHandOff({ goal, composeGapId: "route-edit-fixture", editSite: FILE }); });
    const rec = target.metadata!.routing_input!;
    expect(keys(rec)).toEqual(ROUTING_FIELDS);
    expect(rec.is_edit_intent).toBe(true);
    expect(rec.routed_to).toBe("feature_compose");
    expect(rec.compose_gap_id).toBe("route-edit-fixture");
    expect(rec.edit_site).toBe(FILE);
  });

  test("a hydrated gap record's cited file is recorded as the routing hint, then the hand-off", async () => {
    const target: CaptureTarget = {};
    const rr = routingRecorder();
    const goal = "Close gap gap-fixture-stale-stage by fixing the stage timer";
    attachRoutingInput(target, rr.finish(goal, goal));
    expect(target.metadata!.routing_input!.gap_hint).toBeNull();
    await withCaptureTarget(target, async () => {
      noteGapHydration({ goal, gapId: "gap-fixture-stale-stage", citedFile: FILE, applied: true });
      noteRoutingHandOff({ goal, composeGapId: "gap-fixture-stale-stage", editSite: FILE });
    });
    const rec = target.metadata!.routing_input!;
    expect(keys(rec)).toEqual(ROUTING_FIELDS);
    expect(rec.gap_hint).toEqual({ gap_id: "gap-fixture-stale-stage", cited_file: FILE, applied: true });
    expect(rec.routed_to).toBe("feature_compose");
  });

  test("a hand-off with no door record still records a complete routing_input", async () => {
    const target: CaptureTarget = {};
    await withCaptureTarget(target, async () => { noteRoutingHandOff({ goal: `Edit ${FILE}`, composeGapId: "route-edit-fixture", editSite: FILE }); });
    const rec = target.metadata!.routing_input!;
    expect(keys(rec)).toEqual(ROUTING_FIELDS);
    expect(keys(rec.resolution)).toEqual(RESOLUTION_FIELDS);
    expect(rec.resolution.method).toBe("not-captured-at-door");
  });
});
