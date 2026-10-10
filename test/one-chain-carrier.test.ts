// ONE CHAIN-CREDIT CARRIER PER FAILED WALK, AND NO SECOND β FOR THE SAME ANCESTOR IN A DISPATCH (OP-1 b).
//
// Measured (diag-1f, 24h): activity-api propagates a graded trace's outcome to each execution in its
// composition_chain at λ^depth (λ = 0.6). A not-reached satisfier-last walk handed it two graded carriers of the
// same chain — the durable last-step trace (chain = the steps before it, graded at insert by reached:false) and
// the failed composite (chain = every step) — so an ancestor took λ + λ²: db_admin β moved in steps of
// 0.96 = 0.6 + 0.36. A retry in the same dispatch carries the prior attempt's steps into its chain, so its
// carrier charged them again.
//
// THE RULE PINNED HERE (walk-pool.ts chainCarrierChains, wired in index.ts):
//   - the graded durable trace is the carrier; the failed composite then carries no chain;
//   - when β was withheld from the durable trace (its last step did not produce the judged artifact, OP-1 a),
//     the failed composite is the carrier;
//   - ancestors this dispatch already charged are not carried again; a replay of the same walk posts the same
//     ids (the store keeps one row per execution id), so it adds nothing.
//
// The posterior side is modelled as activity-api's propagateCreditAlongChain does it: a GRADED not-reached trace
// (reached:false tag, no beta_withheld) gives each ancestor λ^depth (depth 1 = the closest), and a trace that
// declares consumed provenance charges only the producers it consumed.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const realFetch = globalThis.fetch;
let mod: Record<string, any>;
let wp: Record<string, any>;
beforeAll(async () => {
  globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 404 }))) as unknown as typeof fetch;
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  mod = (await import("../src/index")) as Record<string, any>;
  wp = (await import("../src/walk-pool")) as Record<string, any>;
  globalThis.fetch = realFetch;
});

const LAMBDA = 0.6;
type Trace = { id: string; tags?: string[]; compositionChain?: string[]; tasks?: Array<{ consumedProvenance?: Array<{ producerExecutionId: string | null }> }> };
/** β each ancestor receives from the graded carriers, one row per execution id (the store's unique key). */
function ancestorBeta(posted: Trace[]): Map<string, number> {
  const rows = new Map<string, Trace>();
  for (const t of posted) if (!rows.has(t.id)) rows.set(t.id, t);
  const beta = new Map<string, number>();
  for (const t of rows.values()) {
    const tags = t.tags ?? [];
    const graded = tags.includes("reached:false") && !tags.includes("beta_withheld:true");
    if (!graded) continue;
    const declared = (t.tasks ?? []).some((k) => Array.isArray(k.consumedProvenance));
    const consumed = declared ? new Set((t.tasks ?? []).flatMap((k) => (k.consumedProvenance ?? []).map((p) => p.producerExecutionId).filter((x): x is string => !!x))) : null;
    [...(t.compositionChain ?? [])].reverse().forEach((id, i) => {
      if (consumed && !consumed.has(id)) return;
      beta.set(id, (beta.get(id) ?? 0) + Math.pow(LAMBDA, i + 1));
    });
  }
  return beta;
}

// A 2-step satellite walk: exec_A (satisfier:analysis) produced analysis; the last step (satisfier:report)
// consumed it and produced the report, which the judge rejected. The last step produced the judged artifact,
// so its durable trace is graded (β not withheld).
const CHAIN = ["satisfier:analysis", "satisfier:report"];
const LAST_ID = "walk-satisfier-2-1791378965133";
const EXEC_IDS = ["exec_A", LAST_ID];
const POOL = [
  { id: "walk-d1-analysis-1", metadata: { shape: "analysis", producerExecutionId: "exec_A" } },
  { id: "walk-d1-report-2", metadata: { shape: "report", producerExecutionId: LAST_ID } },
];
const EDGES = [
  { inputShapes: [], inputImpulseIds: [], outputShapes: ["analysis"], outputImpulseIds: ["walk-d1-analysis-1"] },
  { inputShapes: ["analysis"], inputImpulseIds: ["walk-d1-analysis-1"], outputShapes: ["report"], outputImpulseIds: ["walk-d1-report-2"] },
];
const FM = { type: "verifier_negative", reason: "judge: the report does not answer the question" };

/** The walk's two not-reached posts, with the carrier decision applied (or, absent it, the old both-carry shape). */
function walkPosts(o: { chainExecIds: string[]; chain: string[]; lastId: string; durableGraded: boolean; alreadyCharged: Set<string> }): Trace[] {
  const composite = mod.buildFailedCompositeTrace(o.chain, o.chainExecIds, ["analysis", "report"], 10, 0, [], POOL, "g", EDGES, FM) as Trace;
  const durableChain = o.chainExecIds.slice(0, -1);
  const carry = (wp.chainCarrierChains as undefined | ((i: unknown) => { durable: string[]; composite: string[]; charged: string[] }))
    ?? ((i: { chainExecIds: string[]; durableChain: string[] }) => ({ durable: [...i.durableChain], composite: [...i.chainExecIds], charged: [] }));
  const c = carry({ chainExecIds: o.chainExecIds, durableChain, durableGraded: o.durableGraded, compositeRecorded: true, alreadyCharged: o.alreadyCharged });
  for (const id of c.charged) o.alreadyCharged.add(id);
  composite.compositionChain = c.composite;
  const durable: Trace = {
    id: o.lastId,
    tags: o.durableGraded ? ["reached:false"] : ["beta_withheld:true", "beta_withheld_reason:not-producer-of-judged-artifact"],
    compositionChain: c.durable,
  };
  return [durable, composite];
}

describe("MUST-FAIL — one failed 2-step satellite walk charges its ancestor exactly once", () => {
  test("the ancestor's β is λ (0.6), not λ + λ² (0.96)", () => {
    const beta = ancestorBeta(walkPosts({ chainExecIds: EXEC_IDS, chain: CHAIN, lastId: LAST_ID, durableGraded: true, alreadyCharged: new Set() }));
    expect(beta.get("exec_A")).toBeCloseTo(LAMBDA, 10);
  });

  test("exactly one graded post carries a chain", () => {
    const posts = walkPosts({ chainExecIds: EXEC_IDS, chain: CHAIN, lastId: LAST_ID, durableGraded: true, alreadyCharged: new Set() });
    const graded = posts.filter((t) => (t.tags ?? []).includes("reached:false") && !(t.tags ?? []).includes("beta_withheld:true"));
    expect(graded.filter((t) => (t.compositionChain ?? []).length > 0).length).toBe(1);
  });

  test("a replay of the same walk (same execution ids) adds no second β", () => {
    const charged = new Set<string>();
    const first = walkPosts({ chainExecIds: EXEC_IDS, chain: CHAIN, lastId: LAST_ID, durableGraded: true, alreadyCharged: charged });
    const replay = walkPosts({ chainExecIds: EXEC_IDS, chain: CHAIN, lastId: LAST_ID, durableGraded: true, alreadyCharged: charged });
    expect(replay.map((t) => t.id)).toEqual(first.map((t) => t.id));
    expect(ancestorBeta([...first, ...replay]).get("exec_A")).toBeCloseTo(LAMBDA, 10);
  });

  test("a retry in the same dispatch that carries exec_A forward adds no second β to it", () => {
    const charged = new Set<string>();
    const first = walkPosts({ chainExecIds: EXEC_IDS, chain: CHAIN, lastId: LAST_ID, durableGraded: true, alreadyCharged: charged });
    // The retry continues from the carried step exec_A (ADDITIVE walk) and runs a fresh last step.
    const retry = walkPosts({ chainExecIds: ["exec_A", "walk-satisfier-3-1791378999999"], chain: CHAIN, lastId: "walk-satisfier-3-1791378999999", durableGraded: true, alreadyCharged: charged });
    expect(ancestorBeta([...first, ...retry]).get("exec_A")).toBeCloseTo(LAMBDA, 10);
  });
});

describe("the carrier follows culpability (OP-1 a)", () => {
  test("β withheld from the durable trace ⇒ the composite carries the chain, and charges the producer it consumed once", () => {
    const posts = walkPosts({ chainExecIds: EXEC_IDS, chain: CHAIN, lastId: LAST_ID, durableGraded: false, alreadyCharged: new Set() });
    const beta = ancestorBeta(posts);
    expect(beta.get("exec_A")).toBeCloseTo(LAMBDA * LAMBDA, 10); // depth 2 in the composite's chain
    expect(beta.get(LAST_ID) ?? 0).toBe(0); // the non-producing last step consumed nothing downstream: no β
  });

  test("chainCarrierChains: carrier choice and dispatch dedupe", () => {
    const c = wp.chainCarrierChains;
    expect(c({ chainExecIds: ["a", "b"], durableChain: ["a"], durableGraded: true, compositeRecorded: true, alreadyCharged: new Set() }))
      .toEqual({ carrier: "durable", durable: ["a"], composite: [], charged: ["a"] });
    expect(c({ chainExecIds: ["a", "b"], durableChain: ["a"], durableGraded: false, compositeRecorded: true, alreadyCharged: new Set(["a"]) }))
      .toEqual({ carrier: "composite", durable: ["a"], composite: ["b"], charged: ["b"] });
    expect(c({ chainExecIds: ["a", "b"], durableChain: ["a"], durableGraded: false, compositeRecorded: false, alreadyCharged: new Set() }))
      .toEqual({ carrier: "none", durable: ["a"], composite: [], charged: [] });
  });
});

describe("wiring (source): both posts take their chain from the one carrier decision", () => {
  const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
  test("the decision is made once in the not-reached branch, keyed by the dispatch", () => {
    expect(SRC).toContain("if (_lastIsSatisfier) walkChainCarrier = chargeChainCarrier(opts.variables.dispatch_id, chainExecIds, lastTrace.compositionChain ?? [], !walkBetaWithheld, !_noOracle && !_betaWithheldForSymmetry && chain.length >= 2);");
  });
  test("the failed composite records the carrier's composite chain", () => {
    const at = SRC.indexOf("const _failedComposite = buildFailedCompositeTrace(");
    expect(SRC.slice(at, at + 600)).toContain("_failedComposite.compositionChain = walkChainCarrier?.composite ?? [];");
  });
  test("the durable persist records the carrier's durable chain", () => {
    const i = SRC.indexOf("if (satisfierOnlyTrace) {");
    const block = SRC.slice(i, SRC.indexOf("persistSatisfierTrace(durableTrace);", i));
    expect(block).toContain("...(walkChainCarrier ? { compositionChain: walkChainCarrier.durable } : {}),");
  });
});
