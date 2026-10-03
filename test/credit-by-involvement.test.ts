// Acceptance fix 2: credit by involvement (APPROACH.md §9.3). Live: node 2 (f3c310c5) reached via
// [satisfier:web_search (carried), satisfier:llm_completion, activity:⟨auto-bridge-uiPanel_write⟩]
// and "alpha-credited last pick" credited only the bridge — a write of an empty "Untitled" panel the
// walk had flagged "effect NOT independently readable". The steps that produced the report got nothing.
import { describe, expect, test } from "bun:test";
import * as walkPool from "../src/walk-pool";

type Edge = { inputShapes: string[]; inputImpulseIds: string[]; outputShapes: string[]; outputImpulseIds: string[] };
const involvedSteps = (walkPool as Record<string, unknown>)["involvedSteps"] as
  | ((e: Array<Edge | undefined>, d: ReadonlySet<string>, u?: (i: number) => boolean, stub?: (i: number) => boolean) => number[]) | undefined;
const isWriteShape = (walkPool as Record<string, unknown>)["isWriteShape"] as ((s: string) => boolean) | undefined;

const N2: Edge[] = [
  { inputShapes: [], inputImpulseIds: [], outputShapes: ["web_search"], outputImpulseIds: ["ws"] },
  { inputShapes: ["web_search"], inputImpulseIds: ["ws"], outputShapes: ["llm_completion"], outputImpulseIds: ["llm"] },
  { inputShapes: ["llm_completion"], inputImpulseIds: ["llm"], outputShapes: ["uiPanel_write"], outputImpulseIds: ["ui"] },
];
const verified = new Set<string>();   // the panel write was NOT read back
const uncreditable = (i: number) => { const o = N2[i]!.outputShapes; return o.length > 0 && o.every((s) => isWriteShape!(s) && !verified.has(s)); };

describe("involvedSteps", () => {
  test("must-fail on parent: node 2 credits web_search and llm_completion, not the unread panel write", () => {
    expect(typeof involvedSteps).toBe("function");
    expect(involvedSteps!(N2, new Set(["uiPanel_write", "llm_completion", "web_search"]), uncreditable)).toEqual([0, 1]);
  });
  test("credit flows back along recorded edges even through a write that itself earns nothing", () => {
    expect(involvedSteps!(N2, new Set(["uiPanel_write"]), uncreditable)).toEqual([0, 1]);
  });
  test("a write read back independently (verified) is creditable like any producer", () => {
    expect(involvedSteps!(N2, new Set(["uiPanel_write"]))).toEqual([0, 1, 2]);
  });
  test("a step that fed nothing toward the deliverable earns nothing", () => {
    const e: Edge[] = [
      { inputShapes: [], inputImpulseIds: [], outputShapes: ["activity_template"], outputImpulseIds: ["t"] },
      ...N2,
    ];
    expect(involvedSteps!(e, new Set(["llm_completion"]))).toEqual([1, 2]);
  });
  test("no recorded producer of a deliverable: the last step stands in (as before) with the steps that fed it", () => {
    expect(involvedSteps!(N2, new Set(["something_else"]))).toEqual([0, 1, 2]);
    expect(involvedSteps!([N2[0]!], new Set(["something_else"]))).toEqual([0]);
  });
});

describe("qa9", () => {
  test("must-fail: a bookkeeping-only step is neither a deliverable producer nor the stand-in, and earns nothing", () => {
    const e: Edge[] = [...N2, { inputShapes: [], inputImpulseIds: [], outputShapes: ["llm_completion"], outputImpulseIds: [] }];
    const stub = (i: number) => i === 3;
    expect(involvedSteps!(e, new Set(["llm_completion"]), () => false, stub)).toEqual([0, 1]);
    expect(involvedSteps!(e, new Set(["nothing"]), () => false, stub)).toEqual([0, 1, 2]); // stand-in skips the stub
  });
});

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
describe("wiring (source)", () => {
  test("must-fail (qa9): a step already α-credited in this dispatch is not credited again (carried steps re-enter the chain)", () => {
    expect(src).toContain("const _alreadyCredited = new Set((opts.learningSink?.alphaBetaDelta ?? []).filter((d) => d.dAlpha > 0).map((d) => d.templateId));");
    expect(src).toContain("if (_alreadyCredited.has(id))");
  });
  test("bookkeeping-only steps are excluded with the existing isBookkeepingOnly", () => {
    expect(src).toMatch(/const stepIsStub = [\s\S]{0,400}isBookkeepingOnly\(imp\.content\)/);
    expect(src).toContain("const _isStub = stepIsStub;");
    expect(src).toContain("involvedSteps(_edges, new Set(verdict.completion_shapes ?? []), _uncreditable, _isStub)");
  });
  test("verifiedWrites is keyed by satisfier step, not shape", () => {
    for (const m of src.matchAll(/verifiedWrites\.add\(([^)]*)\)/g)) expect(m[1]).toBe("`satisfier:${shape}`");
  });
  test("the existing credit seam credits every involved step, gated on read-back for writes", () => {
    expect(src).toContain("involvedSteps(_edges, new Set(verdict.completion_shapes ?? []), _uncreditable, _isStub)");
    expect(src).toContain("outs.every((s) => isWriteShape(s)) && !verifiedWrites.has(chain[i] ?? ");
    expect(src).not.toContain("creditReachedTemplate(lastPick, verdict.reason");
  });
  test("only an independently-read write enters verifiedWrites", () => {
    // every add sits in a branch that READ the effect back: persisted===true, or a non-null re-read.
    // The read-back decision lives in applied-write.ts settleVerifiedWrite, whose persisted kinds
    // are returned only under v.persisted === true (test/applied-write.test.ts controls).
    for (const m of src.matchAll(/verifiedWrites\.add\(/g)) {
      const ctx = src.slice(Math.max(0, m.index! - 260), m.index!);
      expect(/_settle\.kind === "(terminal_)?persisted"|reread != null/.test(ctx)).toBe(true);
    }
    const i = src.indexOf('claimed success but effect NOT independently readable');
    const from = src.lastIndexOf('_settle.kind === "not_persisted"', i);
    expect(from).toBeGreaterThan(0);
    const branch = src.slice(from, i);
    expect(branch).not.toContain("verifiedWrites.add(");
  });
});
