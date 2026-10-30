// A DISPATCH ENTERED INSIDE ANOTHER NEVER INHERITS ITS GAP FIELD OR ITS RECALL RECORD (observe stays sticky).
//
// index.ts builds every dispatch-context entry over the CURRENT store (enterDispatchContext). When that store is another
// dispatch's (an in-process dispatch started inside one, or the floor re-entering from a foreign chain), the spread kept
// the other dispatch's decomposeGapId, and because the gap field is set only when absent, it beat the entering
// dispatch's own value: the reach gate graded the wrong gap. The recall record was shared too, so the inner dispatch's
// recalls were credited to the outer one. A foreign store now lends only observe. A dispatch's own re-entries under its
// caller-supplied variables.dispatch_id alias (the cost and recovery entries) are recognised by the ids its root
// recorded, so they keep the record.
//
//   [MUST-FAIL] a nested root entry over a foreign store drops its gap field and its recall record, keeps observe
//   [MUST-FAIL] the floor re-entering from a foreign store takes ITS OWN gap field, not the foreign one
//   [MUST-FAIL] index.ts records the root's ids beside its recall record (noteDispatchIds after beginRecallRecord)
//   [CONTROL]   a re-entry under the dispatch's own alias keeps the gap field and the SAME recall record
//   [CONTROL]   a same-id re-entry is unchanged (the existing entry rule), and a store whose root recorded no ids is
//               never judged foreign (the entry rule as before)
//
// Fixture words from a 5-word draw (draw-words.sh): 2026-10-30T04:36:15Z seed=1793334975723833422
// words=glutinous dispatch landside caution audibly
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as DC from "../src/dispatch-context";

const D = DC as Record<string, any>;
const enter = DC.enterDispatchContext;
const noteIds = (s: DC.DispatchContextStore, alias?: string) => (D["noteDispatchIds"] ? D["noteDispatchIds"](s, alias) : undefined);
const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

function outerRoot(mode: "observe" | "learn" = "learn"): DC.DispatchContextStore {
  const s = enter(undefined, { dispatchId: "outer-landside", learningMode: mode });
  DC.beginRecallRecord(s);
  noteIds(s);
  s.decomposeGapId = "gap-glutinous-caution";
  s.recalledConceptIds!.add("concept-outer");
  return s;
}

describe("a foreign store lends only observe", () => {
  it("[MUST-FAIL] a nested root entry drops the outer gap field and recall record; observe stays sticky", () => {
    const outer = outerRoot("observe");
    const inner = enter(outer, { dispatchId: "inner-audibly", learningMode: "learn" });
    expect(inner.decomposeGapId).toBeUndefined();
    expect(inner.recalledConceptIds).toBeUndefined();
    expect(inner.learningMode).toBe("observe");
    expect(outer.decomposeGapId).toBe("gap-glutinous-caution");
    expect([...outer.recalledConceptIds!]).toEqual(["concept-outer"]);
  });
  it("[MUST-FAIL] the floor re-entering from a foreign store takes its own gap field", () => {
    const floor = enter(outerRoot(), { dispatchId: "inner-audibly", decomposeGapId: "gap-inner-own", learningMode: "learn" });
    expect(floor.decomposeGapId).toBe("gap-inner-own");
    expect(floor.recalledConceptIds).toBeUndefined();
  });
  it("[MUST-FAIL] index.ts records the root's ids right after its recall record", () => {
    const i = SRC.indexOf("beginRecallRecord(dispatchContext.getStore());");
    expect(i).toBeGreaterThan(0);
    expect(SRC.indexOf("noteDispatchIds(dispatchContext.getStore(), variables.dispatch_id);", i)).toBeGreaterThan(i);
    expect(SRC.indexOf("noteDispatchIds(dispatchContext.getStore(), variables.dispatch_id);", i)).toBeLessThan(SRC.indexOf("const seek = await runGoalWithRecovery(goal, {", i));
  });
  it("[CONTROL] a re-entry under the dispatch's own alias keeps the gap field and the same recall record", () => {
    const root = enter(undefined, { dispatchId: "root-landside", learningMode: "learn" });
    DC.beginRecallRecord(root);
    noteIds(root, "alias-caution");
    root.decomposeGapId = "gap-own";
    const again = enter(root, { dispatchId: "alias-caution", learningMode: "learn" });
    expect(again.decomposeGapId).toBe("gap-own");
    expect(again.recalledConceptIds).toBe(root.recalledConceptIds);
  });
  it("[CONTROL] a same-id re-entry is unchanged; a store with no ids recorded is never judged foreign", () => {
    const parent: DC.DispatchContextStore = { dispatchId: "d1", decomposeGapId: "g", learningMode: "observe", goal: "g1" };
    expect(enter(parent, { dispatchId: "d1", learningMode: "learn", decomposeGapId: "other", goal: "g2" })).toEqual({ dispatchId: "d1", decomposeGapId: "g", learningMode: "observe", goal: "g2" });
    const same = enter(outerRoot(), { dispatchId: "outer-landside" });
    expect(same.decomposeGapId).toBe("gap-glutinous-caution");
    expect([...same.recalledConceptIds!]).toEqual(["concept-outer"]);
    const noIds: DC.DispatchContextStore = { dispatchId: "d0", decomposeGapId: "g0", learningMode: "learn" };
    expect(enter(noIds, { dispatchId: "d1", decomposeGapId: "g1" }).decomposeGapId).toBe("g0");
  });
});
