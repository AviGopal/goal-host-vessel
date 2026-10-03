import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionTrace } from "@avigopal/ias-executor-ts";
import { createAppliedWriteLedger, isAppliedWriteShape, settleVerifiedWrite, stripWalkOperatorMarker, walkResolveBody } from "../src/applied-write";

// Gap a-substrategap-write-satisfier-can-close-or-re-source-an-existing-gap-with-no-verdict.
// A terminal substrateGap_write was applied, read back persisted, then discarded: the satisfier
// fell through, returned nothing, and the write that changed the store left no durable trace while
// the walk went on to apply the same write again.

const notEmpty = (): boolean => false;
const GAP_WRITE = "substrateGap_write";
const readBack = { success: true, shape: "substrateGap", body: { id: "gap-x", status: "open" } };

function stubLedger(terminal: string[] = [GAP_WRITE]) {
  const persisted: ExecutionTrace[] = [];
  const ledger = createAppliedWriteLedger({
    persist: (t) => { persisted.push(t); },
    terminalShapes: new Set(terminal),
    tags: ["operator:test", "surface:mcp"],
    parentExecutionId: () => "walk-parent-1",
    now: () => 1_000,
  });
  return { ledger, persisted };
}

describe("applied-write: a verified terminal write ends the satisfier attempt", () => {
  test("MUST-FAIL: a terminal write read back persisted returns its read-back content instead of falling through", () => {
    const s = settleVerifiedWrite({ persisted: true, content: readBack }, true, notEmpty);
    expect(s.kind).toBe("terminal_persisted");
    if (s.kind !== "terminal_persisted") return;
    expect(s.returns).toBe(true);
    expect(s.content).toEqual(readBack);
  });

  test("CONTROL: a terminal write whose effect is not readable back still takes the non-persistence path", () => {
    expect(settleVerifiedWrite({ persisted: false }, true, notEmpty).kind).toBe("not_persisted");
  });

  test("CONTROL: a write with no read-back verdict still takes the existing service-error or return path", () => {
    expect(settleVerifiedWrite(null, true, notEmpty).kind).toBe("unverified");
  });

  test("CONTROL: a terminal write persisted with an empty body is still treated as unsatisfied", () => {
    expect(settleVerifiedWrite({ persisted: true, content: readBack }, true, () => true).kind).toBe("empty_terminal");
  });

  test("CONTROL: a non-terminal persisted write still returns its read-back content unchanged", () => {
    const s = settleVerifiedWrite({ persisted: true, content: readBack }, false, notEmpty);
    expect(s).toEqual({ kind: "persisted", returns: true, content: readBack });
  });
});

describe("applied-write: every applied write is durably traced where it is applied", () => {
  test("MUST-FAIL: an applied write hands the trace writer one record naming the shape with success", () => {
    const { ledger, persisted } = stubLedger();
    ledger.recordApplied(GAP_WRITE, { site: "satisfier-direct", endpoint: "http://dev:8090", result: { success: true } });
    expect(persisted.length).toBe(1);
    const t = persisted[0]!;
    expect(t.templateId).toBe(`satisfier:${GAP_WRITE}`);
    expect(t.status).toBe("completed");
    expect(t.tasks[0]?.success).toBe(true);
    expect(t.tasks[0]?.outputShapes).toContain(GAP_WRITE);
    expect(t.parentExecutionId).toBe("walk-parent-1");
    expect(t.tags).toContain("operator:test");
    expect(t.metadata?.["site"]).toBe("satisfier-direct");
  });

  test("MUST-FAIL: the write record is an ungraded satellite and carries no reach verdict tag", () => {
    const { ledger, persisted } = stubLedger();
    ledger.recordApplied(GAP_WRITE, { site: "satisfier-direct", result: { success: true } });
    const t = persisted[0];
    expect(t).toBeDefined();
    // activity-api isHollowSatellite: id walk-satisfier-* or activity_id satisfier:* is SKIPPED, never blamed.
    expect(t!.id.startsWith("walk-satisfier-")).toBe(true);
    expect((t!.tags ?? []).some((x) => x.startsWith("reached:"))).toBe(false);
  });

  test("MUST-FAIL: each re-application is its own durable record numbered by attempt", () => {
    const { ledger, persisted } = stubLedger();
    ledger.recordApplied(GAP_WRITE, { site: "satisfier-direct", result: {} });
    ledger.recordApplied(GAP_WRITE, { site: "bridge-sink", result: {} });
    expect(persisted.length).toBe(2);
    expect(persisted.map((t) => t.metadata?.["attempt"])).toEqual([1, 2]);
    expect(new Set(persisted.map((t) => t.id)).size).toBe(2);
    expect(ledger.appliedCount(GAP_WRITE)).toBe(2);
  });
});

describe("applied-write: a verified terminal write is not re-applied in the same walk", () => {
  test("MUST-FAIL: after a verified persist the same terminal write may not be applied again", () => {
    const { ledger } = stubLedger();
    ledger.recordApplied(GAP_WRITE, { site: "satisfier-direct", result: {} });
    ledger.markVerified(GAP_WRITE);
    expect(ledger.mayApply(GAP_WRITE)).toBe(false);
  });

  test("CONTROL: a terminal write that was applied but never verified may still be retried", () => {
    const { ledger } = stubLedger();
    ledger.recordApplied(GAP_WRITE, { site: "satisfier-direct", result: {} });
    expect(ledger.mayApply(GAP_WRITE)).toBe(true);
  });

  test("CONTROL: a verified non-terminal write does not block that shape", () => {
    const { ledger } = stubLedger([]);
    ledger.markVerified("memoryNote_write");
    expect(ledger.mayApply("memoryNote_write")).toBe(true);
  });

  test("CONTROL: verifying one terminal write does not block another terminal shape", () => {
    const { ledger } = stubLedger([GAP_WRITE, "memoryNote_write"]);
    ledger.markVerified(GAP_WRITE);
    expect(ledger.mayApply("memoryNote_write")).toBe(true);
  });
});

describe("applied-write: which shapes count as applied writes", () => {
  test("CONTROL: store-mutating write shapes are applied writes", () => {
    for (const s of [GAP_WRITE, "memoryNote_write", "concept_create_write", "obsidian:write_note", "write_note"]) {
      expect(isAppliedWriteShape(s)).toBe(true);
    }
  });

  test("CONTROL: the read-back shapes verifyWritePersisted derives are never recorded as writes", () => {
    for (const s of ["substrateGap", "memoryNote", "concept", "obsidian:write", "shellResult", "bodyHonestyPolicy"]) {
      expect(isAppliedWriteShape(s)).toBe(false);
    }
  });
});

describe("applied-write: the walk routes through the ledger", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

  test("CONTROL: rawResolve records an accepted write at its only success return", () => {
    expect(src).toContain("if (isAppliedWriteShape(shape)) appliedWrites.recordApplied(shape, { site, endpoint, result: content });\n    return content;\n  };");
  });

  test("CONTROL: the satisfier entry, arg-correction and action-then-read re-read ask before re-applying", () => {
    expect(src).toContain('if (refuseReapply(shape, "satisfier")) return null;');
    expect(src).toContain('!refuseReapply(shape, "arg-correction")');
    expect(src).toContain('refuseReapply(shape, "action-then-read re-read")');
  });

  test("CONTROL: the satisfier returns on a verified terminal write via settleVerifiedWrite", () => {
    expect(src).toContain("const _settle = settleVerifiedWrite(v, _terminalWrite, _persistedBodyEmpty);");
    expect(src).toContain("if (_settle.returns) return { content: direct, effect: effectTupleOf(shape, ep?.endpoint, direct) };");
  });
});

// The gap store accepts a pointer-level `operator: "operator:<id>"` marker that bypasses its hold
// and close-evidence guards. Every walk pointer is built from pool, goal or LLM content, so a walk
// write must never carry that marker to a resolver, wherever in the body it sits.
describe("applied-write: a walk write never carries an operator marker to a resolver", () => {
  /** Stands in for the resolver: it sees exactly what rawResolve would POST. */
  const stubResolver = (shape: string, pointer: Record<string, unknown>, extras: Record<string, unknown> = {}) =>
    JSON.parse(JSON.stringify(walkResolveBody(shape, pointer, extras))) as Record<string, any>;

  const llmGapPointer = () => ({
    type: GAP_WRITE,
    operator: "operator:x",
    gap: { id: "gap-x", status: "closed", summary: "closed by the walk", operator: "operator:x" },
  });

  test("MUST-FAIL: an LLM-synthesised substrateGap_write pointer reaches the resolver without its operator field", () => {
    const seen = stubResolver(GAP_WRITE, llmGapPointer());
    expect(JSON.stringify(seen)).not.toContain("operator");
    expect("operator" in seen.impulse.pointer).toBe(false);
    expect("operator" in seen.impulse.pointer.gap).toBe(false);
  });

  test("MUST-FAIL: an operator marker at body top level, under pointer and under impulse.pointer is stripped from a write", () => {
    const body = { operator: "operator:x", pointer: { id: "g", operator: "operator:x" }, impulse: { type: GAP_WRITE, pointer: { id: "g", operator: "operator:x" } } };
    expect(stripWalkOperatorMarker(GAP_WRITE, body)).toEqual({ pointer: { id: "g" }, impulse: { type: GAP_WRITE, pointer: { id: "g" } } });
  });

  test("MUST-FAIL: only the operator field is removed and every other write field is untouched", () => {
    const seen = stubResolver(GAP_WRITE, llmGapPointer());
    expect(seen).toEqual({ impulse: { pointer: { type: GAP_WRITE, gap: { id: "gap-x", status: "closed", summary: "closed by the walk" } } } });
  });

  test("CONTROL: the caller pointer object is not mutated by stripping", () => {
    const p = llmGapPointer();
    stubResolver(GAP_WRITE, p);
    expect(p.operator).toBe("operator:x");
    expect(p.gap.operator).toBe("operator:x");
  });

  test("CONTROL: a non-write pointer is passed through unchanged, operator field included", () => {
    const pointer = { type: "substrateGap", operator: "operator:x", filter: { operator: ">=" } };
    expect(stubResolver("substrateGap", pointer)).toEqual({ impulse: { pointer } });
  });

  test("CONTROL: an llm_completion body still threads its prompt and extras to the top level", () => {
    const seen = stubResolver("llm_completion", { prompt: "p" }, { caller: "c", task_type: "t" });
    expect(seen).toEqual({ impulse: { pointer: { prompt: "p" } }, prompt: "p", caller: "c", task_type: "t" });
  });

  test("CONTROL: rawResolve POSTs the body walkResolveBody built", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    expect(src).toContain("body: JSON.stringify(walkResolveBody(shape, pointer, {");
  });
});
