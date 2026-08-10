// Pins the satisfier-pseudo-id guard on pathway reuse.
//
// THE DEFECT: `recommendReachingPath` returns a proven pathway and the recovery
// loop pinned `activities[0]` as `targetTemplateId`. ~40% of recorded path steps
// are `satisfier:<shape>` pseudo-ids and 63.5% of accepted pathways are
// satisfier-ONLY, but the template catalogue contains zero `satisfier:*` rows.
// A pinned target that 404s does NOT fall through to the next candidate (by
// design — running something else than asked is worse), so the dispatch died
// with `template 'satisfier:fs_edit' not found` before any walk step ran.
//
// Imports the REAL module: a re-implemented copy would pass while the shipped
// guard rots.
import { describe, expect, test } from "bun:test";
import { isSatisfierPseudoId, pinnableHead, SATISFIER_PREFIX } from "./pathway-head";

describe("isSatisfierPseudoId", () => {
  test("recognises the pseudo-ids actually seen in stored pathways", () => {
    // These three are verbatim from live `goal_execution_paths.path_activities`.
    expect(isSatisfierPseudoId("satisfier:fs_edit")).toBe(true);
    expect(isSatisfierPseudoId("satisfier:shellResult")).toBe(true);
    expect(isSatisfierPseudoId("satisfier:memoryNote_write")).toBe(true);
  });

  test("a real template id is NOT a pseudo-id", () => {
    expect(isSatisfierPseudoId("activity:⟨auto-bridge-activity_metrics⟩")).toBe(false);
    expect(isSatisfierPseudoId("development-vessel:draft-gap-closing-activity")).toBe(false);
    expect(isSatisfierPseudoId("ribosome-extract")).toBe(false);
  });

  test("requires the separator, so a template merely NAMED satisfier-ish stays pinnable", () => {
    // Over-matching here would strip real templates out of the reuse path and
    // quietly disable pathway reuse — a worse failure than the one being fixed,
    // because it would look like "reuse just never fires".
    expect(isSatisfierPseudoId("satisfier-audit")).toBe(false);
    expect(isSatisfierPseudoId("satisfiers")).toBe(false);
    expect(isSatisfierPseudoId("my-satisfier:fs_edit")).toBe(false);
  });

  test("non-strings are not pseudo-ids rather than throwing", () => {
    expect(isSatisfierPseudoId(undefined)).toBe(false);
    expect(isSatisfierPseudoId(null)).toBe(false);
    expect(isSatisfierPseudoId(42)).toBe(false);
    expect(isSatisfierPseudoId({ id: "satisfier:fs_edit" })).toBe(false);
  });

  test("the prefix constant is the one the walk writes", () => {
    expect(SATISFIER_PREFIX).toBe("satisfier:");
  });
});

describe("pinnableHead", () => {
  test("a satisfier-headed pathway yields NO pin (the crash that was shipping)", () => {
    expect(pinnableHead(["satisfier:fs_edit"])).toBeUndefined();
    expect(pinnableHead(["satisfier:shellResult", "satisfier:memoryNote_write"])).toBeUndefined();
  });

  test("a real-template head is still pinned — reuse must keep working", () => {
    expect(pinnableHead(["activity:⟨x⟩", "satisfier:shellResult"])).toBe("activity:⟨x⟩");
  });

  test("does NOT skip ahead to a later real activity", () => {
    // The walk seeds on the HEAD. Returning `activity:⟨real⟩` here would start a
    // different composition than the pathway proved, which is a silent
    // correctness bug rather than a crash.
    expect(pinnableHead(["satisfier:fs_edit", "activity:⟨real⟩"])).toBeUndefined();
  });

  test("empty and malformed pathways yield no pin rather than throwing", () => {
    expect(pinnableHead([])).toBeUndefined();
    expect(pinnableHead(null)).toBeUndefined();
    expect(pinnableHead(undefined)).toBeUndefined();
    expect(pinnableHead([""])).toBeUndefined();
    expect(pinnableHead([{ not: "a string" }])).toBeUndefined();
  });
});
