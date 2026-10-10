// THE SITUATIONAL HASH IS NEVER SENT AS `state_signature` TO A RECOMMEND/DISCOVER QUERY (OP-1 d).
//
// Measured (diag-1a1e, 24h): /v2/activities/recommend logged "caller state_signature REJECTED (wrong form)" 2,515
// times, every one of length 8. goal-host sent getCachedStateSignature().signature_hash — the 8-hex SITUATIONAL hash
// (host load, trace statistics, catalogue size, rhythm) — under `state_signature`, the field the route reserves for
// the 16-hex SHAPE-POOL signature (activity-api activities.ts: "Two different signatures currently share this field
// name … The mismatch needs resolving at the SENDER"). Accepting it there would merge two partitions in one column;
// rejecting it is lossless but leaves every call reading as "context supplied" when none was.
//
// THE RULE PINNED HERE: no request body goal-host posts to a /recommend route or to discover-by-shapes carries a
// `state_signature` key; the situational hash rides as `situational_signature`. The /v2/goal-paths RECORD is out of
// scope: its receiver stores any string under state_signature and validates nothing.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");

/** Every literal request body posted to a URL naming one of `routes`: the text from `body: JSON.stringify(` to `signal:`. */
function postedBodies(src: string, routes: RegExp): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/fetch\(([^\n]{0,200})/g)) {
    const at = m.index ?? 0;
    const head = m[1] ?? "";
    const pre = src.slice(Math.max(0, at - 600), at);
    // The URL is either inline in fetch( … ) or a variable assigned just above it.
    const urlText = head + pre.slice(pre.lastIndexOf("\n", pre.length - 2));
    if (!routes.test(urlText)) continue;
    const w = src.slice(at, at + 1500);
    const b = w.indexOf("body: JSON.stringify(");
    if (b < 0) continue;
    const e = w.indexOf("signal:", b);
    out.push(w.slice(b, e > b ? e : b + 900));
  }
  return out;
}
const ROUTES = /\/recommend`|discover-by-shapes`/;

describe("MUST-FAIL — no recommend/discover body carries a non-shape-pool state_signature", () => {
  const bodies = postedBodies(SRC, ROUTES);
  test("the instrument finds the query sites (goal-paths/recommend, activities/recommend ×3, discover-by-shapes ×2)", () => {
    expect(bodies.length).toBeGreaterThanOrEqual(6);
  });
  test("none of them sends a `state_signature` key", () => {
    for (const b of bodies) expect(b).not.toMatch(/\bstate_signature\s*:/);
  });
  test("the situational hash is still sent, under its own name, at the six sites that sent it", () => {
    expect(bodies.filter((b) => /\bsituational_signature\s*:/.test(b)).length).toBe(6);
  });
  test("no key-by-key builder sets body.state_signature", () => {
    expect(SRC).not.toMatch(/\bbody\.state_signature\s*=/);
  });
  test("NEGATIVE CONTROL: the scan catches a defective body", () => {
    const bad = "const r = await fetch(`${X}/v2/activities/recommend`, {\n  method: \"POST\",\n  body: JSON.stringify({ goal, ...(_sig ? { state_signature: _sig } : {}) }),\n  signal: AbortSignal.timeout(1),\n});";
    const found = postedBodies(bad, ROUTES);
    expect(found.length).toBe(1);
    expect(found[0]).toMatch(/\bstate_signature\s*:/);
  });
});
