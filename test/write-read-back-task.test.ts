// A SINGLE-STEP SATISFIER WRITE REACH CARRIES ITS WRITE AND THE READ THAT CONFIRMED IT AS TASKS (follow-on (A) to
// findings agf_9oaufozk7r2a / agf_tqqcuevvt8o7; research's by-effect check of c8120857, dispatch 9328a7cb).
// Before: the read-back lived only in the write record's metadata, so a single-step write reach's durable trace held ONE
// task (the write merged into the step's own task): the ribosome's event path skipped it (taskCount=1) while the mint saw
// it, and goal-host never minted a single satisfier step at all. Now the confirming read is a task of the trace, linked
// to the write task it confirmed, and a single confirmed-write step goes to the mint after its durable persist.
// MUST-FAIL on the parent: no read-back task, no readBackTaskOf export, no single-step mint branch.
// Fixtures: an invented store contract; words from a 5-word draw (2026-10-27T07:54:19Z: backfire vexingly kung bountiful edgy).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionTrace } from "@avigopal/ias-executor-ts";
import * as AW from "../src/applied-write";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
const WRITE = "bountyLedger_write";
const READ = "vault:bounty_ledger";
const ID = "bounty-edgy-kung-3";
const answer = { success: true, body: { entry: { id: ID, note: "bountiful backfire" } } };
const readAns = { body: { entries: [{ id: ID }] } };

function ledger(deliverable = true) {
  return AW.createAppliedWriteLedger({ persist: () => {}, terminalShapes: new Set([WRITE]), deliverable: () => deliverable, now: () => 3_000 });
}
function step(shape: string): ExecutionTrace {
  return { id: "walk-satisfier-1-3000", templateId: `satisfier:${shape}`, status: "completed", inputImpulseIds: [], outputImpulseIds: [],
    tasks: [{ taskId: "satisfier-resolve", description: "", resolverId: shape, resolverTier: "pattern", inputImpulseIds: [], outputImpulseIds: [], outputShapes: [shape], success: true }],
    metadata: { satisfier: true, shape } };
}
/** A single-step direct write reach, as the walk records it: write, read back, markVerified. */
function singleStepWrite(deliverable = true) {
  const l = ledger(deliverable);
  const m = l.mark();
  l.recordOutcome(WRITE, { site: "satisfier-direct", pointer: { note: "vexingly edgy" }, result: answer });
  l.noteReadBack(WRITE, { readShape: READ, confirmedId: AW.readBackConfirms(answer, readAns)!, site: "write-read-back" });
  l.markVerified(WRITE);
  return AW.attachWriteTasks(step(WRITE), l.tasksSince(m));
}

describe("the confirming read is a task of the trace, linked to the write it confirmed", () => {
  test("[MUST-FAIL] a single-step write reach's trace holds the write task and its read-back task (taskCount >= 2)", () => {
    const t = singleStepWrite();
    expect(t.tasks.length).toBeGreaterThanOrEqual(2);
    const rb = t.tasks.find((x) => x.resolverId === READ)!;
    expect(rb).toBeDefined();
    expect(rb.consumedFromTaskIds).toEqual(["satisfier-resolve"]);
    expect(rb.success).toBe(true);
  });

  test("[MUST-FAIL] the write record names its read-back task", () => {
    const t = singleStepWrite();
    const rec = (t.metadata?.["write_tasks"] as AW.WriteTaskRecord[])[0]!;
    expect(rec.read_back?.read_task_id).toBe("satisfier-resolve-read-back");
    expect(t.tasks.map((x) => x.taskId)).toContain("satisfier-resolve-read-back");
    expect(AW.hasVerifiedWriteAnchor(t)).toBe(true);
  });

  test("[MUST-FAIL] the walk mints a single confirmed-write step after its durable persist", () => {
    expect(SRC).toContain("} else if (hasVerifiedWriteAnchor(lastTrace)) {");
    expect(SRC).toContain("mintSingleConfirmedWrite = mintGrounded;");
    const persist = SRC.indexOf("await persistWithinDeadline(persistSatisfierTrace(durableTrace), (await resolveSelectionTuning()).satisfierFlushDeadlineMs, durableTrace.id);");
    const mint = SRC.indexOf("if (reached && mintSingleConfirmedWrite !== null && opts.learningMode !== \"observe\") void mintReachedTrace(durableTrace as any, mintSingleConfirmedWrite, goalHashOf(goal), undefined, goal);");
    expect(persist).toBeGreaterThan(0);
    expect(mint).toBeGreaterThan(persist);
  });

  test("[CONTROL] a bare-LLM reach has no write task and no read-back task", () => {
    const t = step("llm_completion");
    AW.attachWriteTasks(t, []);
    expect(t.tasks.map((x) => x.taskId)).toEqual(["satisfier-resolve"]);
    expect(AW.hasVerifiedWriteAnchor(t)).toBe(false);
  });

  test("[CONTROL] an accepted but unconfirmed write gets no read-back task and no anchor", () => {
    const l = ledger();
    const m = l.mark();
    l.recordOutcome(WRITE, { site: "satisfier-direct", result: answer });
    l.markVerified(WRITE);
    const t = AW.attachWriteTasks(step(WRITE), l.tasksSince(m));
    expect(t.tasks.some((x) => x.resolverId === READ)).toBe(false);
    expect(AW.hasVerifiedWriteAnchor(t)).toBe(false);
  });

  test("[CONTROL] a refused write gets no read-back task", () => {
    const l = ledger();
    const m = l.mark();
    l.recordOutcome(WRITE, { site: "satisfier-direct", result: null, reason: "422 kung: refused" });
    const t = AW.attachWriteTasks(step(READ), l.tasksSince(m));
    expect(t.tasks.filter((x) => x.taskId.endsWith("-read-back"))).toEqual([]);
  });
});
