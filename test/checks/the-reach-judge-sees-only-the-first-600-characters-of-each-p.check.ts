import { describe, test, expect } from "bun:test";
import * as mod from "../../src/index.js";

// Build the same style of digest described in the defect:
// "- <shape>: " + first 600 chars of JSON content for each impulse; joined and capped at 4000.
function cappedJson(v: unknown): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.slice(0, 600);
}

function buildDigest(entries: Array<{ shape: string; content: unknown }>): string {
  const lines = entries.map((e) => `- ${e.shape}: ${cappedJson(e.content)}`);
  return lines.join("\n").slice(0, 4000);
}

// Reach the judge through the module namespace with a narrow cast so this check compiles
// regardless of whether the export's declaration happens to be in scope for TS.
type JudgeFn = (goal: string, digest: string) => unknown;

function judgeFn(): JudgeFn {
  const m = mod as unknown as Record<string, unknown>;
  const fn = m["verifyDeterministicCompute"];
  if (typeof fn !== "function") {
    throw new Error("verifyDeterministicCompute is not exported from src/index.ts");
  }
  return fn as JudgeFn;
}

function reachedOf(v: unknown): boolean {
  return !!v && typeof v === "object" && (v as Record<string, unknown>)["reached"] === true;
}

// The failing case: a decisive field ("verdict": "red_code_reachable") comes AFTER a variable-length preamble
// (23-entry only_tests array etc.), so the 600-char cut omits it. The judge then mis-grades a correct run.
describe("reach judge digest truncation — regression", () => {
  test("omits decisive field beyond 600 chars → expected reached", () => {
    const onlyTests = Array.from({ length: 23 }, (_, i) => `test-${i}-${"x".repeat(30)}`);
    const largeOwnCheckBaseline = {
      id: "exec-123",
      files: Array.from({ length: 40 }, (_, i) => `file-${i}.ts`),
      only_tests: onlyTests,
      verdict: "red_code_reachable",
    };
    const dig = buildDigest([{ shape: "ownCheckBaseline", content: largeOwnCheckBaseline }]);

    // Assert through a public export: the judge grades a goal from a content digest and returns a verdict.
    // The expected value states the intended behaviour after the fix: reached should be true for this digest.
    const v = judgeFn()("walk-end reach judge grades a goal from a content digest", dig);
    expect(reachedOf(v)).toBe(true);
  });
});

// CONTROL: decisive field serialises within the first 600 characters; behaviour must stay the same now and after fix.
describe("reach judge digest truncation — control", () => {
  test("decisive field visible within 600 chars → reached", () => {
    const smallOwnCheckBaseline = {
      verdict: "red_code_reachable",
      only_tests: ["smoke-A", "smoke-B"],
      note: "short preamble keeps the decisive field visible",
    };
    const dig = buildDigest([{ shape: "ownCheckBaseline", content: smallOwnCheckBaseline }]);

    const v = judgeFn()("walk-end reach judge grades a goal from a content digest", dig);
    expect(reachedOf(v)).toBe(true);
  });
});
