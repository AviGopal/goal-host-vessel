// Pins pickSatisfierProducer against the regression the SUBSTRATE ITSELF landed.
//
// 2026-08-11, commit d96e2ae, authored autonomously and cut over to the live
// vessel: the tail return was replaced with a call to the function itself —
//
//   - return best ?? pool[0];
//   + return pickSatisfierProducer(pool);
//
// which is unconditional infinite recursion: every invocation stack-overflows.
// It TYPECHECKED (it is perfectly type-correct), the semantic judge approved it,
// the reach gate graded the dispatch `reached:true` with `fileEditResult`, and it
// landed on origin/dev. Nothing in the pipeline executed the function.
//
// There was NO test file for this module. That is why the gate had nothing to say:
// a typecheck cannot distinguish "returns the best producer" from "calls itself
// forever", and every gate downstream of the typecheck was reasoning about the
// diff rather than running it.
//
// A revert alone would not hold — the gap that produced this stays open and the
// next attempt reads the same tree. This test is the thing that reads it back.
//
// ★ EVERY TERMINATION TEST CARRIES AN EXPLICIT TIMEOUT. The tail call is in
// position for tail-call optimisation, so the landed version does NOT overflow the
// stack — it spins forever. Verified: running it hangs rather than throwing. A pin
// with no timeout would therefore HANG CI instead of failing it, which is a worse
// failure than the one it is guarding (a hung suite looks like infrastructure, a
// failed suite names the defect).
import { describe, expect, test } from "bun:test";
import { pickSatisfierProducer, type SatisfierProducer } from "./satisfier-pick";

const p = (o: Partial<SatisfierProducer>): SatisfierProducer =>
  ({ endpoint: "http://localhost:1", ...o }) as SatisfierProducer;

describe("pickSatisfierProducer — TERMINATES", () => {
  // The regression pin. Under the landed change every one of these overflows the
  // stack; a plain call is enough to catch it, no timing needed.
  test("returns for an empty list", () => {
    expect(pickSatisfierProducer([])).toBeUndefined();
  }, 2000);

  test("returns for a single producer", () => {
    const only = p({ endpoint: "http://localhost:8090" });
    expect(pickSatisfierProducer([only])).toBe(only);
  }, 2000);

  test("returns when NO producer scores above the initial best", () => {
    // The `best ?? pool[0]` fallback path — the exact line that was replaced.
    // Kept as its own case because this is where a self-call would hide if it
    // were ever reintroduced as a "fallback" rather than as the tail.
    const a = p({ endpoint: "http://a", priority: Number.NEGATIVE_INFINITY });
    expect(pickSatisfierProducer([a])).toBeDefined();
  }, 2000);

  test("returns for many producers", () => {
    const many = Array.from({ length: 50 }, (_, i) => p({ endpoint: `http://h${i}`, priority: i }));
    expect(pickSatisfierProducer(many)).toBeDefined();
  }, 2000);
});

describe("pickSatisfierProducer — still prefers a LOCAL producer", () => {
  // The behaviour the module exists for; pinned so a future "fix" cannot satisfy
  // termination by returning something arbitrary.
  test("a local producer beats a libp2p one at equal priority", () => {
    const remote = p({ endpoint: "http://remote", protocol: "libp2p", priority: 1 });
    const local = p({ endpoint: "http://localhost:8090", priority: 1 });
    expect(pickSatisfierProducer([remote, local])).toBe(local);
  });

  test("a pinned authoritative owner still wins over an interchangeable replica", () => {
    const replica = p({ endpoint: "http://replica", priority: 99 });
    const owner = p({ endpoint: "http://owner", distribution_policy: "unique_authoritative" });
    expect(pickSatisfierProducer([replica, owner])).toBe(owner);
  });
});
