import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSelectionTuning,
  selectionTuningPath,
  isUsableEdgeBlendK,
  SELECTION_TUNING_DEFAULTS,
  _resetSelectionTuningCache,
} from "../src/selection-tuning";

/**
 * `EDGE_BLEND_K` was an exported in-process constant, which law 1 forbids for anything
 * behavioural: constants are "frozen at process start, invisible to traces and the walk,
 * and unlearnable". K decides how fast per-edge evidence overtakes a global posterior —
 * that is selection behaviour.
 *
 * Two properties have to hold together, and testing only one of them is how this kind of
 * change goes wrong:
 *   - UNCONFIGURED IS IDENTICAL TO BEFORE, so landing it while the substrate's store is
 *     down cannot change selection.
 *   - CONFIGURED ACTUALLY TAKES EFFECT, so this is a real read path and not a frozen value
 *     wearing a policy file's clothes.
 * A file that only proved the first would be indistinguishable from a no-op wrapper.
 */

afterEach(() => { _resetSelectionTuningCache(); });

async function withPolicy(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "seltune-"));
  await mkdir(join(root, "policies"), { recursive: true });
  await writeFile(join(root, "policies", "selection-tuning.json"), contents, "utf8");
  return root;
}

describe("selection tuning — the unconfigured path is the old behaviour", () => {
  it("returns the compiled-in default when no policy file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "seltune-empty-"));
    expect(await resolveSelectionTuning(root)).toEqual({ edgeBlendK: 10 });
  });

  it("the default is what edge-blend.ts previously hardcoded", () => {
    // If someone changes this literal they change live selection on every deployment that
    // has not authored a policy — which is the entire fleet today.
    expect(SELECTION_TUNING_DEFAULTS.edgeBlendK).toBe(10);
  });
});

describe("selection tuning — an authored value actually takes effect", () => {
  it("THE POINT OF THE CHANGE: a policy file overrides the constant", async () => {
    const root = await withPolicy(JSON.stringify({ edgeBlendK: 3 }));
    _resetSelectionTuningCache();
    expect((await resolveSelectionTuning(root)).edgeBlendK).toBe(3);
  });

  it("resolves the path from WORKSPACE_ROOT, not the literal /workspace", () => {
    // goal-host's unit carries WORKSPACE_ROOT=/workspace/git/super-repo. Seeding at the
    // literal produces an honest "not configured" that reads exactly like a broken reader.
    expect(selectionTuningPath("/a/b")).toBe("/a/b/policies/selection-tuning.json");
  });
});

describe("selection tuning — junk falls back rather than taking effect", () => {
  it("rejects values that would break or invert the blend", () => {
    for (const bad of [0, -1, NaN, Infinity, "10", null, undefined, {}]) {
      expect(isUsableEdgeBlendK(bad)).toBe(false);
    }
    for (const good of [1, 0.5, 10, 1000]) expect(isUsableEdgeBlendK(good)).toBe(true);
  });

  it("K<=0 never reaches the consumer", async () => {
    // samples/(samples+K) with K=0 is 1 for any sample count: ONE observation would
    // outweigh a mature posterior entirely. Worse than unconfigured.
    const root = await withPolicy(JSON.stringify({ edgeBlendK: 0 }));
    _resetSelectionTuningCache();
    expect((await resolveSelectionTuning(root)).edgeBlendK).toBe(10);
  });

  it("malformed JSON falls back instead of throwing", async () => {
    const root = await withPolicy("{not json");
    _resetSelectionTuningCache();
    // A tuning lookup must never be able to break a walk.
    expect((await resolveSelectionTuning(root)).edgeBlendK).toBe(10);
  });
});

describe("the call sites declare the resolved value BEFORE they use it", () => {
  it("THE REGRESSION tsc CANNOT SEE: no use of _blendK precedes its declaration", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const lines = src.split("\n");
    const declLine = lines.findIndex((l) => /const _blendK\s*=/.test(l));
    expect(declLine).toBeGreaterThan(-1);
    const uses = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l, i }) => i !== declLine && /_blendK/.test(l))
      .map(({ i }) => i);
    expect(uses.length).toBeGreaterThanOrEqual(5);

    // WHY THIS TEST EXISTS. The first version of this change declared _blendK inside the
    // walk loop but BELOW one of its uses. `tsc --noEmit` passed clean, because that use
    // sits inside an arrow-function callback and TypeScript assumes deferred evaluation.
    // At runtime it is a temporal-dead-zone ReferenceError on the satisfier path of every
    // walk. A green typecheck is not evidence of correct declaration order.
    for (const u of uses) expect(u).toBeGreaterThan(declLine);
  });

  it("NEGATIVE CONTROL: the ordering check can fail", () => {
    const lines = ["  use(_blendK)", "  const _blendK = 1;"];
    const decl = lines.findIndex((l) => /const _blendK\s*=/.test(l));
    const use = lines.findIndex((l, i) => i !== decl && /_blendK/.test(l));
    // Before trusting the pass above, prove the broken arrangement is detectable.
    expect(use).toBeLessThan(decl);
  });
});
