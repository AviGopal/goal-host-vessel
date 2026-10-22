import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

describe("route-edit-37441b1c — deterministic compute must execute the exact procedure", () => {
  it("prefers shellResult evidence over generated guesses: lettercount(incontrovertible) === 16", async () => {
    // Evidence: a shellResult tool call that computes the true value.
    const dig = [
      JSON.stringify({
        tool: "shellResult",
        command: "printf 'incontrovertible' | wc -m",
        stdout: "16\n",
        stderr: ""
      }),
    ].join("\n");

    // Call through exported surface; the check must read shellResult and accept the exact value.
    const res = await Promise.resolve(
      (mod as any).verifyDeterministicCompute("lettercount incontrovertible", dig)
    );

    // Fails under the defect: universal fallback generates 17 instead of accepting the shellResult=16.
    expect(res).toBe(true);
  });
});
