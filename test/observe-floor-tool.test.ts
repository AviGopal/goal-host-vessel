// OBSERVE AT THE FLOOR'S TOOL LOOP (behavioural; promoted from the qa review of the observe series). The REAL
// ufExecuteTool source is cut out of src/index.ts and transpiled with its real dependencies (walkEgressFetch, toolPointer,
// isWalkEgressRefused) and a dispatch context wired to the egress guard exactly as index.ts wires it
// (setWalkEgressLearningModeReader(() => dispatchContext.getStore())). index.ts boots a server on import, so this is the
// closest the floor can be run in a test: if ufExecuteTool grows a dependency the cut does not supply, the "extracted
// the real function" test or the transpiled call fails loudly rather than passing silently.
//   observe: gapDecomposition (its pointer is model-built here, so it says learn), feature_compose, gap_compose,
//            development-vessel:feature_compose, author_producer and substrateGap_write are refused, nothing sent;
//   control: under learn, feature_compose and gapDecomposition go out with the pointer unchanged.
import { afterEach, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";

import * as om from "../src/observe-mode";
import { toolPointer } from "../src/resolve-pointer";
import { isWalkEgressRefused, setWalkEgressLearningModeReader, walkEgressFetch } from "../src/walk-egress-guard";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
const start = src.indexOf("async function ufExecuteTool(");
const end = src.indexOf("\n}\n", start) + 2;
const fnTs = src.slice(start, end);
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(fnTs);
const dispatchContext = new AsyncLocalStorage<{ dispatchId: string; learningMode?: "observe" | "learn" }>();
setWalkEgressLearningModeReader(() => dispatchContext.getStore());
const make = new Function("walkEgressFetch", "isWalkEgressRefused", "toolPointer", "dispatchContext", "ufResolveUrl", "ufOwnProducerUrl", "API_KEY",
  `${js}\nreturn ufExecuteTool;`);
const ufExecuteTool = make(walkEgressFetch, isWalkEgressRefused, toolPointer, dispatchContext, async () => "http://dv/v2/impulses/resolve", async () => "http://dv/v2/impulses/resolve", "k");

const realFetch = globalThis.fetch;
let sent: any[] = [];
afterEach(() => { globalThis.fetch = realFetch; om.resetObserveSkips(); });
const stub = () => { sent = []; globalThis.fetch = (async (_u: any, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ content: "ok" }), { status: 200 }); }) as any; };
const run = (mode: "observe" | "learn" | undefined, name: string, args: Record<string, unknown>) =>
  dispatchContext.run({ dispatchId: "d1", learningMode: mode }, () => ufExecuteTool(name, args, new Set([name])));

test("extracted the real function", () => { expect(fnTs).toContain("walkEgressFetch(name, turl"); });
for (const shape of ["gapDecomposition", "feature_compose", "gap_compose", "development-vessel:feature_compose", "author_producer"]) {
  test(`observe floor: ${shape} is refused before fetch`, async () => {
    stub();
    const r = await run("observe", shape, { decompose_gap_id: "g-1", spec: "s", shape: "x", learning_mode: shape === "gapDecomposition" ? "learn" : "observe" });
    expect(r.ok).toBe(false);
    expect(sent).toEqual([]);
  });
}
test("observe floor: a model-supplied learning_mode observe on gapDecomposition goes out as observe (it runs dry)", async () => {
  stub();
  const r = await run("observe", "gapDecomposition", { decompose_gap_id: "g-1", learning_mode: "observe" });
  expect(r.ok).toBe(true);
  expect(sent.length).toBe(1);
  expect(sent[0].impulse.pointer.learning_mode).toBe("observe");
});
test("observe floor: substrateGap_write refused", async () => {
  stub();
  const r = await run("observe", "substrateGap_write", { id: "g", summary: "x" });
  expect(r.ok).toBe(false); expect(sent).toEqual([]);
});
test("control learn: feature_compose and gapDecomposition go out", async () => {
  stub();
  expect((await run("learn", "feature_compose", { spec: "s" })).ok).toBe(true);
  expect((await run("learn", "gapDecomposition", { decompose_gap_id: "g" })).ok).toBe(true);
  expect(sent.length).toBe(2);
  expect(sent[1].impulse.pointer.learning_mode).toBeUndefined();
});
