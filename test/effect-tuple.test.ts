import { describe, test, expect } from "bun:test";

// Mirror of effectTupleOf (module-private in index.ts). Pinned here because the
// CANONICALIZATION is the load-bearing decision: too fine and it splits identical
// goals, too coarse and it stops differentiating.
function effectTupleOf(shape: string, vesselEndpoint: string | undefined, content: unknown): string {
  const canon = (u: string): string => {
    const m = /^https?:\/\/([^/\s"']+)(\/[A-Za-z0-9_.\-]*)?/.exec(u);
    if (!m) return "";
    const seg = (m[2] ?? "").replace(/^\//, "").split(/[.?#]/)[0] ?? "";
    return `${m[1]}${seg ? "/" + seg : ""}`;
  };
  const vessel = vesselEndpoint ? canon(vesselEndpoint) || vesselEndpoint : "unresolved";
  const kind = /_write$|^fs_write$|Write$/.test(shape) ? "write" : "read";
  const blob = typeof content === "string" ? content : (() => { try { return JSON.stringify(content) ?? ""; } catch { return ""; } })();
  const externals = [...new Set((blob.match(/https?:\/\/[^\s"'\\)]+/g) ?? []).map(canon).filter(Boolean))].sort();
  return `${vessel}|${shape}|${kind}|${externals.join(",")}`;
}

const V = "http://localhost:8100";

describe("effectTupleOf — the measured rephrasing case", () => {
  // 2 phrasings x 3 reps of ONE goal produced three raw paths, split along the
  // phrasing boundary. All six must canonicalize equal or the key splits
  // identical work — the mirror of the defect it repairs.
  test("the three raw paths that actually occurred collapse to one tuple", () => {
    const a = effectTupleOf("shellResult", V, `curl -s http://127.0.0.1:8100/registry/shapes | jq '.shapes | length'`);
    const b = effectTupleOf("shellResult", V, `curl -s http://127.0.0.1:8100/registry/stats | jq .totalShapes`);
    const c = effectTupleOf("shellResult", V, `curl -s http://127.0.0.1:8100/registry/stats.totalShapes`);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toContain("127.0.0.1:8100/registry");
  });

  test("THE COLLISION IT REPAIRS: one round-trip vs two are different tuples", () => {
    const r1 = effectTupleOf("shellResult", V, `curl http://127.0.0.1:8100/registry/shapes`);
    const r3 = effectTupleOf("shellResult", V, `curl http://127.0.0.1:8100/registry/shapes; curl http://127.0.0.1:8090/v2/impulses/resolve`);
    expect(r1).not.toBe(r3);   // rungs 1 and 3 share path_signature today
  });

  test("a DIFFERENT vessel is a different tuple", () => {
    expect(effectTupleOf("memoryNote_write", "http://localhost:8090", ""))
      .not.toBe(effectTupleOf("memoryNote_write", V, ""));
  });

  test("write shapes are classified as writes", () => {
    expect(effectTupleOf("memoryNote_write", V, "")).toContain("|write|");
    expect(effectTupleOf("shellResult", V, "")).toContain("|read|");
  });

  test("INVARIANT: endpoint order and duplicates do not move the tuple", () => {
    const one = effectTupleOf("shellResult", V, `http://a.b:1/x http://c.d:2/y http://a.b:1/x`);
    const two = effectTupleOf("shellResult", V, `http://c.d:2/y http://a.b:1/x`);
    expect(one).toBe(two);
  });

  test("CONTROL: content with no URLs yields an empty external set, not a crash", () => {
    expect(effectTupleOf("shellResult", V, "324")).toBe("localhost:8100|shellResult|read|");
  });

  test("CONTROL: an unresolved vessel is labelled, never silently blank", () => {
    expect(effectTupleOf("shellResult", undefined, "")).toContain("unresolved|");
  });

  test("KNOWN BOUNDARY: two local-only commands collide — stated, not hidden", () => {
    // A find|wc and a grep -c contact no URL, so both yield an empty external
    // set. This key does not separate purely local work; that is its edge.
    expect(effectTupleOf("shellResult", V, "find . | wc -l"))
      .toBe(effectTupleOf("shellResult", V, "grep -c foo bar"));
  });
});
