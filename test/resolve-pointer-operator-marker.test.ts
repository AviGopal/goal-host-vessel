import { describe, expect, test } from "bun:test";
import { buildResolvePointer, toolPointer } from "../src/resolve-pointer";

// The gap store accepts a pointer-level `operator: "operator:<id>"` marker that bypasses its hold and
// close-evidence guards. buildResolvePointer builds every walk and proxy pointer from pool variables
// plus synthesized args (the arg-correction merge, the action and action-retry picks are LLM output
// passed verbatim), so it is the one place a model-emitted marker can be dropped for every site.

describe("buildResolvePointer drops an operator marker from a write pointer", () => {
  test("MUST-FAIL: LLM args carrying operator:x produce a substrateGap_write pointer without it", () => {
    const p = buildResolvePointer("substrateGap_write", {}, { operator: "operator:x", gap: { id: "gap-x", status: "closed" } });
    expect("operator" in p).toBe(false);
    expect(p).toEqual({ gap: { id: "gap-x", status: "closed" }, type: "substrateGap_write" });
  });

  test("MUST-FAIL: a marker nested under the written record or under impulse.pointer is dropped too", () => {
    const p = buildResolvePointer("substrateGap_write", {}, {
      gap: { id: "gap-x", operator: "operator:x" },
      impulse: { pointer: { id: "gap-x", operator: "operator:x" } },
    });
    expect(JSON.stringify(p)).not.toContain("operator");
    expect(p).toEqual({ gap: { id: "gap-x" }, impulse: { pointer: { id: "gap-x" } }, type: "substrateGap_write" });
  });

  test("MUST-FAIL: a marker carried in from the pool defaults is dropped from a write pointer", () => {
    const p = buildResolvePointer("memoryNote_write", { operator: "operator:x", title: "t" }, { body: "b" });
    expect(p).toEqual({ title: "t", body: "b", type: "memoryNote_write" });
  });

  test("MUST-FAIL: a model-requested tool call to a write shape loses the marker as well", () => {
    const p = toolPointer("concept_create_write", { operator: "operator:x", summary: "s" }, {});
    expect(p).toEqual({ summary: "s", type: "concept_create_write" });
  });

  test("CONTROL: every other field of a write pointer is untouched and the caller args are not mutated", () => {
    const args = { operator: "operator:x", gap: { id: "gap-x", tags: ["a", "b"], n: 3, ok: true, none: null } };
    const p = buildResolvePointer("substrateGap_write", { dispatch_id: "d1" }, args);
    expect(p.dispatch_id).toBe("d1");
    expect(p.gap).toEqual({ id: "gap-x", tags: ["a", "b"], n: 3, ok: true, none: null });
    expect(p.type).toBe("substrateGap_write");
    expect(args.operator).toBe("operator:x");
  });

  test("CONTROL: a non-write pointer is unchanged, operator field included", () => {
    const p = buildResolvePointer("substrateGap", {}, { operator: "operator:x", filter: { operator: ">=" } });
    expect(p).toEqual({ operator: "operator:x", filter: { operator: ">=" }, type: "substrateGap" });
  });
});
