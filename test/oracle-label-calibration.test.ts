import { describe, it, expect } from "bun:test";
import { consumeOracleLabel, type OracleLabelRecord } from "../src/oracle-label-consumer";

/**
 * CALIBRATION LABELS INFLUENCE NOTHING.
 *
 * A goal_verification_label with purpose:"calibration" comes from a BLIND calibration
 * sheet: a human judges sealed runs so the judge's accuracy can be measured. If such a
 * label could override record.reached, burn the consumption latch, or file a disagreement
 * gap, the measurement would feed back into the thing it measures (law 12) — the sample
 * would stop being a sample.
 *
 * The CONTROL cases pin the opposite: the same label without purpose:"calibration" still
 * overrides and files exactly as before.
 */

const ACT = "http://act.test";
const DEV = "http://dev.test";

type Call = { url: string; body: any };

function stubFetch(rows: unknown[]) {
  const calls: Call[] = [];
  const impl = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.startsWith(ACT)) {
      const limit = Number(body?.pointer?.limit ?? 20);
      return new Response(JSON.stringify({ success: true, content: JSON.stringify(rows.slice(0, limit)) }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function sealedRun(reached: boolean): OracleLabelRecord {
  return {
    status: "completed",
    executionId: "exec-sealed-1",
    goal: "summarise the open gaps",
    reached,
    goalReachReason: "judge: artifact satisfies the goal",
    learning: { oracleLabelWritten: false },
  };
}

const calibrationLabel = {
  verdict: "not_achieved",
  labeler: "human",
  notes: "blind sheet: this does not satisfy the goal",
  purpose: "calibration",
  window_id: "win-2026-10-03",
  sample_draw_id: "draw-7",
};
const { purpose: _p, window_id: _w, sample_draw_id: _s, ...ordinaryHumanLabel } = calibrationLabel;

const settle = () => new Promise((r) => setTimeout(r, 5));
const gapWrites = (calls: Call[]) => calls.filter((c) => c.url.startsWith(DEV));

describe("oracle-label consumer: calibration labels influence nothing", () => {
  it("MUST-FAIL: a calibration label CONTRADICTING the judge on a sealed run changes nothing", async () => {
    const rec = sealedRun(true);
    const before = JSON.parse(JSON.stringify(rec));
    const { impl, calls } = stubFetch([calibrationLabel]);
    await consumeOracleLabel(rec, { activityApiEndpoint: ACT, devVesselEndpoint: DEV, apiKey: "", fetchImpl: impl });
    await settle();
    // record.reached unchanged, no human-graded marking, no override text
    expect(rec.reached).toBe(true);
    expect(rec.humanGraded).toBeUndefined();
    expect(rec.humanReachNotes).toBeUndefined();
    expect(rec.goalReachReason).toBe(before.goalReachReason);
    // the latch is NOT burned — a later real human verdict must still be consumable
    expect(rec.learning!.oracleLabelWritten).toBe(false);
    expect(rec).toEqual(before);
    // zero disagreement-gap writes
    expect(gapWrites(calls)).toHaveLength(0);
    // no other network effect at all (no credit / posterior / ribosome / failure-store write):
    // the only call is the corpus READ
    expect(calls.every((c) => c.url.startsWith(ACT) && c.body?.pointer?.type === "goal_verification_label")).toBe(true);
  });

  it("MUST-FAIL: a newer calibration label does not MASK an older ordinary human verdict", async () => {
    const rec = sealedRun(true);
    // corpus order is created_at DESC: the calibration row is newest
    const { impl, calls } = stubFetch([calibrationLabel, ordinaryHumanLabel]);
    await consumeOracleLabel(rec, { activityApiEndpoint: ACT, devVesselEndpoint: DEV, apiKey: "", fetchImpl: impl });
    await settle();
    expect(rec.reached).toBe(false);
    expect(rec.humanGraded).toBe(true);
    expect(rec.humanReachNotes).not.toContain("blind sheet:");
    expect(rec.humanReachNotes).toBe(ordinaryHumanLabel.notes);
    expect(gapWrites(calls)).toHaveLength(1);
    expect(JSON.stringify(gapWrites(calls)[0].body)).not.toContain("win-2026-10-03");
  });

  it("CONTROL: the same label WITHOUT purpose:\"calibration\" overrides reached and files the disagreement gap", async () => {
    const rec = sealedRun(true);
    const { impl, calls } = stubFetch([ordinaryHumanLabel]);
    await consumeOracleLabel(rec, { activityApiEndpoint: ACT, devVesselEndpoint: DEV, apiKey: "", fetchImpl: impl });
    await settle();
    expect(rec.reached).toBe(false);
    expect(rec.humanGraded).toBe(true);
    expect(rec.learning!.oracleLabelWritten).toBe(true);
    expect(rec.goalReachReason).toContain("[human override:");
    const gaps = gapWrites(calls);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].body.impulse.pointer.gap.id).toBe("gap-oracle-label-disagreement-exec-sealed-1");
  });

  it("CONTROL: an agreeing ordinary human label overrides without filing a gap", async () => {
    const rec = sealedRun(false);
    const { impl, calls } = stubFetch([ordinaryHumanLabel]);
    await consumeOracleLabel(rec, { activityApiEndpoint: ACT, devVesselEndpoint: DEV, apiKey: "", fetchImpl: impl });
    await settle();
    expect(rec.reached).toBe(false);
    expect(rec.humanGraded).toBe(true);
    expect(gapWrites(calls)).toHaveLength(0);
  });

  it("CONTROL: a machine label still does not burn the latch", async () => {
    const rec = sealedRun(true);
    const { impl, calls } = stubFetch([{ verdict: "not_achieved", labeler: "deterministic" }]);
    await consumeOracleLabel(rec, { activityApiEndpoint: ACT, devVesselEndpoint: DEV, apiKey: "", fetchImpl: impl });
    await settle();
    expect(rec.reached).toBe(true);
    expect(rec.learning!.oracleLabelWritten).toBe(false);
    expect(gapWrites(calls)).toHaveLength(0);
  });

  it("index.ts routes both poll paths through the extracted consumer", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const idx = src.indexOf("function maybeConsumeOracleLabel(");
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 800)).toContain("consumeOracleLabel(");
    // the old inline consumer is gone, so there is one implementation to keep honest
    expect(src).not.toContain("gap-oracle-label-disagreement-");
  });
});
