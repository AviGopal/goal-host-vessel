import { describe, expect, test } from "bun:test";

describe("gap pending verification tracks the correct landing (earlier, correct one)", () => {
  test("route-edit-a907d4ca: later wrong landing should not displace earlier delivered ask", async () => {
    const gapId = "route-edit-a907d4ca";

    // Ensure module import does not throw on env-gated LLM port creation.
    const prevEndpoint = process.env.LLM_VESSEL_ENDPOINT;
    process.env.LLM_VESSEL_ENDPOINT = process.env.LLM_VESSEL_ENDPOINT ?? "http://127.0.0.1:8220";

    try {
      const mod = await import("../../src/index");
      const fn = (mod as any).resolveFleetActivityFeed;
      expect(typeof fn).toBe("function"); // module loads and export exists

      // Two landings for the same gap:
      // - earlier landing: correct (delivered the ask)
      // - later landing: wrong (should not be tracked for pending verification)
      const feed = {
        events: [
          {
            type: "landing",
            gapId,
            sha: "2c0aad94", // 2026-09-25 00:53Z (earlier)
            at: Date.parse("2026-09-25T00:53:00Z"),
            delivered: true,
            site: { path: "src/index.ts", line: 13451 },
            vessel: "goal-host-vessel",
          },
          {
            type: "landing",
            gapId,
            sha: "decb1bb", // 2026-09-25 03:00Z (later, wrong)
            at: Date.parse("2026-09-25T03:00:00Z"),
            delivered: false,
            site: { path: "src/index.ts", line: 13451 },
            vessel: "goal-host-vessel",
          },
        ],
      } as const;

      // Call into the implementation under test; the shape is exercised via a minimal feed.
      const result = fn(feed as any);

      // Heuristic extraction for the tracked pending verification record;
      // supports a few plausible shapes without binding to internals.
      const trackedSha = (() => {
        const r: any = result ?? {};
        // Common pending container variants
        const containers = [
          r.pendingOutcomeVerification,
          r.pending_outcome_verification,
          r.pending,
          r.verification,
        ].filter(Boolean);

        for (const c of containers) {
          // Map-like by gap id
          if (c && typeof c === "object" && !Array.isArray(c) && (gapId in c)) {
            const row: any = (c as Record<string, unknown>)[gapId as keyof typeof c];
            if (row && (row.sha || row.landingSha || row.landing_sha)) {
              return row.sha ?? row.landingSha ?? row.landing_sha;
            }
          }
          // Array-like rows
          if (Array.isArray(c)) {
            const hit = c.find((x: any) => x && (x.gapId === gapId || x.gap_id === gapId));
            if (hit && (hit.sha || hit.landingSha || hit.landing_sha)) {
              return hit.sha ?? hit.landingSha ?? hit.landing_sha;
            }
          }
        }
        return undefined;
      })();

      // Expected: the earlier, correct landing should be the one tracked for pending verification
      // (the later, wrong one must not displace it). The current defect tracks the LATER one,
      // so this assertion FAILS, reproducing the issue.
      const expectedSha = "2c0aad94";
      expect(trackedSha).toBe(expectedSha);
    } finally {
      // Restore env to avoid affecting other tests.
      if (prevEndpoint === undefined) delete process.env.LLM_VESSEL_ENDPOINT; else process.env.LLM_VESSEL_ENDPOINT = prevEndpoint;
    }
  });
});
