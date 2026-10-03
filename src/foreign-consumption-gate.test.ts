import { describe, expect, test } from "bun:test";
import * as ias from "@avigopal/ias-executor-ts";
import type { ExecutionTrace } from "@avigopal/ias-executor-ts";
import { GATE_UNAVAILABLE_GAP, GATE_UNAVAILABLE_LOG, makeForeignConsumptionGate } from "./foreign-consumption-gate";

function trace(tasks: ExecutionTrace["tasks"], extra: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return { id: "exec_me", templateId: "t", status: "completed", inputImpulseIds: [], outputImpulseIds: [], tasks, ...extra };
}
const task = (over: Partial<ExecutionTrace["tasks"][number]>): ExecutionTrace["tasks"][number] => ({
  taskId: "t1", description: "", resolverId: "r", inputImpulseIds: [], outputImpulseIds: [], success: true, ...over,
});

const foreignTrace = trace([
  task({ inputImpulseIds: ["imp_x"], consumedProvenance: [{ impulseId: "imp_x", producerExecutionId: "exec_other", producerChain: [], origin: "own" }] }),
]);
const cleanTrace = trace([
  task({ inputImpulseIds: ["imp_y"], consumedProvenance: [{ impulseId: "imp_y", producerExecutionId: "exec_me", producerChain: [], origin: "own" }] }),
]);
const noProvenanceTrace = trace([task({ inputImpulseIds: ["imp_z"] })]);

function harness(lib: Record<string, unknown>, writeGap?: () => Promise<unknown>) {
  const logs: string[] = [];
  const gaps: unknown[] = [];
  const gate = makeForeignConsumptionGate({
    lib,
    log: (l) => logs.push(l),
    writeGap: (g) => { gaps.push(g); return writeGap ? writeGap() : undefined; },
  });
  return { gate, logs, gaps };
}

describe("foreign-consumption gate: ias-executor too old (export missing)", () => {
  test("a walk keeps running: no step is blocked; the loud log fires ONCE; the gap is written ONCE", () => {
    const { gate, logs, gaps } = harness({ /* an old dist: no foreignConsumption */ });
    expect(gate.available).toBe(false);
    // A walk checks every step it runs; none may be refused for lack of the gate.
    const steps = [foreignTrace, cleanTrace, noProvenanceTrace, cleanTrace];
    let ran = 0;
    for (const t of steps) {
      const v = gate.check(t, { strict: true });
      expect(v).toEqual({ block: false, status: "unavailable" });
      ran++;
    }
    expect(ran).toBe(steps.length);
    expect(logs.filter((l) => l === GATE_UNAVAILABLE_LOG)).toHaveLength(1);
    expect(logs[0]).toContain("[foreign-consumption] gate unavailable: ias-executor too old");
    expect(gaps).toEqual([GATE_UNAVAILABLE_GAP]);
    expect(GATE_UNAVAILABLE_GAP.title).toBe("foreign-consumption gate unavailable: ias-executor too old");
  });

  test("a failing gap write is itself logged, never thrown into the walk", async () => {
    const { gate, logs } = harness({}, () => Promise.reject(new Error("dev-vessel down")));
    expect(gate.check(cleanTrace, { strict: true }).block).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(logs.some((l) => l.includes("gap write FAILED") && l.includes("dev-vessel down"))).toBe(true);
  });
});

describe("foreign-consumption gate: export present", () => {
  const { gate, logs, gaps } = harness(ias as unknown as Record<string, unknown>);

  test("is available, and never reports itself unavailable", () => {
    expect(gate.available).toBe(true);
    gate.check(cleanTrace, { strict: true });
    expect(logs).toEqual([]);
    expect(gaps).toEqual([]);
  });

  test("blocks a run that consumed another execution's impulse, label notwithstanding", () => {
    const v = gate.check(foreignTrace, { strict: false });
    expect(v.block).toBe(true);
    expect(v.reason).toContain("provenance:foreign-impulse-consumed");
    expect(v.reason).toContain("exec_other");
  });

  test("passes a clean run", () => {
    expect(gate.check(cleanTrace, { strict: true })).toMatchObject({ block: false, status: "clean", executionId: "exec_me", strict: true });
  });

  test("BOUNDED fail-open: missing provenance on a consuming task blocks in strict mode", () => {
    const strict = gate.check(noProvenanceTrace, { strict: true });
    expect(strict.block).toBe(true);
    expect(strict.status).toBe("unverified");
    // Non-strict (synthesised traces at reach->mint) reports but does not block.
    expect(gate.check(noProvenanceTrace, { strict: false })).toMatchObject({ block: false, status: "unverified" });
  });

  test("a task that consumed nothing, or was skipped, is not unverifiable", () => {
    const t = trace([task({}), task({ taskId: "s", skipped: true, inputImpulseIds: ["i"] })]);
    expect(gate.check(t, { strict: true }).block).toBe(false);
  });
});

describe("reach->mint is STRICT", () => {
  test("refuses on MISSING provenance when the export is present", () => {
    const { gate } = harness(ias as unknown as Record<string, unknown>);
    const v = gate.checkForMint(noProvenanceTrace);
    expect(v).toMatchObject({ block: true, status: "unverified", carriedForward: false });
    expect(v.reason).toContain("provenance:unverifiable");
  });

  test("refuses on FOREIGN provenance", () => {
    const { gate } = harness(ias as unknown as Record<string, unknown>);
    const v = gate.checkForMint(foreignTrace);
    expect(v).toMatchObject({ block: true, status: "foreign", carriedForward: false });
    expect(v.reason).toContain("exec_other");
  });

  test("passes when it carries the gate's own strict verdict for the SAME execution", () => {
    const { gate } = harness(ias as unknown as Record<string, unknown>);
    const atReach = gate.check(cleanTrace, { strict: true });
    // The trace handed to the mint lacks provenance (e.g. re-shaped by the caller): the
    // carried same-execution verdict is what lets it through, and the result says so.
    const v = gate.checkForMint({ ...noProvenanceTrace, id: cleanTrace.id }, atReach);
    expect(v).toMatchObject({ block: false, status: "clean", carriedForward: true, executionId: "exec_me" });
  });

  test("a carried verdict is NOT accepted by assumption: other execution, non-strict, or not issued by the gate", () => {
    const { gate } = harness(ias as unknown as Record<string, unknown>);
    const otherExec = gate.check({ ...cleanTrace, id: "exec_someone_else" }, { strict: true });
    const nonStrict = gate.check(cleanTrace, { strict: false });
    const lookalike = { block: false, status: "clean" as const, executionId: "exec_me", strict: true };
    for (const carried of [otherExec, nonStrict, lookalike]) {
      const v = gate.checkForMint({ ...noProvenanceTrace, id: "exec_me" }, carried);
      expect(v).toMatchObject({ block: true, status: "unverified", carriedForward: false });
    }
    // A carried verdict that itself blocked still blocks.
    const blocked = gate.check(foreignTrace, { strict: true });
    expect(gate.checkForMint(foreignTrace, blocked)).toMatchObject({ block: true, carriedForward: true });
  });

  test("export missing: mint behaviour unchanged — non-blocking, loud once, gap once", () => {
    const { gate, logs, gaps } = harness({});
    for (const t of [noProvenanceTrace, foreignTrace, cleanTrace]) {
      expect(gate.checkForMint(t)).toMatchObject({ block: false, status: "unavailable" });
    }
    gate.check(cleanTrace, { strict: true });
    expect(logs.filter((l) => l === GATE_UNAVAILABLE_LOG)).toHaveLength(1);
    expect(gaps).toEqual([GATE_UNAVAILABLE_GAP]);
  });
});

describe("wiring in index.ts", () => {
  test("no NAMED import of foreignConsumption (a missing export would fail module link); the gate is used", async () => {
    const src = await Bun.file(new URL("./index.ts", import.meta.url)).text();
    const namedImports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@avigopal\/ias-executor-ts"/g)].map((m) => m[1]!);
    expect(namedImports.some((names) => /\bforeignConsumption\b/.test(names))).toBe(false);
    expect(src).toMatch(/import \* as iasExecutor from "@avigopal\/ias-executor-ts"/);
    // walk steps (shared helper) and runGoal attempt check strictly; reach->mint uses checkForMint
    expect((src.match(/foreignConsumptionGate\.check\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((src.match(/foreignConsumptionGate\.checkForMint\(/g) ?? []).length).toBe(1);
    // no non-strict gate call anywhere in index.ts
    expect(src).not.toMatch(/strict:\s*false/);
    // every mint call site either carries a verdict or relies on the strict re-check
    const mintCalls = [...src.matchAll(/mintReachedTrace\(([^;]*)\);/g)].map((m) => m[1]!);
    expect(mintCalls.length).toBeGreaterThanOrEqual(3);
    // called from the step loop and from each horizontal fan-out branch
    expect((src.match(/noteForeignConsumption\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
