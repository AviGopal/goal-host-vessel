import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import * as mod from "../../src/index";

describe("operator authority is inferred from any caller-supplied operator field", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    // Set env vars used by handleRunGoal to construct endpoint URLs, preventing load errors.
    process.env.DISCOVERY_ENDPOINT = "http://discovery-vessel.test/resolve";
    process.env.DEV_VESSEL_ENDPOINT = "http://dev-vessel.test/v2/impulses/resolve";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.DISCOVERY_ENDPOINT;
    delete process.env.DEV_VESSEL_ENDPOINT;
  });

  const mockSuccessfulComposeFetch = mock(
    async (
      url: RequestInfo | URL,
      options?: RequestInit,
    ): Promise<Response> => {
      const urlStr = url.toString();
      const body = options?.body ? JSON.parse(String(options.body)) : {};

      if (
        body.pointer?.type === "vesselCapability" &&
        body.pointer?.shape === "feature_compose"
      ) {
        return new Response(
          JSON.stringify({
            content: {
              vessels: [
                {
                  vesselId: "dev-vessel",
                  endpoint: "http://dev-vessel.test",
                  resolve_endpoint: "/v2/impulses/resolve",
                  owned_repos: ["goal-host-vessel"],
                },
              ],
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.startsWith("http://dev-vessel.test")) {
        return new Response(
          JSON.stringify({
            shape: "feature_compose_result",
            body: {
              summary: "did the thing",
              execution_id: "exec-123",
              success: true,
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ error: `unhandled fetch: ${urlStr}` }),
        { status: 404 },
      );
    },
  );

  it("a request with an `operator` field should expect a `goal_reached_proof` shape", async () => {
    global.fetch = mockSuccessfulComposeFetch;

    const request = new Request("http://localhost/run-goal", {
      method: "POST",
      body: JSON.stringify({
        goal: "edit repos/goal-host-vessel/src/index.ts to add a comment",
        operator: "operator:test-run",
      }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await mod.handleRunGoal(request);
    expect(response.status).toBe(200);
    const responseBody = await response.json();

    // The bug is that `operatorOrigin` work is considered "directed" but the response
    // doesn't ask for the shapes needed to verify it, like `goal_reached_proof`.
    // The failing assertion is that this shape is missing from the response.
    expect(responseBody.expected_output_shapes).toContain("goal_reached_proof");
  });

  it("CONTROL: a request without an `operator` field should not expect a `goal_reached_proof` shape", async () => {
    global.fetch = mockSuccessfulComposeFetch;

    const request = new Request("http://localhost/run-goal", {
      method: "POST",
      body: JSON.stringify({
        goal: "edit repos/goal-host-vessel/src/index.ts to add a comment",
      }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await mod.handleRunGoal(request);
    expect(response.status).toBe(200);
    const responseBody = await response.json();

    // This is the correct, current behavior for non-operator requests.
    // It should not be affected by the fix.
    expect(responseBody.expected_output_shapes).not.toContain(
      "goal_reached_proof",
    );
    expect(responseBody.expected_output_shapes).toContain(
      "feature_compose_result",
    );
  });
});
