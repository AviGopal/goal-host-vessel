/**
 * The persistence readback's concept-db id-read fallback carries this vessel's credential (concept-db scopes id reads
 * to the caller's org, so an uncredentialed read of goal-host's own concept answers "not found"), and it is logged.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

describe("persistence readback fallback", () => {
  test("[WIRING MF] the concept-db id read sends the ApiKey and is logged", () => {
    const i = src.indexOf("fetch(`${ep.endpoint}/concepts/${id}`");
    expect(i).toBeGreaterThan(0);
    const call = src.slice(i, i + 300);
    expect(call).toContain("headers: API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {}");
    expect(src.slice(i - 400, i)).toContain("persistence readback: shaped reads did not confirm");
  });
  test("[CONTROL] there is exactly one such id read (no second uncredentialed copy)", () => {
    expect(src.split("fetch(`${ep.endpoint}/concepts/${id}`").length - 1).toBe(1);
  });
});
