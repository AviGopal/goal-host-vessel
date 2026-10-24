// AN UNREGISTERED STEP IS NOT A PICK (src/unregistered-step.ts): a template, or a learned or composed chain, whose step
// resolver nothing serves is found before dispatch and named as unregistered_step_resolver:<shape>. Measured instance:
// auto-bridge-source_code and the chains composed over it, with source_code no longer registered in discovery.
import { describe, expect, it } from "bun:test";

import { firstUnregisteredStep, unregisteredStepReason } from "../src/unregistered-step";

const BRIDGE = { id: "auto-bridge-source_code", tasks: [{ id: "invoke", resolver: "source_code" }] };
const CHAIN = {
  id: "learned-composition-source-code-to-llm-completion",
  tasks: [
    { id: "s1", resolver: "compose", subActivityId: "auto-bridge-source_code" },
    { id: "s2", resolver: "llm_completion" },
  ],
};
const PARALLEL = { id: "composed-cap-par", tasks: [{ id: "p", resolver: "compose_parallel", subActivityIds: ["reader", "auto-bridge-source_code"] }] };
const READER = { id: "reader", tasks: [{ id: "r", resolver: "file-read" }] };
const LIBRARY: Record<string, unknown> = { "auto-bridge-source_code": BRIDGE, reader: READER };
const fetchChild = async (id: string): Promise<unknown | null> => LIBRARY[id] ?? null;

// The registry as the walk reads it: discovery lists llm_completion, not source_code; file-read is a local built-in.
const REGISTRY = new Set(["llm_completion", "shellResult"]);
const LOCAL = new Set(["file-read", "bash", "llm"]);
const served = (r: string): boolean => REGISTRY.has(r) || LOCAL.has(r);
const servedWithSourceCode = (r: string): boolean => served(r) || r === "source_code";

describe("[MUST-FAIL] a pick whose step resolver is unregistered is ineligible, with the reason recorded", () => {
  it("the bridge auto-bridge-source_code is refused, naming source_code", async () => {
    const hit = await firstUnregisteredStep(BRIDGE, served, fetchChild);
    expect(hit).toBe("source_code");
    expect(unregisteredStepReason(hit!)).toBe("unregistered_step_resolver:source_code");
  });
  it("a learned chain that composes the bridge is refused for its child's step", async () => {
    expect(await firstUnregisteredStep(CHAIN, served, fetchChild)).toBe("source_code");
  });
  it("a compose_parallel chain with one unregistered branch is refused", async () => {
    expect(await firstUnregisteredStep(PARALLEL, served, fetchChild)).toBe("source_code");
  });
  it("a resolver id that names a template (activities as resolvers) is judged by that template's steps", async () => {
    const viaActivity = { id: "via-activity", tasks: [{ id: "a", resolver: "auto-bridge-source_code" }] };
    expect(await firstUnregisteredStep(viaActivity, served, fetchChild)).toBe("source_code");
  });
});

describe("CONTROL: the same picks with their resolver registered are eligible", () => {
  it("the bridge is eligible while discovery lists source_code", async () => {
    expect(await firstUnregisteredStep(BRIDGE, servedWithSourceCode, fetchChild)).toBeNull();
  });
  it("the learned chain is eligible while discovery lists source_code", async () => {
    expect(await firstUnregisteredStep(CHAIN, servedWithSourceCode, fetchChild)).toBeNull();
  });
  it("a template of local built-ins and registered shapes is eligible", async () => {
    const t = { id: "read-then-ask", tasks: [{ id: "a", resolver: "file-read" }, { id: "b", resolver: "llm_completion" }, { id: "c", resolver: "bash" }] };
    expect(await firstUnregisteredStep(t, served, fetchChild)).toBeNull();
  });
  it("an unfetchable composed child is not judged here, and a composition cycle terminates", async () => {
    const missingChild = { id: "m", tasks: [{ id: "x", resolver: "compose", subActivityId: "gone" }] };
    expect(await firstUnregisteredStep(missingChild, served, fetchChild)).toBeNull();
    const loop: Record<string, unknown> = { a: { id: "a", tasks: [{ id: "1", resolver: "compose", subActivityId: "b" }] }, b: { id: "b", tasks: [{ id: "2", resolver: "compose", subActivityId: "a" }] } };
    expect(await firstUnregisteredStep(loop.a, served, async (id) => loop[id] ?? null)).toBeNull();
  });
});
