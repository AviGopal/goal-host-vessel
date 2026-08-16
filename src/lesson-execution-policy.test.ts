import { describe, expect, test } from "bun:test";
import {
  isUsablePolicy,
  lessonExecutionPolicyPath,
  resolveLessonExecutionPolicy,
} from "./lesson-execution-policy";

// This gate decides whether autonomously-authored text gets a DETERMINISTIC path to the shell
// rather than a persuasion-dependent one. The tests that matter are the ones asserting it stays
// SHUT: every ambiguous, coerced, malformed or absent input must resolve to null, because the
// consumer treats a successful resolve as authority and null as "keep failing closed".

describe("isUsablePolicy — only the literal boolean true enables", () => {
  test("accepts verbatimCommands: true", () => {
    expect(isUsablePolicy({ verbatimCommands: true })).toBe(true);
  });

  test("REFUSES truthy non-booleans — no coercion on this switch", () => {
    for (const v of ["true", "TRUE", "yes", 1, [1], {}, "1"]) {
      expect(isUsablePolicy({ verbatimCommands: v })).toBe(false);
    }
  });

  test("REFUSES explicit false, absent, and unrelated keys", () => {
    expect(isUsablePolicy({ verbatimCommands: false })).toBe(false);
    expect(isUsablePolicy({})).toBe(false);
    expect(isUsablePolicy({ verbatim_commands: true })).toBe(false);
    expect(isUsablePolicy({ enabled: true })).toBe(false);
  });

  test("REFUSES non-objects", () => {
    for (const v of [null, undefined, true, "true", 1, [true]]) {
      expect(isUsablePolicy(v)).toBe(false);
    }
  });
});

describe("resolveLessonExecutionPolicy — fails closed on everything ambiguous", () => {
  test("absent file resolves null (the normal, safe case)", async () => {
    expect(await resolveLessonExecutionPolicy("/ws", async () => { throw new Error("ENOENT"); })).toBeNull();
  });

  test("malformed JSON resolves null — a corrupt file must not enable", async () => {
    expect(await resolveLessonExecutionPolicy("/ws", async () => "{not json")).toBeNull();
  });

  test("a policy that disables resolves null, so the consumer keeps its own default", async () => {
    expect(await resolveLessonExecutionPolicy("/ws", async () => JSON.stringify({ verbatimCommands: false }))).toBeNull();
  });

  test('the string "true" does NOT enable', async () => {
    expect(await resolveLessonExecutionPolicy("/ws", async () => JSON.stringify({ verbatimCommands: "true" }))).toBeNull();
  });

  test("an explicitly enabling policy is served", async () => {
    expect(await resolveLessonExecutionPolicy("/ws", async () => JSON.stringify({ verbatimCommands: true })))
      .toEqual({ verbatimCommands: true });
  });
});

describe("lessonExecutionPolicyPath", () => {
  test("resolves under the supplied workspace root", () => {
    expect(lessonExecutionPolicyPath("/ws")).toBe("/ws/policies/lesson-execution-policy.json");
  });

  test("honours WORKSPACE_ROOT, which is /workspace/git/super-repo on goal-host's unit", () => {
    const prev = process.env["WORKSPACE_ROOT"];
    process.env["WORKSPACE_ROOT"] = "/workspace/git/super-repo";
    try {
      expect(lessonExecutionPolicyPath()).toBe("/workspace/git/super-repo/policies/lesson-execution-policy.json");
    } finally {
      if (prev === undefined) delete process.env["WORKSPACE_ROOT"];
      else process.env["WORKSPACE_ROOT"] = prev;
    }
  });
});
