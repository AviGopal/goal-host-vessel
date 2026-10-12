// PROTECTED: the captured -> replay adapter (src/judge/captured-to-replay.ts) and the held-out CLI contract the
// pull-sync admission glue relies on.
//
//   - a captured record (metadata.judge_input.<entry>, built here with goal-host's own capture builders) replays
//     through THIS tree's judge entries;
//   - a record whose NEEDED field is null, absent or cut by the capture's size cap is UNREPLAYABLE, with the field
//     named; it never "answers" (MUST-FAIL: a mutant adapter that defaults nulls is caught);
//   - the held-out output is a JSON array [{record_hash, reached}], and an unreplayable record is exactly
//     {record_hash, reached: null, unreplayable: [fields]}, from the function and from `cli.ts heldout`;
//   - the ever-green set is read from the FIXED gate-public path.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as cap from "../../src/judge/capture";
import { capturedToReplay, heldoutReplay, TRUNCATION_MARKER } from "../../src/judge/captured-to-replay";
import { everGreenPath } from "../../src/judge/credit-hold";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const base = {
  goal: "File a gap recording that the review stage stalled.", originalTargets: ["substrateGap_write"], deliverables: null, targetsSeenByWalk: ["substrateGap_write"], reframedFrom: null,
  persistedWrites: [] as string[], landed: null, landedEffective: false as boolean | null, producedShapes: ["substrateGap_write"], postReachSink: null, toolsTotal: null, groundedReads: null, outputImpulses: null, consumedInChain: null,
  surface: "walk" as const, digest: "d", taskSummary: "t", commandEvidence: null, walkEvidence: null, judgeView: null,
};
const record = (entry: string, input: object, verdict: unknown, llm: unknown = { consulted: false, judge: null }) => ({ schema: 1, entry, input, llm, ports: { citation: [], write_readback: {} }, verdict, calls: 1 });
const gateHollowReason = "deterministic:write-goal-no-artifact — the goal asks for a write";
const reachRec = (over: Partial<typeof base> = {}, verdict: unknown = { reached: false, reason: gateHollowReason, completion_shapes: [] }, llm?: unknown) => record("reachGate", cap.reachGateInput({ ...base, ...over }), verdict, llm);
const floorRec = (over: Record<string, unknown> = {}, gate: unknown = { reached: true, reason: "The answer explains it.", deterministic: false, abstain: false, completion_shapes: [] }) =>
  record("floorVerdict", { ...cap.floorVerdictInput({ ...base, goal: "Explain why the sky looks blue during the day", targetsSeenByWalk: ["llm_completion_dispatch"], persistedWrites: [], producedShapes: [], toolsTotal: 0, groundedReads: 0, landedEffective: false, surface: "floor", answerText: "Rayleigh scattering.", verdictReason: null, seededEvidence: false, toolsOk: 0, authoredAnswer: true }), ...over }, { reached: true, gate_verdict: gate, zero_tool_write_claim: false, fabricated_transcript: false });
const row = (hash: string, rec: ReturnType<typeof record>, family = "judge_input") => ({ record_hash: hash, family, entry: rec.entry, delivered: { reached: (rec.verdict as { reached?: boolean })?.reached ?? null, hollow_class: null }, input: rec, ports: rec.ports, llm: rec.llm });

describe("captured -> replay: replayable records replay", () => {
  test("a reach gate that hollowed a write goal with no write replays hollow (the gate decides; no downstream needed)", async () => {
    expect(await heldoutReplay([row("a", reachRec())])).toEqual([{ record_hash: "a", reached: false }]);
  });
  test("a reach gate that passed takes the delivered verdict of the layers after it", async () => {
    expect(await heldoutReplay([row("b", reachRec({ persistedWrites: ["substrateGap_write"] }, { reached: true, reason: "the gap was written", completion_shapes: [] }))])).toEqual([{ record_hash: "b", reached: true }]);
  });
  test("a floor verdict replays through the gate, the F-a clamp and the floor decision", async () => {
    expect(await heldoutReplay([row("c", floorRec())])).toEqual([{ record_hash: "c", reached: true }]);
  });
  test("shortcut and credit records replay to allowed / charged", async () => {
    const sc = record("floorShortcut", cap.floorShortcutInput({ goal: "Explain why the sky looks blue", activities: ["activity:universal-tool-fallback"], borrowed: false, targets: ["llm_completion_dispatch"] }), { allowed: true });
    const cr = record("creditOnHollow", cap.creditOnHollowInput({ templateId: "satisfier:x", verdict: { deterministic: true, reason: "deterministic:x" }, consumedInChain: 0, editEffectReach: null, lastPickProducedJudgedArtifact: true, noOracle: false }), { beta: "charged" });
    expect(await heldoutReplay([row("d", sc), row("e", cr)])).toEqual([{ record_hash: "d", reached: true }, { record_hash: "e", reached: true }]);
  });
});

describe("MUST-FAIL: a null or missing NEEDED field is unreplayable, never answered", () => {
  const cases: Array<[string, ReturnType<typeof record>, RegExp]> = [
    ["no write record (the gate did not run)", reachRec({ persistedWrites: null as never }), /persisted_writes/],
    ["no targets and no inferred targets", reachRec({ targetsSeenByWalk: null as never, originalTargets: null as never }), /targets_seen_by_walk/],
    ["a goal cut by the size cap", reachRec({ goal: `File a gap ${TRUNCATION_MARKER} 900 chars]` }), /input\.goal/],
    ["a null effective landing", reachRec({ landedEffective: null }, { reached: true, reason: "x" }), /evidence\.landed_effective \(null\)/],
    ["a record captured before landed_effective existed (counted, not scored)", (() => { const r = reachRec({}, { reached: true, reason: "x" }); delete (r.input as { evidence: Record<string, unknown> }).evidence["landed_effective"]; return r; })(), /evidence\.landed_effective \(absent: captured before the field existed\)/],
    ["the gate hollowed and the judge was never consulted, yet a candidate might pass the gate", reachRec({ persistedWrites: ["substrateGap_write"] }), /llm\.judge/],
    ["a floor record with no tools_ok", floorRec({ tools_ok: null }), /tools_ok/],
    ["a floor record with no gate verdict", { ...floorRec(), verdict: { reached: true } }, /gate_verdict/],
    ["a reframe with an unknown alt-walk reach", record("reframeAccept", cap.reframeAcceptInput({ goal: "g", originalTargets: ["a"], alternatives: [["b"]], altTargets: ["b"], altWalk: { reached: null, abstain: false, produced: [], substantiveShapes: [], onlyRawInput: false, skippedPlannedRetrieval: false }, origWantedDerived: false, plannedRetrieval: [] }), {}), /alt_walk\.reached/],
  ];
  for (const [name, rec, field] of cases) test(name, async () => {
    const [out] = await heldoutReplay([row("x", rec)]);
    expect(out!.reached).toBeNull();
    expect(Object.keys(out!).sort()).toEqual(["reached", "record_hash", "unreplayable"]);
    expect((out as { unreplayable: string[] }).unreplayable.join(" | ")).toMatch(field);
  });
  test("a routing_input record, an unknown entry or an unknown schema is unreplayable", async () => {
    const out = await heldoutReplay([row("r", reachRec(), "routing_input"), { ...row("u", reachRec()), entry: "nope" }, row("s", { ...reachRec(), schema: 2 })]);
    for (const o of out) { expect(o.reached).toBeNull(); expect((o as { unreplayable: string[] }).unreplayable.length).toBeGreaterThan(0); }
  });
  test("the checker sees a mutant adapter that DEFAULTS nulls (it answers a record that has no answer)", async () => {
    const answersNull = async (adapt: typeof capturedToReplay) => {
      const r = adapt(reachRec({ persistedWrites: null as never }, { reached: true, reason: "the gap was written" }), "reachGate");
      return r.ok;
    };
    expect(await answersNull(capturedToReplay)).toBe(false);
    const defaulting: typeof capturedToReplay = (rec, e, d) => {
      const c = JSON.parse(JSON.stringify(rec)); c.input.evidence.persisted_writes ??= []; return capturedToReplay(c, e, d);
    };
    expect(await answersNull(defaulting)).toBe(true); // the mutant is caught: it answers
  });
});

describe("the held-out output contract (function and CLI)", () => {
  const rows = [row("ok", reachRec()), row("bad", reachRec({ persistedWrites: null as never }))];
  const shapeOk = (out: unknown) => Array.isArray(out) && out.every((o) => {
    const k = Object.keys(o as object).sort().join(",");
    const v = o as { record_hash: unknown; reached: unknown; unreplayable?: unknown };
    if (typeof v.record_hash !== "string") return false;
    if (k === "reached,record_hash") return typeof v.reached === "boolean";
    return k === "reached,record_hash,unreplayable" && v.reached === null && Array.isArray(v.unreplayable) && (v.unreplayable as unknown[]).length > 0 && (v.unreplayable as unknown[]).every((f) => typeof f === "string");
  });
  test("heldoutReplay returns exactly the contract shape", async () => {
    const out = await heldoutReplay(rows);
    expect(shapeOk(out)).toBe(true);
    expect(out.map((o) => o.record_hash)).toEqual(["ok", "bad"]);
  });
  test("cli.ts heldout --sample <jsonl> prints the same array", async () => {
    const d = mkdtempSync(join(tmpdir(), "vc-heldout-"));
    try {
      const f = join(d, "sample.jsonl");
      writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const p = spawnSync(process.execPath, ["test/verdict-corpus/cli.ts", "heldout", "--sample", f, "--json"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
      expect(p.status).toBe(0);
      const out = JSON.parse(p.stdout.trim().split("\n").filter((l) => l.startsWith("[")).pop() ?? "null");
      expect(shapeOk(out)).toBe(true);
      expect(out).toEqual(await heldoutReplay(rows));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("MUST-FAIL: the shape checker refuses an unreplayable row reported as answered or without its fields", () => {
    expect(shapeOk([{ record_hash: "x", reached: null }])).toBe(false);
    expect(shapeOk([{ record_hash: "x", reached: false, unreplayable: ["f"] }])).toBe(false);
    expect(shapeOk([{ record_hash: "x", reached: null, unreplayable: [] }])).toBe(false);
  });
});

describe("the ever-green set is read from the fixed gate-public path", () => {
  test("not relative to WORKSPACE_ROOT", () => {
    expect(everGreenPath()).toBe("/workspace/.gate-public/verdict-corpus-green.goal-host-vessel.json");
  });
});
