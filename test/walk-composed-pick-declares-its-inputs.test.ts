// A WALK-COMPOSED CAPABILITY IS PICKED WITH ITS DECLARED INPUTS, AND AN UNJUDGED COMPOSE LANDING DOES NOT MINT THROUGH
// THE IN-CHAIN EDGE (gaps a-walk-composed-capability-is-picked-with-no-declared-inputs-so-a-reached-composition-earns-no-
// alpha-and-reuse-recommends-the-floor-instead, an-unjudged-compose-landing-can-mint-a-template-through-the-in-chain-edge-
// arm-of-the-mint-gate). Graded together: declaring a composite's inputs opens the gates' in-chain-edge arm for walk-
// composed reaches, and the guard keeps a compose landing that no judge confirmed out of that arm.
//
// The walk function is not exported, so the walk's OWN code is run here: the pick-construction line, the consumption
// ledger (ledgerStep), the alpha-credit condition, the edit-effect set and the mint gate (isGroundedHonestReach) are cut
// from src/index.ts by their code anchors and evaluated (TypeScript stripped by Bun's transpiler), never re-implemented.
// The stored row's field is the consumer-side fact: activity-api's GET /v2/activities/templates/:id serves the activity
// row as stored (SELECT *), whose input_shapes is a declared field (sql/schemas/020-paradigm-core-tables.surql) that
// development-vessel writes as composedTemplateInputs(tasks) when it mints the composite.
import { describe, expect, test } from "bun:test";
import { authorComposite } from "../src/composite-authoring";
import { declaredBound } from "../src/walk-pool";

const SRC = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
const tx = new Bun.Transpiler({ loader: "ts", deadCodeElimination: false });
const js = (ts: string): string => tx.transformSync(ts);
const cut = (start: string, end: string): string => {
  const i = SRC.indexOf(start);
  expect(i).toBeGreaterThan(-1);
  const j = SRC.indexOf(end, i);
  expect(j).toBeGreaterThan(i);
  return SRC.slice(i, j + end.length);
};

// The walk's code, cut by anchor.
const PICK_LINE = (() => { const i = SRC.indexOf("          pick = { id: _c.pick.id, inputShapes: "); expect(i).toBeGreaterThan(-1); return SRC.slice(i, SRC.indexOf("\n", i)); })();
const LEDGER = cut("  const ledgerStep = (inputShapes: string[] | undefined, newOutputs: string[]): void => {", "\n  };\n");
const CREDIT_COND = "verdict.deterministic === true || (!editEffectReach && consumedInChain.size > 0)";
const EDIT_EFFECT = cut("        const UNRESOLVED_FS_EFFECT = new Set(", "|| [...producedShapes].some((s) => UNRESOLVED_FS_EFFECT.has(String(s)));");
const MINT_GATE = cut("function isGroundedHonestReach(", "\n  return false;\n}\n");

type Verdict = { reached: boolean; deterministic?: boolean; completion_shapes?: string[] };
/** One walk's chain through the walk's own ledger: each step is [declared inputs, new outputs]. */
function runChain(steps: Array<[string[] | undefined, string[]]>, verdict: Verdict, producedShapes: string[]) {
  const body = `${js(LEDGER)}
    for (const [i, o] of steps) ledgerStep(i, o);
    ${js(EDIT_EFFECT)}
    ${js(MINT_GATE)}
    return { consumed: [...consumedInChain], credited: (${CREDIT_COND}), editEffectReach,
      minted: isGroundedHonestReach(verdict, { consumedInChain: consumedInChain.size, editEffectReach }) };`;
  // eslint-disable-next-line no-new-func
  return new Function("steps", "verdict", "producedShapes", "chainProduced", "consumedInChain", body)(steps, verdict, new Set(producedShapes), new Set<string>(), new Set<string>()) as
    { consumed: string[]; credited: boolean; editEffectReach: boolean; minted: boolean };
}
/** The walk's composite pick, built by the walk's own line from authorComposite's answer. */
function walkPick(c: unknown): { id: string; inputShapes: string[]; outputShapes: string[] } {
  const body = `let pick; ${js(PICK_LINE)} return pick;`;
  return new Function("_c", body)(c);
}

// Synthetic shapes: P emits the scan, the composite C consumes it and emits its deliverable.
const API = "http://aa7";
const X = "spindleScanCluster";
const D = "spindleDigestReport";
const CID = "composed-cap-spindle-digest-4e";
function author(stored: Record<string, unknown> | null) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(String(url));
    if (String(url).startsWith(`${API}/v2/activities/templates/`)) return stored ? Response.json(stored) : new Response("{}", { status: 404 });
    return Response.json({ shape: "author_composed_capability", body: { minted_activity_id: CID, validated: true, output_shapes: [D], tasks: [{ id: "fmt", resolver: "llm_completion_dispatch", output_shapes: [D] }] } });
  }) as unknown as typeof fetch;
  return { calls, deps: { resolveUrl: async () => "http://v9/v2/impulses/resolve", fetchImpl: f, timeoutMs: 1000, templateEndpoint: API } };
}
const STORED = { id: CID, input_shapes: [X], output_shapes: [D], tasks: [{ id: "fmt", resolver: "llm_completion_dispatch", input_shapes: [X], output_shapes: [D] }] };
const reachedLLM: Verdict = { reached: true, deterministic: false, completion_shapes: [D] };

describe("[MUST-FAIL] a walk-composed capability carries its declared inputs, so the reached chain records the edge", () => {
  test("authorComposite returns the stored row's declared inputs on the pick (no new export needed)", async () => {
    const { deps } = author(STORED);
    const r = await authorComposite("Digest the spindle scan into a short report", [D], [X], "d-1", deps);
    expect(r.ok).toBe(true);
    expect(r.ok && r.pick.inputShapes).toEqual([X]);
  });
  test("either spelling of the stored row's inputs is read", async () => {
    const { deps } = author({ id: CID, inputShapes: [X, X], tasks: [] });
    const r = await authorComposite("g", [D], [X], undefined, deps);
    expect(r.ok && r.pick.inputShapes).toEqual([X]);
  });
  test("P(emits X) then walk-composed C(consumes X), reached: X is in consumedInChain, the credit gate admits, the step binds X", async () => {
    const { deps } = author(STORED);
    const r = await authorComposite("g", [D], [X], undefined, deps);
    const pick = walkPick(r);
    expect(pick.inputShapes).toEqual([X]);
    expect(declaredBound(pick.inputShapes, [X])).toEqual([X]);
    const out = runChain([[undefined, [X]], [pick.inputShapes, [D]]], reachedLLM, [X, D]);
    expect(out.consumed).toContain(X);
    expect(out.credited).toBe(true);
  });
});

describe("[MUST-FAIL] the guard: an unjudged compose landing does not mint (or credit) through the in-chain edge", () => {
  test("the row's falsifier: reached, not deterministic, featureComposeReport, consumedInChain 1 -> no mint", () => {
    const out = runChain([[undefined, ["gapSpec"]], [["gapSpec"], ["featureComposeReport"]]], { reached: true, deterministic: false, completion_shapes: ["featureComposeReport"] }, ["gapSpec", "featureComposeReport"]);
    expect(out.consumed).toEqual(["gapSpec"]);
    expect(out.editEffectReach).toBe(true);
    expect(out.minted).toBe(false);
    expect(out.credited).toBe(false);
  });
});

describe("CONTROLS", () => {
  test("a judged compose landing (deterministic) still mints and credits", () => {
    const out = runChain([[undefined, ["gapSpec"]], [["gapSpec"], ["featureComposeReport"]]], { reached: true, deterministic: true, completion_shapes: ["featureComposeReport"] }, ["gapSpec", "featureComposeReport"]);
    expect(out.minted).toBe(true);
    expect(out.credited).toBe(true);
  });
  test("a non-edit read chain with an in-chain edge still mints and credits", () => {
    const out = runChain([[undefined, [X]], [[X], [D]]], reachedLLM, [X, D]);
    expect(out.minted).toBe(true);
    expect(out.credited).toBe(true);
  });
  test("a composite consuming nothing an earlier step produced still withholds (no edge, no mint)", async () => {
    const { deps } = author({ ...STORED, input_shapes: ["unrelatedShapeZ"] });
    const pick = walkPick(await authorComposite("g", [D], [X], undefined, deps));
    const out = runChain([[undefined, [X]], [pick.inputShapes, [D]]], reachedLLM, [X, D]);
    expect(out.consumed).toEqual([]);
    expect(out.credited).toBe(false);
    expect(out.minted).toBe(false);
    // the walk's withhold branch is the one taken on an empty ledger
    expect(SRC).toContain("} else if (consumedInChain.size === 0) { tap(\"[goal-host-vessel] walk: WITHHELD alpha-credit for \" + lastPick + \" — no in-chain producer-to-consumer edge and no landed sha\");");
  });
  test("an unreadable stored row, or one declaring no inputs, gives [] (fail-closed: no edge)", async () => {
    for (const stored of [null, { id: CID, tasks: [] }]) {
      const { deps } = author(stored);
      const r = await authorComposite("g", [D], [X], undefined, deps);
      expect(r.ok && r.pick.inputShapes).toEqual([]);
    }
  });
  test("a write-door-refused composite is never picked: the refusal branch precedes the pick and excludes it", () => {
    const refused = SRC.indexOf("REFUSED at the write door (outputs=[${_c.pick.outputShapes.join(\",\")}]) — not executing it");
    const picked = SRC.indexOf(PICK_LINE);
    expect(refused).toBeGreaterThan(0);
    expect(picked).toBeGreaterThan(refused);
    expect(SRC.slice(refused, picked)).toContain("} else if (_c.ok) {");
  });
  test("the floor's satisfier ledger calls are unchanged (declared-input rule untouched)", () => {
    expect(SRC).toContain("ledgerStep(_consumedInputs.length > 0 ? _consumedInputs : undefined, [satisfiableNow]);");
    expect(SRC).toContain("if (trace.status !== \"failed\") ledgerStep(pick.inputShapes, _stepNew);");
  });
});
