/**
 * A synthesized write pointer is held to the closed vocabulary its shape advertises
 * (src/closed-vocabulary.ts, wired into rawResolve in src/index.ts).
 *
 * The contracts below are invented fixtures (region "alpha", blocks "b1"/"b2", zone,
 * mode): nothing here names a real shape's vocabulary, because the module derives
 * everything from what a shape advertises.
 *
 * Fixture goals come from 5-word draws (~/.claude/research-watch/draw-words.sh):
 *   D1 seed=1793049965015620534 words=sector rust drum murmuring spill
 *   D2 seed=1793049965026892256 words=venomous rebalance shabby familiar spoiled
 *   D3 seed=1793049965036647508 words=exponent modulator neglector flatfoot refocus
 *   D4 seed=1793049965047064241 words=suspense imprecise epidermis rented strike
 *   D5 seed=1793049965056089186 words=babied debtless everglade reuse varied
 *
 * Each test imports the module dynamically, so at a tree without it every test fails by
 * name instead of the file failing to load.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mod = () => import("../src/closed-vocabulary");

const G1 = "Arrange the rust sector panel so the murmuring drum spill shows first";
const G2 = "Rebalance the shabby familiar view without spoiling anything venomous";
const G3 = "Refocus the modulator view on the exponent and skip the flatfoot neglector";
const G4 = "Strike the imprecise epidermis block from the rented suspense view";
const G5 = "Reuse the varied everglade layout for the debtless babied panel";

/** An invented contract in the scoped form: one region, its blocks, a default. */
const PANEL_DESC =
  "writes the view of a panel region (alpha): which blocks the region draws and in what order. " +
  "region alpha: blocks b1, b2; b1 lists 1 to 9 items; default b1. undo restores the view in force before the current one";

describe("closed vocabulary: a write pointer carries only advertised values", () => {
  test(`MF: a one-value region gets that value (${G1})`, async () => {
    const { holdWriteToAdvertised } = await mod();
    const pointer = { type: "panelView_write", region: "the rust sector panel", blocks: ["b2", "b1"], content: G1 };
    const r = holdWriteToAdvertised(pointer, { description: PANEL_DESC });
    expect(r.refused).toBeNull();
    expect(r.pointer.region).toBe("alpha");
    expect(r.pointer.blocks).toEqual(["b2", "b1"]); // order kept, both allowed
    expect(r.pointer.type).toBe("panelView_write"); // the shape key is never a field of the write
    expect(r.pointer.content).toBe(G1);
  });

  test(`MF: a one-value "one of" enum gets that value, and a list draws only from its set (${G1})`, async () => {
    const { holdWriteToAdvertised } = await mod();
    const desc = "Writes a drum pattern. mode is one of solo. region alpha: blocks b1, b2.";
    const r = holdWriteToAdvertised({ mode: "murmuring", region: "alpha", blocks: ["b1", "spill", "b1", "B2"] }, { description: desc });
    expect(r.refused).toBeNull();
    expect(r.pointer.mode).toBe("solo");
    expect(r.pointer.blocks).toEqual(["b1", "b2"]);
  });

  test(`MF2: a 422 naming the allowed values gets exactly one repaired resend (${G2})`, async () => {
    const { repairAndResendOnce } = await mod();
    const sent: Array<Record<string, unknown>> = [];
    const refusal = JSON.stringify({ resolved: false, success: false, refusal: "unknown_zone", error: "unknown_zone: zones: alpha" });
    const send = async (p: Record<string, unknown>) => { sent.push(p); return { status: 422, ok: false, text: async () => refusal }; };
    const pointer = { type: "zoneView_write", zone: "the shabby familiar view", note: G2 };
    const first = await repairAndResendOnce(pointer, 422, refusal, {}, send);
    expect(sent.length).toBe(1);
    expect(sent[0]!.zone).toBe("alpha");
    expect(sent[0]!.note).toBe(G2);
    expect(first.resent?.status).toBe(422);
    // The resend was refused again: a second pass over the same pointer teaches nothing new, so nothing is sent.
    const again = await repairAndResendOnce(first.resent!.pointer, 422, first.resent!.bodyText, { learned: first.learned }, send);
    expect(again.resent).toBeNull();
    expect(sent.length).toBe(1);
  });

  test(`MF2: a refused list item is filtered from the refusal's own list (${G2})`, async () => {
    const { repairAndResendOnce } = await mod();
    const sent: Array<Record<string, unknown>> = [];
    const send = async (p: Record<string, unknown>) => { sent.push(p); return { status: 200, ok: true, text: async () => "{}" }; };
    const body = JSON.stringify({ refusal: "unknown_block", error: "unknown_block: venomous; blocks: b1, b2" });
    const r = await repairAndResendOnce({ region: "alpha", blocks: ["b2", "venomous"] }, 422, body, {}, send);
    expect(sent).toEqual([{ region: "alpha", blocks: ["b2"] }]);
    expect(r.resent?.ok).toBe(true);
  });

  test(`CONTROL: a free-text field is unchanged (${G3})`, async () => {
    const { holdWriteToAdvertised } = await mod();
    const pointer = { region: "alpha", blocks: ["b1"], note: G3, content: "the exponent, refocused" };
    const r = holdWriteToAdvertised(pointer, { description: PANEL_DESC });
    expect(r.refused).toBeNull();
    expect(r.changes).toEqual([]);
    expect(r.pointer).toEqual(pointer);
  });

  test(`CONTROL: a shape advertising no vocabulary is unchanged, and a refusal naming none resends nothing (${G4})`, async () => {
    const { holdWriteToAdvertised, repairAndResendOnce } = await mod();
    const desc = "Writes a record of a suspense view. Pointer: record {title, body, region?}. Returns {id, action}.";
    const pointer = { type: "suspenseRecord_write", record: { title: G4, body: "imprecise", region: "rented" } };
    const r = holdWriteToAdvertised(pointer, { description: desc });
    expect(r.refused).toBeNull();
    expect(r.changes).toEqual([]);
    expect(r.pointer).toEqual(pointer);
    let calls = 0;
    const out = await repairAndResendOnce(pointer, 422, JSON.stringify({ error: "strike refused: the view is rented" }), { description: desc }, async () => { calls++; return { status: 200, ok: true, text: async () => "{}" }; });
    expect(out.resent).toBeNull();
    expect(calls).toBe(0);
  });

  test(`CONTROL: an enum in prose with a default never refuses; the shape key and an unmatched value are left alone (${G4})`, async () => {
    const { holdWriteToAdvertised } = await mod();
    const desc = "Writes a note. Pointer: note {title, body, type?} (type is one of strike | rented, default rented).";
    const pointer = { type: "noteKind_write", note: { title: G4, type: "epidermis" } };
    const r = holdWriteToAdvertised(pointer, { description: desc });
    expect(r.refused).toBeNull();
    expect(r.pointer).toEqual(pointer);
  });

  test(`REFUSE: a required closed field that cannot be satisfied refuses, and no call is made (${G5})`, async () => {
    const { holdWriteToAdvertised, repairAndResendOnce } = await mod();
    const schemaFields = [{ name: "zone", required: true, enum: ["alpha", "beta"] }, { name: "note", required: false }];
    const absent = holdWriteToAdvertised({ note: G5 }, { schemaFields });
    expect(absent.refused).toContain("zone");
    const wrong = holdWriteToAdvertised({ zone: "everglade", note: G5 }, { schemaFields });
    expect(wrong.refused).toContain("zone");
    // A one-value required field is filled, not refused.
    const one = holdWriteToAdvertised({ note: G5 }, { schemaFields: [{ name: "zone", required: true, enum: ["alpha"] }] });
    expect(one.refused).toBeNull();
    expect(one.pointer.zone).toBe("alpha");
    // A refusal whose allowed list matches nothing in the pointer refuses the resend.
    let calls = 0;
    const body = JSON.stringify({ error: "unknown_block: varied; blocks: b1, b2" });
    const out = await repairAndResendOnce({ blocks: ["varied", "babied"] }, 422, body, {}, async () => { calls++; return { status: 200, ok: true, text: async () => "{}" }; });
    expect(calls).toBe(0);
    expect(out.note).toContain("not retrying");
  });

  test("VALID JSON ONLY: comments and trailing commas are removed; what is still invalid is refused with a reason", async () => {
    const { parseJsonObjectLenient } = await mod();
    const ok = parseJsonObjectLenient('Here: {"zone": "alpha", // the only zone\n "url": "http://x/y", /* note */ "blocks": ["b1",],} trailing {"x":1}');
    expect(ok).toEqual({ ok: true, value: { zone: "alpha", url: "http://x/y", blocks: ["b1"] } });
    const bad = parseJsonObjectLenient("{zone: alpha}");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("not valid JSON");
    expect(parseJsonObjectLenient("no object here").ok).toBe(false);
  });

  test("WIRING: rawResolve holds every write before sending and repairs a refused one once", async () => {
    await mod();
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    const at = src.indexOf("const rawResolve = async (");
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("let parsed: unknown;", at));
    const hold = body.indexOf("holdWriteToAdvertised(pointer");
    const send = body.indexOf("walkEgressFetch(shape");
    expect(hold).toBeGreaterThan(0);
    expect(hold).toBeLessThan(send);
    expect(body).toContain("if (_held.refused)");
    expect(body.split("repairAndResendOnce(").length - 1).toBe(1);
  });
});
