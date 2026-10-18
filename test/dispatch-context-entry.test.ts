// THE DISPATCH CONTEXT'S ENTRY RULE (src/dispatch-context.ts), at the floor's REAL re-entry. The re-entry block of
// universalToolFallback is cut out of src/index.ts (signature to the floor's ENTER log line) and transpiled, with the
// rest of the floor replaced by a probe that reads the store the floor would run under and calls the REAL ufExecuteTool
// (cut the same way as observe-floor-tool.test.ts) for authoring shapes. index.ts boots a server on import, so this is
// the closest the floor's entry can be run in a test.
//   both fields: one dispatch carrying decompose_gap_id and learning_mode:"observe" — the floor's store holds both;
//   no downgrade: under an observe parent, a re-entry passing no mode, or "learn", still runs as observe and its
//                 authoring calls are refused before anything is sent;
//   set-if-absent: a nested gap id never replaces the one already in the store;
//   control: a learn dispatch stays learn, and its authoring call goes out.
import { afterEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

import { enterDispatchContext, type DispatchContextStore } from "../src/dispatch-context";
import * as om from "../src/observe-mode";
import { toolPointer } from "../src/resolve-pointer";
import { isWalkEgressRefused, setWalkEgressLearningModeReader, walkEgressFetch } from "../src/walk-egress-guard";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
const tp = new Bun.Transpiler({ loader: "ts" });
const ufStart = src.indexOf("async function universalToolFallback(");
const ufEnd = src.indexOf("  console.log(`[goal-host-vessel] floor: ENTER universalToolFallback", ufStart);
const reentryTs = `${src.slice(ufStart, ufEnd)}  return probe(dispatchContext.getStore());\n}\n`;
const toolStart = src.indexOf("async function ufExecuteTool(");
const toolTs = src.slice(toolStart, src.indexOf("\n}\n", toolStart) + 2);

const dispatchContext = new AsyncLocalStorage<DispatchContextStore>();
setWalkEgressLearningModeReader(() => dispatchContext.getStore());
const ufExecuteTool = new Function("walkEgressFetch", "isWalkEgressRefused", "toolPointer", "dispatchContext", "ufResolveUrl", "ufOwnProducerUrl", "API_KEY",
  `${tp.transformSync(toolTs)}\nreturn ufExecuteTool;`)(walkEgressFetch, isWalkEgressRefused, toolPointer, dispatchContext, async () => "http://dv/v2/impulses/resolve", async () => "http://dv/v2/impulses/resolve", "k");
const AUTHORING = ["feature_compose", "author_producer"];
type Seen = { store: DispatchContextStore | undefined; ok: boolean[] };
const probe = async (store: DispatchContextStore | undefined): Promise<Seen> => {
  const ok: boolean[] = [];
  for (const name of AUTHORING) ok.push((await ufExecuteTool(name, { spec: "s", shape: "x" }, new Set([name]))).ok);
  return { store, ok };
};
const universalToolFallback = new Function("dispatchContext", "enterDispatchContext", "probe",
  `${tp.transformSync(reentryTs)}\nreturn universalToolFallback;`)(dispatchContext, enterDispatchContext, probe) as
  (goal: string, targetShapes: string[], dispatchId?: string, out?: unknown, walkContext?: { decomposeGapId?: string; learningMode?: "observe" | "learn" }) => Promise<Seen>;

const realFetch = globalThis.fetch;
let sent: unknown[] = [];
const stub = () => { sent = []; globalThis.fetch = (async (_u: unknown, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ content: "ok" }), { status: 200 }); }) as typeof fetch; };
afterEach(() => { globalThis.fetch = realFetch; om.resetObserveSkips(); });
const GAP = "gap-entry-test";
const floorUnder = (parent: DispatchContextStore | undefined, dispatchId: string, walkContext: { decomposeGapId?: string; learningMode?: "observe" | "learn" }) =>
  parent ? dispatchContext.run(parent, () => universalToolFallback("investigate the gap", [], dispatchId, undefined, walkContext)) : universalToolFallback("investigate the gap", [], dispatchId, undefined, walkContext);

describe("the floor's real re-entry", () => {
  test("cut the real re-entry and the real tool call", () => {
    expect(reentryTs).toContain("return await dispatchContext.run(");
    expect(reentryTs).toContain("const _floorGapId = walkContext?.decomposeGapId;");
    expect(toolTs).toContain("walkEgressFetch(name, turl");
  });
  test("[MUST-FAIL] one dispatch with decompose_gap_id and learning_mode observe: the floor's store holds both", async () => {
    stub();
    const seen = await floorUnder(undefined, "d1", { decomposeGapId: GAP, learningMode: "observe" });
    expect(seen.store?.dispatchId).toBe("d1");
    expect(seen.store?.decomposeGapId).toBe(GAP);
    expect(seen.store?.learningMode).toBe("observe");
    expect(seen.ok).toEqual([false, false]);
    expect(sent).toEqual([]);
  });
  test("[MUST-FAIL] under an observe parent, a re-entry passing learn still runs as observe and authoring is refused", async () => {
    stub();
    // the parent lacks the gap id, so the gap-id half of the re-entry condition fires inside the same dispatch
    const seen = await floorUnder({ dispatchId: "d1", learningMode: "observe" }, "d1", { decomposeGapId: GAP, learningMode: "learn" });
    expect(seen.store?.learningMode).toBe("observe");
    expect(seen.store?.decomposeGapId).toBe(GAP);
    expect(seen.ok).toEqual([false, false]);
    expect(sent).toEqual([]);
  });
  test("[MUST-FAIL] under an observe parent, a re-entry passing no mode still runs as observe and authoring is refused", async () => {
    stub();
    const seen = await floorUnder({ dispatchId: "d0", learningMode: "observe" }, "d1", {});
    expect(seen.store?.dispatchId).toBe("d1");
    expect(seen.store?.learningMode).toBe("observe");
    expect(seen.ok).toEqual([false, false]);
    expect(sent).toEqual([]);
  });
  test("[MUST-FAIL] a nested gap id never replaces the one in the store", async () => {
    stub();
    const seen = await floorUnder({ dispatchId: "d0", decomposeGapId: GAP, learningMode: "learn" }, "d1", { decomposeGapId: "gap-nested" });
    expect(seen.store?.decomposeGapId).toBe(GAP);
  });
  test("[CONTROL] a learn dispatch stays learn at the floor, and its authoring call goes out", async () => {
    stub();
    const seen = await floorUnder(undefined, "d2", { learningMode: "learn" });
    expect(seen.store).toEqual({ dispatchId: "d2", learningMode: "learn", goal: "investigate the gap" });
    expect(seen.ok).toEqual([true, true]);
    expect(sent.length).toBe(2);
  });
});

describe("enterDispatchContext", () => {
  test("an undefined never erases a field; observe is sticky; the gap id is set only when absent; goal is the site's", () => {
    const parent: DispatchContextStore = { dispatchId: "d1", decomposeGapId: GAP, learningMode: "observe", goal: "g1" };
    expect(enterDispatchContext(parent, { dispatchId: "d1" })).toEqual(parent);
    expect(enterDispatchContext(parent, { dispatchId: "d1", learningMode: "learn", decomposeGapId: "other", goal: "g2" })).toEqual({ dispatchId: "d1", decomposeGapId: GAP, learningMode: "observe", goal: "g2" });
    expect(enterDispatchContext({ dispatchId: "d1", learningMode: "learn" }, { dispatchId: "d1", learningMode: "observe" }).learningMode).toBe("observe");
    expect(parent).toEqual({ dispatchId: "d1", decomposeGapId: GAP, learningMode: "observe", goal: "g1" });
  });
  test("[CONTROL] an empty store takes the site's fields as given", () => {
    expect(enterDispatchContext(undefined, { dispatchId: "d3", learningMode: "learn", decomposeGapId: GAP })).toEqual({ dispatchId: "d3", learningMode: "learn", decomposeGapId: GAP });
  });
  test("[MUST-FAIL] wiring: every entry in index.ts goes through enterDispatchContext over the existing store", () => {
    expect(src.match(/dispatchContext\.(enterWith|run)\(\{[^\n]{0,80}/g) ?? []).toEqual([]);
    expect(src.split("enterDispatchContext(dispatchContext.getStore(), {").length - 1).toBe(4);
    expect(src).toContain('import { enterDispatchContext } from "./dispatch-context";');
  });
});
