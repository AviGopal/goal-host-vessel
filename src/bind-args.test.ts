import { describe, it, expect } from "bun:test";
import { bindArgsFromPool, boundValues, describeBindings, requiredFieldsFromCorrection } from "./bind-args";

// Pins BIND-BEFORE-SYNTHESISE. The operator's diagnosis, 2026-09-03: impulse content is not
// threaded through activities, though impulses can be treated as variables.
//
// Measured before writing this. Synthesis DOES receive the pool — but as truncated prose
// (`- <shape>: <content sliced to 800>`), with terminal shapes filtered out, inside a block
// whose bulk warns the model NOT to use prior findings. The deterministic reference mechanism
// ({{shape.field}}, interpolated from the pool) has ZERO uses in the retained journal. Result:
// 12 of 41 produced shapes since 2026-09-01 (29%) carried an error body, every one "X is
// required" — including a shellResult "command is required" emitted while the answer sat in an
// already-produced webSearchResult IN THE SAME POOL.
//
// The binder is deliberately conservative: a WRONG bind is worse than no bind, because a wrong
// value is silent where a missing field is loud.

const imp = (shape: string, content: unknown) => ({ content, metadata: { shape } });

describe("bindArgsFromPool", () => {
  it("binds a required field the pool supplies", () => {
    const b = bindArgsFromPool(["path"], [imp("fileContent", { path: "repos/x/src/a.ts", size: 10 })]);
    expect(b.path?.value).toBe("repos/x/src/a.ts");
    expect(b.path?.fromShape).toBe("fileContent");
  });

  it("binds from a JSON-STRING content body, which is how many impulses arrive", () => {
    const b = bindArgsFromPool(["command"], [imp("shellResult", '{"command":"wc -l a.ts"}')]);
    expect(b.command?.value).toBe("wc -l a.ts");
  });

  it("binds numbers and booleans, not just strings", () => {
    const b = bindArgsFromPool(["limit", "recursive"], [imp("q", { limit: 25, recursive: true })]);
    expect(b.limit?.value).toBe(25);
    expect(b.recursive?.value).toBe(true);
  });

  it("REFUSES to bind when two impulses disagree — ambiguity must fall through to synthesis", () => {
    const b = bindArgsFromPool(["path"], [imp("a", { path: "one.ts" }), imp("b", { path: "two.ts" })]);
    expect(b.path).toBeUndefined();
  });

  it("binds when two impulses AGREE — repetition is not ambiguity", () => {
    const b = bindArgsFromPool(["path"], [imp("a", { path: "same.ts" }), imp("b", { path: "same.ts" })]);
    expect(b.path?.value).toBe("same.ts");
  });

  it("never binds an object or array into a scalar argument", () => {
    const b = bindArgsFromPool(["payload", "items"], [imp("x", { payload: { a: 1 }, items: [1, 2] })]);
    expect(b.payload).toBeUndefined();
    expect(b.items).toBeUndefined();
  });

  it("treats an empty or whitespace string as no value", () => {
    expect(bindArgsFromPool(["path"], [imp("x", { path: "" })]).path).toBeUndefined();
    expect(bindArgsFromPool(["path"], [imp("x", { path: "   " })]).path).toBeUndefined();
  });

  it("only binds DECLARED required fields — it does not scrape the pool for extras", () => {
    const b = bindArgsFromPool(["path"], [imp("x", { path: "a.ts", secret: "do-not-bind" })]);
    expect(Object.keys(b)).toEqual(["path"]);
  });

  it("is safe on empty/garbage input and never throws", () => {
    expect(bindArgsFromPool([], [imp("x", { a: 1 })])).toEqual({});
    expect(bindArgsFromPool(["a"], [])).toEqual({});
    expect(bindArgsFromPool(["a"], [imp("x", "not json")])).toEqual({});
    expect(bindArgsFromPool(["a"], [imp("x", null)])).toEqual({});
    expect(bindArgsFromPool(["a"], [{ content: undefined } as never])).toEqual({});
  });

  it("THE WORKED CASE: a command already present in the pool is bound, not re-invented", () => {
    // This is the tungsten failure inverted — the operand existed and the step still asked
    // an LLM for it, then emitted {"error":"command is required"}.
    const pool = [imp("webSearchResult", { query: "melting point", results: "…" }), imp("recipe", { command: "curl -s https://example/api | jq .value" })];
    const b = bindArgsFromPool(["command"], pool);
    expect(b.command?.value).toBe("curl -s https://example/api | jq .value");
    expect(b.command?.fromShape).toBe("recipe");
  });
});

describe("boundValues / describeBindings", () => {
  it("strips provenance for the call site", () => {
    const b = bindArgsFromPool(["path"], [imp("fileContent", { path: "a.ts" })]);
    expect(boundValues(b)).toEqual({ path: "a.ts" });
  });

  it("renders provenance so the bind RATE is measurable from the journal", () => {
    const b = bindArgsFromPool(["path"], [imp("fileContent", { path: "a.ts" })]);
    expect(describeBindings(b)).toBe("path<-fileContent");
    expect(describeBindings({})).toBe("none");
  });
});

// Recovering required-field names from the resolver's own refusal. Needed because
// resolver_schema answers known:false for exactly the shapes that fail this way — measured
// live: shellResult, webSearchResult and fs_edit all unknown, while substrateGap_write is
// known. A schema-only binder is therefore inert where it matters, which is what the first
// version of this change measured as: 12 synthesis calls, 0 bindings.
describe("requiredFieldsFromCorrection", () => {
  it("recovers a single field", () => {
    expect(requiredFieldsFromCorrection("shellResult: command is required")).toEqual(["command"]);
  });

  it("recovers a conjunction — the fs_edit case", () => {
    expect(requiredFieldsFromCorrection('{"error":"path and name are required"}').sort()).toEqual(["name", "path"]);
  });

  it("takes the LAST dotted segment, since args are emitted flat", () => {
    expect(requiredFieldsFromCorrection('pointer.concept_id is required for shape "concept"')).toEqual(["concept_id"]);
  });

  it("handles a comma list", () => {
    expect(requiredFieldsFromCorrection("id, category and summary are required").sort()).toEqual(["category", "id", "summary"]);
  });

  it("returns nothing for text that names no requirement", () => {
    expect(requiredFieldsFromCorrection("the operation timed out")).toEqual([]);
    expect(requiredFieldsFromCorrection(undefined)).toEqual([]);
    expect(requiredFieldsFromCorrection("")).toEqual([]);
  });

  it("feeds the binder end to end: refusal names it, pool supplies it", () => {
    const fields = requiredFieldsFromCorrection('{"error":"command is required"}');
    const bound = bindArgsFromPool(fields, [{ content: { command: "wc -l a.ts" }, metadata: { shape: "recipe" } }]);
    expect(bound.command?.value).toBe("wc -l a.ts");
  });
});
