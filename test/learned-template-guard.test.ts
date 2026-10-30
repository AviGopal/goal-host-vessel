// NO PICK PATH SELECTS A LEARNED TEMPLATE THAT STILL CARRIES ITS SOURCE RUN.
//
// Gap minted-templates-replay-instance-values-because-reach-to-mint-bakes-the-original-goals-record-ids-and-nouns-into-
// their-tasks. Measured: a new remember goal ran the R2-minted learned-composition-memorynote-write as a sibling of the
// HORIZONTAL bundle, a path the lint (template-instance-lint.ts) had no caller on. The shared candidate list (after the
// template_pick write door; every single-pick tier and the bundle choose from it) and the bundle's forward fetch now
// drop a learned-* candidate the lint flags (learned-template-guard.ts).
//
//   [MUST-FAIL] a lint-flagged learned-* template is dropped from the single-pick candidates AND the horizontal bundle
//               (the guard, and its wiring right after both template_pick write-door filters, before the bundle forms)
//   [CONTROL]   a clean learned template is kept and still runs; a non-learned template is never fetched or touched
//   [MUST-FAIL] an unreadable learned template is DROPPED (fail closed, qa) and logged "DROPPED unchecked: template
//               unreadable" (new behaviour, so red at BASE); verdicts are cached and bounded
//
// Fixture words from a 5-word draw (draw-words.sh): 2026-10-30T07:00:30Z seed=1793343630165032589
// words=depress compactor silicon yard rebound
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const G = (await import("../src/learned-template-guard").catch(() => ({}))) as Record<string, any>;
const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

const FLAGGED = { tasks: [{ id: "s1", resolver: "memoryNote_write", outputShapes: ["memoryNote_write"], config: { type: "memoryNote_write", title: "Silicon yard", body: "remember the compactor rebound", dispatch_id: "2a3b4c5d-0000-4000-8000-0000000000ff" } }] };
const CLEAN = { tasks: [{ id: "s1", resolver: "memoryNote_write", outputShapes: ["memoryNote_write"], config: { type: "memoryNote_write", title: "{{impulse:note_title}}", body: "{{goal}}" } }] };
const cands = [
  { id: "activity:⟨learned-composition-memorynote-write⟩", outputShapes: ["memoryNote_write"] },
  { id: "learned-composition-clean-yard", outputShapes: ["memoryNote_write"] },
  { id: "satisfier:memoryNote_write", outputShapes: ["memoryNote_write"] },
  { id: "composed-depress", outputShapes: ["memoryNote_write"] },
  { id: "learned-unreadable-rebound", outputShapes: ["memoryNote_write"] },
];
const store: Record<string, unknown> = { "learned-composition-memorynote-write": FLAGGED, "learned-composition-clean-yard": CLEAN };

describe("the learned-template guard", () => {
  it("[MUST-FAIL] a lint-flagged learned template is dropped; the wiring guards the single pick and the bundle", async () => {
    const drop = G["dropInstanceValueTemplates"];
    const cache = G["LintVerdictCache"] ? new G["LintVerdictCache"]() : null;
    const r = drop ? await drop(cands, async (id: string) => store[id] ?? null, cache, 1_000) : { kept: cands, dropped: [], unchecked: [] };
    expect(r.kept.map((c: { id: string }) => c.id)).not.toContain("activity:⟨learned-composition-memorynote-write⟩");
    expect(r.dropped.map((d: { id: string }) => d.id)).toEqual(["learned-composition-memorynote-write"]);
    // both template_pick door sites are followed by the guard, and the bundle forms from the guarded lists
    const single = SRC.indexOf('candidates = writeDoorFilter(candidates, (c) => c.outputShapes, changeAdmitted, "template_pick"');
    const singleGuard = SRC.indexOf('{ const _g = await dropInstanceValueTemplates(candidates, (id) => getTemplateLocalFirst(id), lintVerdicts); candidates = _g.kept; lintGuardTap(tap, "template_pick", _g); }');
    const fwd = SRC.indexOf('forward = writeDoorFilter(forward, (c) => c.outputShapes, changeAdmitted, "template_pick"');
    const fwdGuard = SRC.indexOf('{ const _g = await dropInstanceValueTemplates(forward, (id) => getTemplateLocalFirst(id), lintVerdicts); forward = _g.kept; lintGuardTap(tap, "horizontal_bundle", _g); }');
    const bundle = SRC.indexOf("const bundle = orEdge.slice(0, K);");
    expect(singleGuard).toBeGreaterThan(single);
    expect(fwdGuard).toBeGreaterThan(fwd);
    expect(bundle).toBeGreaterThan(fwdGuard);
    expect(SRC.indexOf("orEdge = [...candidates, ...forward].filter(")).toBeGreaterThan(fwdGuard);
  });
  it("[CONTROL] a clean learned template is kept; a non-learned template is never fetched", async () => {
    const drop = G["dropInstanceValueTemplates"] ?? (async (c: unknown[]) => ({ kept: c, dropped: [], unchecked: [] }));
    const cache = G["LintVerdictCache"] ? new G["LintVerdictCache"]() : null;
    const fetched: string[] = [];
    const r = await drop(cands, async (id: string) => { fetched.push(id); return store[id] ?? null; }, cache, 1_000);
    const kept = r.kept.map((c: { id: string }) => c.id);
    expect(kept).toEqual(expect.arrayContaining(["learned-composition-clean-yard", "satisfier:memoryNote_write", "composed-depress"]));
    expect(fetched.some((f) => f.startsWith("satisfier") || f.startsWith("composed"))).toBe(false);
  });
  it("[MUST-FAIL] an unreadable learned template is dropped (fail closed) and logged; verdicts are cached and bounded", async () => {
    const drop = G["dropInstanceValueTemplates"] ?? (async (c: unknown[]) => ({ kept: c, dropped: [], unchecked: [] }));
    const cache = G["LintVerdictCache"] ? new G["LintVerdictCache"](60_000, 2) : null;
    const r = await drop(cands, async (id: string) => store[id] ?? null, cache, 1_000);
    expect(r.kept.map((c: { id: string }) => c.id)).not.toContain("learned-unreadable-rebound");
    expect(r.unchecked).toEqual(["learned-unreadable-rebound"]);
    expect(SRC.includes("DROPPED unchecked: template unreadable")).toBe(true);
    if (cache) {
      let calls = 0;
      await drop([cands[1]!], async (id: string) => { calls++; return store[id] ?? null; }, cache, 2_000);
      expect(calls).toBe(0); // cached inside the TTL
      await drop([cands[1]!], async (id: string) => { calls++; return store[id] ?? null; }, cache, 100_000);
      expect(calls).toBe(1); // re-checked after it
    }
  });
});
