import { describe, it, expect } from "bun:test";
import { reachVerdictBody } from "../../src/index";

// The defect to reproduce: when the LLM judge never answers (verdict === null after retries),
// the run is NOT an abstain (walkAbstain is only from verdict.abstain). It must be handled as an
// ordinary not-reached with reached=false. This check asserts that outcome directly on the module's
// reachVerdictBody export. It is intentionally red today.

describe("reach verdict handling when judge returns null", () => {
  it("grades as not reached (reached=false) when verdict is null (not abstain)", () => {
    // Call through the exported implementation, but guard against throws so the red is an assertion
    // failure (not a thrown error). If the function throws or returns undefined, we coerce to a
    // value that makes the assertion fail, keeping the failure on the expected assertion site.
    const safeCall = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };

    // Pass a minimal input representing the verifier being unreachable and verdict unknown.
    // The exact shape is implementation-defined; we thread an object with verdict:null and a
    // reason string that appears in the gap text. Any mismatch will be safely coerced below.
    const body = safeCall(() => ((input: { reason: string }) => reachVerdictBody('test-exec', false, null, input.reason))({ verdict: null, reason: "reach verifier unreachable after retries - verdict unknown" }));

    // Pull the reached flag if present; default to true so that if the implementation mishandles
    // null verdicts (or the call path didn’t produce a body), this assertion is red for the right reason.
    const reached = (body as { reached?: boolean } | undefined)?.reached ?? true;

    // Desired behaviour: reached must be false when verdict is null (not an abstain path).
    expect(reached).toBe(false);
  });
});
