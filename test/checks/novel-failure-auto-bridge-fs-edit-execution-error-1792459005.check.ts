import { describe, it, expect } from "bun:test";
import * as mod from "../../src/index";

describe("fs_edit outside root is classified as no_task (not execution_error)", () => {
  it("returns type 'no_task' with the 500 path-outside-root reason", () => {
    const anyMod = mod as any;
    // Ensure we're exercising the exported function from src/index.ts
    expect(typeof anyMod.walkFailureMode).toBe("function");

    // This mirrors the failure evidence: HTTP 500 + "path outside workspace root"
    const finalReason = 'HTTP 500: {"success":false,"error":"path outside workspace root: /vessels/goal-host-vessel/src/index.ts"}';

    // Drive the classification with an empty walk log so the branch that returns
    // the current buggy { type: "execution_error", reason: ... } executes.
    const mode = anyMod.walkFailureMode([], finalReason);

    // The correct classification should be 'no_task' (not 'execution_error').
    // This assertion fails today because the code returns type: "execution_error".
    expect(mode && typeof mode === "object" ? mode.type : undefined).toBe("no_task");

    // The reason should still carry the HTTP 500 envelope (behavioural check that remains valid after the fix).
    expect(typeof (mode && mode.reason)).toBe("string");
    expect(String(mode && mode.reason)).toContain("HTTP 500");
  });
});

describe("control: composeReportReason on empty body", () => {
  it("returns empty string for null", () => {
    const anyMod = mod as any;
    expect(typeof anyMod.composeReportReason).toBe("function");
    const s = anyMod.composeReportReason(null);
    expect(s).toBe("");
  });
});
