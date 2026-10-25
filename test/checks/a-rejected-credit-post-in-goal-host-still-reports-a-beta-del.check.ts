import { describe, it, expect, mock } from "bun:test";
import * as mod from "../../src/index";

describe("credit posting for a reached goal", () => {
  it("reports dBeta: 0 when the backing POST is rejected", async () => {
    const originalFetch = global.fetch;
    global.fetch = mock(async (resource: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
      const url = typeof resource === 'string' ? resource : resource.url;
      if (String(url).includes("/v2/activities/feedback") && options?.method === "POST") {
        return new Response(JSON.stringify({ error: "rejected" }), { status: 500 });
      }
      return originalFetch(resource, options);
    });

    const deltas: Array<{ dAlpha: number, dBeta: number }> = [];
    const mockLearningSink = {
      alphaBetaDelta: (d: { dAlpha: number, dBeta: number }) => {
        deltas.push(d);
      },
    };

    const originalSink = (mod.dispatchContext as any).learningSink;
    (mod.dispatchContext as any).learningSink = mockLearningSink;

    try {
      await mod.deliverReachVerdict("test-execution-123", true, [], "test-origin");

      expect(deltas.length).toBe(1);
      // The defect is that a rejected credit post incorrectly yields dBeta: 1.
      // This assertion will fail until the defect is fixed.
      expect(deltas[0]!.dBeta).toBe(0);
    } finally {
      (mod.dispatchContext as any).learningSink = originalSink;
      global.fetch = originalFetch;
    }
  });
});
