// Pins the reach-digest substance filter (task #59).
//
// THE VERDICT THIS EXISTS FOR: a report goal graded REACHED when the only thing
// produced was `{producedBy, executionId}` — a receipt that something ran, not
// the report that was asked for. The digest handed to the reach gate was built
// from any impulse whose content was non-null, and a stub serialises to a
// perfectly plausible string.
//
// Most of these assert what must STILL PASS. Over-filtering is the worse
// direction: dropping a genuine output makes real work read as hollow, which is
// how a working system gets graded as broken.
import { describe, expect, test } from "bun:test";
import { isBookkeepingOnly } from "./bookkeeping-only";

describe("isBookkeepingOnly", () => {
  test("REJECTS the exact stub from the filed verdict", () => {
    expect(isBookkeepingOnly({ producedBy: "satisfier:code_read", executionId: "exec_002" })).toBe(true);
  });

  test("rejects an empty object — it carries nothing at all", () => {
    expect(isBookkeepingOnly({})).toBe(true);
  });

  test("rejects provenance in either casing", () => {
    // snake_case and camelCase both appear in trace payloads; a filter that
    // knew only one spelling would leak half the stubs.
    expect(isBookkeepingOnly({ produced_by: "x", execution_id: "y", trace_id: "z" })).toBe(true);
  });

  test("KEEPS content with even one substantive field", () => {
    // Partial content is still content. Judging quality is the substance gate's
    // job downstream; this filter only removes pure receipts.
    expect(isBookkeepingOnly({ producedBy: "x", executionId: "y", rows: [1, 2, 3] })).toBe(false);
    expect(isBookkeepingOnly({ executionId: "y", summary: "the report" })).toBe(false);
  });

  test("KEEPS non-object content untouched", () => {
    // A string, a number or an array is content by construction — only objects
    // can be all-bookkeeping.
    expect(isBookkeepingOnly("a real answer")).toBe(false);
    expect(isBookkeepingOnly(42)).toBe(false);
    expect(isBookkeepingOnly([{ producedBy: "x" }])).toBe(false);
    expect(isBookkeepingOnly(null)).toBe(false);
    expect(isBookkeepingOnly(undefined)).toBe(false);
  });

  test("KEEPS a report whose fields merely resemble metadata", () => {
    // `count` and `files` are not in the bookkeeping set and must never be —
    // they are exactly what a counting/report goal produces.
    expect(isBookkeepingOnly({ count: 12, files: ["a.ts"] })).toBe(false);
  });
});
