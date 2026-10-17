// B2 + A2: the walk builds a producer for a novel target from existing resolvers (composite-authoring.ts), and describes
// what it produced. Must-fail at the parent (bac8742): the module does not exist and the walk has no compose step.
import { describe, expect, test } from "bun:test";
import { ComposedLedger, authorComposite, compositesToRetire, composeTrigger, describeMintedShape, retireComposite } from "../src/composite-authoring";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;

type Call = { url: string; body: any };
function fakeFetch(reply: (c: Call) => { status: number; json: unknown } | Error) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const c = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const r = reply(c);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const at = (url: string | null) => async (_s: string) => url;

describe("when the walk composes", () => {
  const base = { tried: false, goal: "g", hasPick: false, missing: [] as string[], targetSize: 0, novel: false, steps: 0 };
  test("a missing target with no pick composes", () => {
    expect(composeTrigger({ ...base, missing: ["opaqueShapeQ"], targetSize: 1 })).toBe("missing_target");
  });
  test("a NOVEL answer with no target and no step composes, even when the walk found an opportunistic pick", () => {
    expect(composeTrigger({ ...base, novel: true })).toBe("novel_target");
    expect(composeTrigger({ ...base, novel: true, hasPick: true })).toBe("novel_target");
  });
  test("once per walk", () => {
    expect(composeTrigger({ ...base, tried: true, missing: ["opaqueShapeQ"] })).toBeNull();
  });
  test("must-fail controls: a walk with a producer, a NOVEL walk already stepping, or a met target does not compose", () => {
    expect(composeTrigger({ ...base, hasPick: true, missing: ["opaqueShapeQ"], targetSize: 1 })).toBeNull();
    expect(composeTrigger({ ...base, novel: true, steps: 1 })).toBeNull();
    expect(composeTrigger({ ...base, novel: true, targetSize: 1 })).toBeNull();
    expect(composeTrigger({ ...base })).toBeNull();
  });
});

describe("authoring through discovery", () => {
  test("asks whichever vessel discovery places author_composed_capability on, and returns the validated composite", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, json: { shape: "author_composed_capability", body: { minted_activity_id: "composed-cap-x", validated: true, output_shapes: ["opaqueShapeQ"] } } }));
    const r = await authorComposite("goal text", ["opaqueShapeQ"], ["pooled"], "disp-1", { resolveUrl: at("http://v9/v2/impulses/resolve"), fetchImpl: f, timeoutMs: 1000 });
    expect(r).toEqual({ ok: true, pick: { id: "composed-cap-x", outputShapes: ["opaqueShapeQ"], reusedExisting: false } });
    expect(calls[0]!.url).toBe("http://v9/v2/impulses/resolve");
    expect(calls[0]!.body.impulse.pointer).toMatchObject({ type: "author_composed_capability", goal: "goal text", target_shapes: ["opaqueShapeQ"], available_shapes: ["pooled"], execution_id: "disp-1" });
  });
  test("reuse before mint: an existing composite comes back as the pick", async () => {
    const { f } = fakeFetch(() => ({ status: 200, json: { body: { minted_activity_id: "composed-cap-old", validated: true, reused_existing: true, output_shapes: ["opaqueShapeQ"] } } }));
    const r = await authorComposite("g", ["opaqueShapeQ"], [], undefined, { resolveUrl: at("http://v"), fetchImpl: f, timeoutMs: 1000 });
    expect(r.ok && r.pick.reusedExisting).toBe(true);
  });
  test("a NOVEL goal passes no target and takes the composite's own deliverable", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, json: { body: { minted_activity_id: "c", validated: true, output_shapes: ["composedDeliverable_x"] } } }));
    const r = await authorComposite("g", [], [], undefined, { resolveUrl: at("http://v"), fetchImpl: f, timeoutMs: 1000 });
    expect(calls[0]!.body.impulse.pointer.target_shapes).toEqual([]);
    expect(r.ok && r.pick.outputShapes).toEqual(["composedDeliverable_x"]);
  });
  test("every refusal falls through with its reason (never a pick)", async () => {
    const cases: Array<[Parameters<typeof fakeFetch>[0], RegExp]> = [
      [() => ({ status: 200, json: { shape: "structuredError", body: { error: "could not plan a valid chain" } } }), /refused: could not plan/],
      [() => ({ status: 200, json: { body: { minted_activity_id: "c", validated: false } } }), /no validated composite/],
      [() => ({ status: 503, json: {} }), /HTTP 503/],
      [() => new Error("connect ECONNREFUSED"), /unreachable: connect ECONNREFUSED/],
    ];
    for (const [reply, why] of cases) {
      const { f } = fakeFetch(reply);
      const r = await authorComposite("g", ["s"], [], undefined, { resolveUrl: at("http://v"), fetchImpl: f, timeoutMs: 1000 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(why);
    }
    const none = await authorComposite("g", ["s"], [], undefined, { resolveUrl: at(null), fetchImpl: fakeFetch(() => ({ status: 200, json: {} })).f, timeoutMs: 1000 });
    expect(none).toEqual({ ok: false, reason: "no vessel serves author_composed_capability" });
  });
});

describe("A2: the minted shape's meaning reaches discovery", () => {
  test("writes the chooser's residual, claimed by the composite", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 201, json: { success: true } }));
    const r = await describeMintedShape("http://disc/", "composedDeliverable_x", " the weekly digest of stalled landings ", "composed-cap-x", { fetchImpl: f, timeoutMs: 1000 });
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe("http://disc/registry/shape-descriptions");
    expect(calls[0]!.body).toEqual({ shape: "composedDeliverable_x", description: "the weekly digest of stalled landings", source: "walk_composite", produced_by: "composed-cap-x" });
  });
  test("a refusal (e.g. not the system identity) is reported, not thrown", async () => {
    const { f } = fakeFetch(() => ({ status: 403, json: { reason: "caller_not_system_org" } }));
    expect(await describeMintedShape("http://disc", "s", "r", "c", { fetchImpl: f, timeoutMs: 1000 })).toEqual({ ok: false, status: 403, reason: "caller_not_system_org" });
  });
  test("must-fail control: no residual, nothing written", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 201, json: {} }));
    expect((await describeMintedShape("http://disc", "s", "  ", "c", { fetchImpl: f, timeoutMs: 1000 })).ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});

describe("walk wiring (source pins; the walk is a closure that cannot run without the fleet)", () => {
  test("the compose step runs before the escalate branch files a capability gap", () => {
    const c = src.indexOf("(c.3) COMPOSE FROM EXISTING RESOLVERS");
    const esc = src.indexOf("// LEAF→AUTHORING ESCALATION", c);
    const gap = src.indexOf("filedGap = await fileCapabilityGap(codeGap, goal, missingNow)", c);
    expect(c).toBeGreaterThan(0);
    expect(esc).toBeGreaterThan(c);
    expect(gap).toBeGreaterThan(esc);
    const block = src.slice(c, esc);
    expect(block).toContain("composeTrigger({ tried: walkComposeTried");
    expect(block).toContain("walkComposeTried = true;");
    expect(block).toContain("authorComposite(goal, _missingC, [...producedShapes], dispatchContext.getStore()?.dispatchId, { resolveUrl: ufResolveUrl");
    expect(block).toContain('pickSource = "improvise";');
  });
  test("A2 fires only where REAL content of the composite's shape is pooled, never from the stub fallback", () => {
    const a2 = src.indexOf("void describeMintedShape(DISCOVERY_ENDPOINT");
    const stub = src.indexOf("// Fallback: declared output shapes whose content we could not recover");
    const real = src.lastIndexOf("addToPool(shape, imp.content, `produced by ${pick.id}`", a2);
    expect(a2).toBeGreaterThan(0);
    expect(real).toBeGreaterThan(0);
    expect(a2).toBeLessThan(stub);
    expect(src.slice(real, a2)).toContain("walkComposed.residual && walkComposed.outputShapes.includes(shape)");
  });
});

describe("earned by doing: a minted composite whose first run does not reach is not left selectable", () => {
  const minted = { id: "composed-cap-new", outputShapes: ["s"], reusedExisting: false };
  const reused = { id: "composed-cap-old", outputShapes: ["s"], reusedExisting: true };
  test("a definite miss retires the NEW mint, never a reused composite (it has its own history)", () => {
    expect(compositesToRetire([minted, reused, minted], false)).toEqual(["composed-cap-new"]);
  });
  test("must-fail controls: a reached first run keeps it (earned); an unknown verdict retires nothing", () => {
    expect(compositesToRetire([minted], true)).toEqual([]);
    expect(compositesToRetire([minted], null)).toEqual([]);
    expect(compositesToRetire([minted], undefined)).toEqual([]);
  });
  test("the ledger hands each dispatch's composites back once, and is bounded", () => {
    const l = new ComposedLedger(2);
    l.note("d1", minted); l.note("d1", reused); l.note("", minted);
    expect(l.take("d1")).toEqual([minted, reused]);
    expect(l.take("d1")).toEqual([]);
    l.note("a", minted); l.note("b", minted); l.note("c", minted);
    expect(l.take("a")).toEqual([]);
    expect(l.take("c")).toEqual([minted]);
  });
  test("retiring goes through discovery to activityTemplate_deprecate (the flag selection filters on)", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, json: { success: true } }));
    const r = await retireComposite("composed-cap-new", "first run did not reach", { resolveUrl: async (s) => (s === "activityTemplate_deprecate" ? "http://aa/v2/impulses/resolve" : null), fetchImpl: f, timeoutMs: 1000 });
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe("http://aa/v2/impulses/resolve");
    expect(calls[0]!.body).toEqual({ pointer: { type: "activityTemplate_deprecate", templateId: "composed-cap-new", reason: "first run did not reach" } });
  });
  test("a refused retirement is reported with its reason (e.g. the global-scope evidence gate)", async () => {
    const { f } = fakeFetch(() => ({ status: 422, json: { error: "insufficient_evidence: non-admin callers must supply Thompson evidence" } }));
    const r = await retireComposite("c", "r", { resolveUrl: async () => "http://aa", fetchImpl: f, timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
    expect(r.reason).toMatch(/insufficient_evidence/);
  });
  test("wiring: the walk records each composite for its dispatch, and the verdict write retires on a miss AFTER reached is set", () => {
    expect(src).toContain("composedByDispatch.note(String(opts.variables?.dispatch_id ?? \"\"), _c.pick);");
    const set = src.indexOf("record.reached = seek.reached;");
    const ret = src.indexOf("compositesToRetire(composedByDispatch.take(");
    expect(set).toBeGreaterThan(0);
    expect(ret).toBeGreaterThan(set);
    expect(src.slice(ret, ret + 400)).toContain("record.reached)");
  });
});
