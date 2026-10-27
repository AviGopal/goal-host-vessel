import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionTrace } from "@avigopal/ias-executor-ts";
import {
  attachWriteTasks,
  createAppliedWriteLedger,
  groundedForMint,
  hasVerifiedWriteAnchor,
  readBackConfirms,
  spliceStepWrites,
  writeReadShape,
  writtenRecordIdOf,
  type WriteTaskRecord,
} from "../src/applied-write";

// Findings agf_9oaufozk7r2a / agf_tqqcuevvt8o7 ("trace ≠ effect") and agf_j0wy8r5qx6mc (the walk can't confirm its
// own writes). A satisfier's real store write was not a task of any trace the walk minted from: the step's trace
// showed only the read it was asked for, the mint gate logged "no executed-tool anchor", and credit went to whatever
// composite happened to be traced.
//
// Fixtures are an invented store contract (custodyLedger_write, read back through archive:custody_ledger), written
// from two 5-word draws (draw-words.sh, 2026-10-27T02:48:48Z):
//   A "wireless labored vitalize job pretty"  -> goal: "Revive the labored wireless job and leave a pretty status entry for it."
//   B "storage quantum fabric grandpa custody" -> goal: "Move grandpa's quantum fabric sample into storage custody and log the handover."

const WRITE = "custodyLedger_write";
const READ = "archive:custody_ledger";
const ENTRY_ID = "custody-quantum-fabric-7";
const GOAL_A = "Revive the labored wireless job and leave a pretty status entry for it.";
const GOAL_B = "Move grandpa's quantum fabric sample into storage custody and log the handover.";

/** The vessel's answer to the write: the record id one object level below `body`. */
const writeAnswer = { success: true, shape: WRITE, body: { entry: { id: ENTRY_ID, holder: "grandpa", item: "quantum fabric sample" }, revision: 3 } };
/** The store read after it: a list that holds the entry. */
const readAnswer = { success: true, shape: READ, body: { entries: [{ id: "custody-wireless-job-2" }, { id: ENTRY_ID, holder: "grandpa" }] } };

function walkLedger(deliverable: (s: string) => boolean = (s) => s === WRITE) {
  const persisted: ExecutionTrace[] = [];
  const ledger = createAppliedWriteLedger({
    persist: (t) => { persisted.push(t); },
    terminalShapes: new Set([WRITE]),
    tags: ["operator:test", "surface:mcp"],
    parentExecutionId: () => "walk-parent-te",
    deliverable,
    now: () => 2_000,
  });
  return { ledger, persisted };
}

/** The satisfier step's own synthetic trace, as index.ts builds it: one task for the shape it was asked for. */
function stepTrace(shape: string): ExecutionTrace {
  return {
    id: `walk-satisfier-1-2000`,
    templateId: `satisfier:${shape}`,
    status: "completed",
    inputImpulseIds: [],
    outputImpulseIds: [],
    tasks: [{ taskId: "satisfier-resolve", description: `resolve ${shape} via connected vessel`, resolverId: shape, resolverTier: "pattern", inputImpulseIds: [], outputImpulseIds: [], outputShapes: [shape], success: true }],
    tags: ["satellite:non_terminal"],
    metadata: { satisfier: true, shape },
  };
}

/** The task a step trace's write record names. */
const writeTaskIn = (t: ExecutionTrace) => {
  const rec = (t.metadata?.["write_tasks"] as WriteTaskRecord[] | undefined)?.[0];
  return rec ? t.tasks.find((x) => x.taskId === rec.task_id) : undefined;
};

/** One satisfier attempt that wrote, then read the store back (the direct path: noteReadBack, then markVerified). */
function confirmedWriteStep() {
  const { ledger, persisted } = walkLedger();
  const m = ledger.mark();
  ledger.recordOutcome(WRITE, { site: "satisfier-direct", endpoint: "http://archive", pointer: { type: WRITE, holder: "grandpa", item: "quantum fabric sample", note: GOAL_B }, result: writeAnswer });
  const id = readBackConfirms(writeAnswer, readAnswer);
  expect(id).toBe(ENTRY_ID);
  ledger.noteReadBack(WRITE, { readShape: READ, confirmedId: id!, site: "write-read-back" });
  ledger.markVerified(WRITE);
  const t = attachWriteTasks(stepTrace(WRITE), ledger.tasksSince(m));
  return { ledger, persisted, trace: t, writes: ledger.tasksSince(m) };
}

describe("a satisfier's effecting write is a task of its step's trace", () => {
  test("MUST-FAIL: the write the step sent is a task in its trace, with resolver, shape, redacted pointer, output ref and success", () => {
    const { trace, writes } = confirmedWriteStep();
    const task = writeTaskIn(trace);
    expect(task).toBeDefined();
    expect(task!.resolverId).toBe(WRITE);
    expect(task!.success).toBe(true);
    expect(task!.outputShapes).toEqual([WRITE]);
    expect(task!.resolvedConfig).toMatchObject({ holder: "grandpa" });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.output_ref).toBe(ENTRY_ID);
    expect(writes[0]!.bound_fields).toEqual(["holder", "item", "note", "type"]);
    expect(writes[0]!.pointer_digest?.len).toBeGreaterThan(0);
    expect((trace.metadata?.["write_tasks"] as WriteTaskRecord[])[0]!.task_id).toBe(task!.taskId);
  });

  test("CONTROL: a step asked for the write shape itself carries that write once, as its own task", () => {
    const { trace } = confirmedWriteStep();
    expect(trace.tasks.map((t) => t.taskId)).toEqual(["satisfier-resolve"]);
    expect(trace.tasks[0]!.resolvedConfig).toMatchObject({ holder: "grandpa" });
  });

  test("MUST-FAIL: the read-back that confirmed the write names that write's task", () => {
    const { trace } = confirmedWriteStep();
    const task = writeTaskIn(trace)!;
    const rec = (trace.metadata?.["write_tasks"] as WriteTaskRecord[])[0]!;
    expect(rec.read_back).toEqual({ read_shape: READ, confirmed_id: ENTRY_ID, write_task_id: task.taskId, site: "write-read-back" });
  });

  test("MUST-FAIL: a satisfier-written reach has an executed-tool anchor, so the mint does not skip it as ungrounded", () => {
    const { trace } = confirmedWriteStep();
    expect(hasVerifiedWriteAnchor(trace)).toBe(true);
    expect(groundedForMint(false, trace)).toBe(true);
  });

  test("MUST-FAIL: the action-then-read path links its re-read to the action's write task", () => {
    const { ledger } = walkLedger();
    const m = ledger.mark();
    ledger.recordOutcome(WRITE, { site: "satisfier-action", pointer: { holder: "grandpa" }, result: writeAnswer });
    const id = readBackConfirms(writeAnswer, readAnswer);
    expect(ledger.confirmReadBack(WRITE, { readShape: READ, confirmedId: id!, site: "satisfier-reread" })).toBe(true);
    const t = attachWriteTasks(stepTrace(READ), ledger.tasksSince(m));
    expect(t.tasks.map((x) => x.resolverId)).toEqual([READ, WRITE]);
    expect(groundedForMint(false, t)).toBe(true);
  });

  test("MUST-FAIL: the composite keeps each step's accepted write after that step, and stays anchored", () => {
    const { writes } = confirmedWriteStep();
    const composite: ExecutionTrace = { ...stepTrace("archive:custody_ledger"), id: "walk-composite-te", tasks: [
      { taskId: "compose-step-1", description: "produce a", resolverId: "llm_completion", inputImpulseIds: [], outputImpulseIds: [], success: true },
      { taskId: "compose-step-2", description: "produce b", resolverId: WRITE, inputImpulseIds: [], outputImpulseIds: [], success: true },
    ], metadata: {} };
    const spliced = spliceStepWrites(composite, new Map([[1, writes]]));
    expect(spliced.tasks.map((t) => t.taskId)).toEqual(["compose-step-1", "compose-step-2"]);
    expect(spliced.tasks[1]!.resolvedConfig).toMatchObject({ holder: "grandpa" });
    expect(hasVerifiedWriteAnchor(composite)).toBe(false);
    expect(hasVerifiedWriteAnchor(spliced)).toBe(true);
    // A step that resolved a read and wrote through a sibling keeps the write as its own task right after it.
    const viaRead = spliceStepWrites({ ...composite, tasks: [{ ...composite.tasks[0]! }, { ...composite.tasks[1]!, resolverId: READ }] }, new Map([[1, writes]]));
    expect(viaRead.tasks.map((t) => t.resolverId)).toEqual(["llm_completion", READ, WRITE]);
    expect(hasVerifiedWriteAnchor(viaRead)).toBe(true);
    expect(composite.tasks[1]!.resolvedConfig).toBeUndefined(); // the composite passed in is not mutated
  });
});

describe("the walk reads a write back through the store it wrote", () => {
  test("MUST-FAIL: an unserved derived read name falls back to the one served read of the same store", () => {
    expect(writeReadShape(WRITE, [READ, "archive:custody_ledger_write", "llm_completion"])).toBe(READ);
    expect(writeReadShape("uiView_write", ["human_surface:ui_view", "uiPanel_write", "renderPolicy"])).toBe("human_surface:ui_view");
  });

  test("MUST-FAIL: a record id one object level below body is the written record's id", () => {
    expect(writtenRecordIdOf(writeAnswer)).toBe(ENTRY_ID);
    expect(writtenRecordIdOf(JSON.stringify(writeAnswer))).toBe(ENTRY_ID);
  });

  test("CONTROL: a served derived name is kept, and a top-level or body id still wins over a nested one", () => {
    expect(writeReadShape("memoryNote_write", ["memoryNote", "archive:memory_note"])).toBe("memoryNote");
    expect(writtenRecordIdOf({ id: "job-wireless", body: { entry: { id: "other" } } })).toBe("job-wireless");
    expect(writtenRecordIdOf({ body: { title: "pretty-status", entry: { id: "other" } } })).toBe("pretty-status");
  });

  test("CONTROL: an ambiguous store keeps the derived name instead of guessing", () => {
    expect(writeReadShape(WRITE, [READ, "vault:custody_ledger"])).toBe("custodyLedger");
  });
});

describe("controls: no anchor without a confirmed write in the minted trace", () => {
  test("CONTROL: a bare-LLM yes (no write task) is still skipped", () => {
    const t = stepTrace("llm_completion");
    t.tasks[0]!.resolverId = "llm_completion";
    expect(hasVerifiedWriteAnchor(t)).toBe(false);
    expect(groundedForMint(false, t)).toBe(false);
  });

  test("CONTROL: a refused write is a failed task with its refusal, gives no anchor, and its own record is failed and β-withheld", () => {
    const { ledger, persisted } = walkLedger();
    const m = ledger.mark();
    const w = ledger.recordOutcome(WRITE, { site: "satisfier-direct", pointer: { holder: "grandpa" }, result: null, reason: "422 unknown_holder: the wireless job is not a custody holder" });
    expect(w.success).toBe(false);
    expect(ledger.confirmReadBack(WRITE, { readShape: READ, confirmedId: ENTRY_ID, site: "satisfier-reread" })).toBe(false);
    const t = attachWriteTasks(stepTrace(WRITE), ledger.tasksSince(m));
    const task = writeTaskIn(t)!;
    expect(task.success).toBe(false);
    expect(task.error).toContain("unknown_holder");
    expect(task.outputShapes).toEqual([]);
    expect(groundedForMint(false, t)).toBe(false);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.status).toBe("failed");
    expect(persisted[0]!.tags).toContain("beta_withheld:true");
    expect((persisted[0]!.tags ?? []).some((x) => x.startsWith("reached:"))).toBe(false);
  });

  test("CONTROL: a refused write is not spliced into the composite (it changed nothing)", () => {
    const { ledger } = walkLedger();
    const w = ledger.recordOutcome(WRITE, { site: "satisfier-action", result: null, reason: "refused" });
    const c: ExecutionTrace = { ...stepTrace(WRITE), metadata: {} };
    expect(spliceStepWrites(c, new Map([[0, [w]]]))).toBe(c);
  });

  test("CONTROL: an accepted write whose read-back does not hold its id is not confirmed and gives no anchor", () => {
    const { ledger } = walkLedger();
    const m = ledger.mark();
    ledger.recordOutcome(WRITE, { site: "satisfier-action", result: writeAnswer });
    const staleRead = { body: { entries: [{ id: "custody-wireless-job-2" }] } };
    expect(readBackConfirms(writeAnswer, staleRead)).toBeNull();
    ledger.markVerified(WRITE); // the re-read returned content, but nothing confirmed this write
    expect(groundedForMint(false, attachWriteTasks(stepTrace(READ), ledger.tasksSince(m)))).toBe(false);
  });

  test("CONTROL: a write whose answer names no record is never confirmed by an always-answering read", () => {
    expect(readBackConfirms({ success: true, body: { revision: 4 } }, readAnswer)).toBeNull();
  });

  test("CONTROL: a read-back holding a different id does not link to the latest write", () => {
    const { ledger } = walkLedger();
    ledger.recordOutcome(WRITE, { site: "satisfier-direct", result: writeAnswer });
    expect(ledger.confirmReadBack(WRITE, { readShape: READ, confirmedId: "custody-wireless-job-2", site: "write-read-back" })).toBe(false);
  });

  test("CONTROL: a confirmed write to a store the goal did not ask for is an effect, not a mint anchor", () => {
    const { ledger } = walkLedger(() => false);
    const m = ledger.mark();
    ledger.recordOutcome(WRITE, { site: "satisfier-direct", result: writeAnswer });
    ledger.confirmReadBack(WRITE, { readShape: READ, confirmedId: ENTRY_ID, site: "write-read-back" });
    expect(groundedForMint(false, attachWriteTasks(stepTrace(WRITE), ledger.tasksSince(m)))).toBe(false);
  });

  test("CONTROL: the anchor is trace-local: a template trace that did not write gets no credit for another step's write", () => {
    confirmedWriteStep(); // the walk's satisfier step wrote and confirmed
    const template: ExecutionTrace = { ...stepTrace("traceAggregateReport"), templateId: "walk-composite-fake-writer", metadata: {} };
    expect(groundedForMint(false, template)).toBe(false);
  });

  test("CONTROL: the walk's own pool-mechanics write never anchors", () => {
    const { ledger } = walkLedger(() => true);
    const m = ledger.mark();
    const ans = { success: true, body: { id: "pool-job-1" } };
    ledger.recordOutcome("poolImpulse_write", { site: "walk", result: ans });
    ledger.confirmReadBack("poolImpulse_write", { readShape: "poolImpulse", confirmedId: "pool-job-1", site: "write-read-back" });
    expect(groundedForMint(false, attachWriteTasks(stepTrace("poolImpulse"), ledger.tasksSince(m)))).toBe(false);
  });

  test("CONTROL: an existing grounded reach stays grounded", () => {
    expect(groundedForMint(true, stepTrace("llm_completion"))).toBe(true);
  });

  test("CONTROL: the pointer is redacted: a secret-named field is replaced and a long bound payload is cut", () => {
    const { ledger } = walkLedger();
    const body = `${GOAL_A} `.repeat(40);
    const w = ledger.recordOutcome(WRITE, { site: "satisfier-direct", pointer: { holder: "grandpa", api_key: "k-123", body }, result: writeAnswer });
    expect(w.resolved_config?.["api_key"]).toBe("[redacted]");
    expect(String(w.resolved_config?.["body"]).length).toBeLessThan(body.length);
    expect(JSON.stringify(w)).not.toContain("k-123");
  });
});

describe("the walk routes its writes, read-backs and the mint through these", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

  test("MUST-FAIL: every rawResolve of a write shape is recorded as a write task, accepted or refused", () => {
    expect(src).toContain("if (isAppliedWriteShape(shape)) appliedWrites.recordOutcome(shape, { site, endpoint, pointer: sent.pointer, result, reason: result == null ? lastRawResolveReason : null });");
    expect(src).toContain("sent.pointer = pointer;");
  });

  test("MUST-FAIL: both satisfier step sites attach the writes their resolve sent", () => {
    expect(src).toContain("const _writeMark = appliedWrites.mark();\n        const resolved = await vesselResolveShape(satisfiableNow);");
    expect(src).toContain("attachWriteTasks(synthTrace, _w);");
    expect(src).toContain("const _vrWriteMark = appliedWrites.mark();\n                const _vrResolved = await vesselResolveShape(missingShape);");
    expect(src).toContain("attachWriteTasks(_vrSynthTrace, _w);");
  });

  test("MUST-FAIL: the write read-back derives its read through the store and notes what confirmed it", () => {
    expect(src).toContain("const id = writtenRecordIdOf(writeResult);");
    expect(src).toContain("const readShape = writeReadShape(writeShape, registryResolverShapes ?? _live);");
    expect(src).toContain("appliedWrites.noteReadBack(writeShape, readBack);");
    expect(src).toContain("appliedWrites.confirmReadBack(action.shape, { readShape: shape, confirmedId: _rereadId, site: \"satisfier-reread\" });");
  });

  test("MUST-FAIL: the composite keeps step writes and the mint gate sees a confirmed write task", () => {
    expect(src).toContain("const compositeWithWrites = spliceStepWrites(composite, stepWrites);");
    expect(src).toContain("const compositeGrounded = hasVerifiedWriteAnchor(compositeWithWrites) || mintGrounded || (");
    expect(src).toContain("Object.assign(composite, { tasks: compositeWithWrites.tasks, metadata: compositeWithWrites.metadata });");
    expect(src).toContain("if (!groundedForMint(grounded, trace as unknown as Pick<ExecutionTrace, \"tasks\" | \"metadata\">)) { console.log(`[goal-host-vessel] reach->mint: SKIP ungrounded reach ${executionId} — bare-LLM-yes / no executed-tool anchor; not an extractable recipe`); return; }");
  });

  test("CONTROL: the composite's reach tag is still stamped from the same decision the mint uses", () => {
    const at = src.indexOf("Object.assign(composite, { tasks: compositeWithWrites.tasks, metadata: compositeWithWrites.metadata });");
    expect(at).toBeGreaterThan(0);
    expect(src.indexOf('composite.tags = [...(composite.tags ?? []), compositeGrounded ? "reached:true" : "reached:false"];', at)).toBeGreaterThan(at);
  });
});
