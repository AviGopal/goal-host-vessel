/**
 * A write whose owner serves no resolver_schema still reaches arg synthesis with its contract:
 * the shape's ADVERTISED description and the field contract read from it go into the prompt, so
 * a required list field is generated instead of omitted; and a 422 naming a MISSING field is
 * answered by ONE resend whose args were re-synthesized with the refusal in hand
 * (src/closed-vocabulary.ts; wired in src/index.ts llmExtractPointerArgs and rawResolve).
 *
 * Contracts are invented fixtures (region "alpha", blocks "b1"/"b2"/"b3"). The "model" is a stub
 * that emits exactly the fields the prompt's contract names, so these tests show what the prompt
 * makes available, not what any real model does with it.
 *
 * Fixture goals come from 5-word draws (~/.claude/research-watch/draw-words.sh):
 *   E1 seed=1793054604190336748 words=feminize lavish cattail coveting preacher
 *   E2 seed=1793054604206103537 words=sedative gumminess decal cardstock salon
 *   E3 seed=1793054604215622903 words=masses designate impromptu deputize swarm
 *   E4 seed=1793054604225923374 words=despise prototype poser resource unstuffed
 *
 * Each test imports the module dynamically, so at a tree without the new exports every test
 * fails by name instead of the file failing to load.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mod = () => import("../src/closed-vocabulary");

const E1 = "Hand the lavish cattail to the coveting preacher, feminized";
const E2 = "Press the salon decal onto cardstock without the sedative gumminess";
const E3 = "Designate an impromptu deputy for the swarming masses";
const E4 = "Unstuff the prototype resource the poser despises";

const DESC =
  "writes the arrangement of a tray (alpha): which blocks the tray holds and in what sequence. " +
  "region alpha: blocks b1, b2, b3; b1 lists 1 to 9 items; default b3. undo restores the previous arrangement";

/** A stub model: emits a scalar it is told is the only allowed value, and each LIST field with its allowed items. */
function stubModel(prompt: string, note: string): Record<string, unknown> {
  const out: Record<string, unknown> = { note };
  for (const m of prompt.matchAll(/- "(\w+)" is one of: [^\n]*?\(the only allowed value: emit "([^"]+)"\)/g)) out[m[1]!] = m[2]!;
  for (const m of prompt.matchAll(/- "(\w+)" is a LIST[^\n]*?each item is one of: ([^.\n]+)\./g)) out[m[1]!] = m[2]!.split(/\s*,\s*/);
  return out;
}

describe("advertised contract reaches arg synthesis when no schema is served", () => {
  test(`MF: a required list field the description names is generated (${E1})`, async () => {
    const { advertisedContractPrompt, holdWriteToAdvertised } = await mod();
    const block = advertisedContractPrompt("trayKit_write", DESC, false);
    expect(block).toContain(DESC);
    const args = stubModel(block, E1);
    const held = holdWriteToAdvertised({ type: "trayKit_write", ...args }, { description: DESC });
    expect(held.refused).toBeNull();
    expect(held.pointer.blocks).toEqual(["b1", "b2", "b3"]);
    expect(held.pointer.region).toBe("alpha");
    expect(held.pointer.note).toBe(E1);
  });

  test(`MF2: a 422 naming a missing field gets ONE resend whose re-synthesized pointer carries it (${E2})`, async () => {
    const { repairAndResendOnce } = await mod();
    const refusal = JSON.stringify({ resolved: false, success: false, refusal: "empty_blocks", error: "empty_blocks: blocks: b1, b2, b3" });
    const sent: Array<Record<string, unknown>> = [];
    const seen: string[] = [];
    const send = async (p: Record<string, unknown>) => { sent.push(p); return { status: 200, ok: true, text: async () => "{}" }; };
    // The re-synthesis sees the refusal; it proposes blocks (one not allowed) and a rival note.
    const resynth = async (r: string) => { seen.push(r); return r.includes("empty_blocks") ? { blocks: ["b2", "decal", "b1"], note: "a different note" } : null; };
    const out = await repairAndResendOnce({ type: "trayKit_write", region: "alpha", note: E2 }, 422, refusal, { description: DESC }, send, resynth);
    expect(seen).toEqual([refusal]);
    expect(sent.length).toBe(1);
    expect(sent[0]!.blocks).toEqual(["b2", "b1"]); // held to the allowed items after re-synthesis
    expect(sent[0]!.note).toBe(E2); // a key the pointer carried is never overwritten
    expect(sent[0]!.region).toBe("alpha");
    expect(out.note).toContain("re-synthesized");
  });

  test(`MF2: a re-synthesis that still omits the missing field resends nothing (${E2})`, async () => {
    const { repairAndResendOnce } = await mod();
    let calls = 0;
    const out = await repairAndResendOnce({ region: "alpha" }, 422, '{"error":"empty_blocks: blocks: b1, b2"}', {}, async () => { calls++; return { status: 200, ok: true, text: async () => "{}" }; }, async () => ({ region: "alpha" }));
    expect(calls).toBe(0);
    expect(out.note).toContain("not retrying");
  });

  test(`CONTROL: a shape that serves a resolver_schema gets no advertised block (prompt unchanged) (${E3})`, async () => {
    const { advertisedContractPrompt } = await mod();
    expect(advertisedContractPrompt("trayKit_write", DESC, true)).toBe("");
    expect(advertisedContractPrompt("trayKit_write", "", false)).toBe("");
    // Wiring: llmExtractPointerArgs adds it only when no schema contract was built, only for a write.
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    const fn = src.slice(src.indexOf("async function llmExtractPointerArgs("), src.indexOf("let howToGuidance = \"\";"));
    expect(fn).toMatch(/if \(!schemaContract && \/_write\$\/\.test\(shape\)\) schemaContract = advertisedContractPrompt\(shape, await advertisedDescription\(shape\), false\);/);
  });

  test(`CONTROL: a free-text field is unchanged, and a refusal naming allowed values still takes the vocabulary repair (${E4})`, async () => {
    const { repairAndResendOnce, holdWriteToAdvertised } = await mod();
    const p = { region: "alpha", blocks: ["b3"], note: E4 };
    expect(holdWriteToAdvertised(p, { description: DESC }).pointer).toEqual(p);
    let resynthCalls = 0;
    const sent: Array<Record<string, unknown>> = [];
    const out = await repairAndResendOnce({ region: "prototype", note: E4 }, 422, '{"error":"unknown_region: regions: alpha"}', {}, async (q) => { sent.push(q); return { status: 200, ok: true, text: async () => "{}" }; }, async () => { resynthCalls++; return null; });
    expect(resynthCalls).toBe(0);
    expect(sent).toEqual([{ region: "alpha", note: E4 }]);
    expect(out.note).toContain("allowed values");
  });

  test("the missing field is read from the refusal's own words", async () => {
    const { missingFieldFromRefusal } = await mod();
    expect(missingFieldFromRefusal("empty_blocks: blocks: b1")).toBe("blocks");
    expect(missingFieldFromRefusal('{"error":"title is required"}')).toBe("title");
    expect(missingFieldFromRefusal("missing required field: zone")).toBe("zone");
    expect(missingFieldFromRefusal("unknown_region: regions: alpha")).toBeNull();
  });

  test("WIRING: rawResolve's single resend re-synthesizes through llmExtractPointerArgs with the refusal", async () => {
    await mod();
    const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
    const at = src.indexOf("const rawResolve = async (");
    const body = src.slice(at, src.indexOf("let parsed: unknown;", at));
    expect(body.split("repairAndResendOnce(").length - 1).toBe(1);
    expect(body).toContain("(refusal) => llmExtractPointerArgs(shape, refusal))");
  });
});
