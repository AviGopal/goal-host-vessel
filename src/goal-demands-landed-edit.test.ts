// Pins the landing-evidence rule: an edit goal is reached only by an edit that LANDED,
// never by a description of the edit.
//
// THE DEFECT (2026-08-11). The guard's entry test required a literal repos/<vessel>/<file>
// in the goal TEXT, so a symptom-phrased change request skipped it entirely. Measured on
// live dispatch fac50cf1-f5be-4f6a-924e-478986aeb80e: the goal asked to widen a too-narrow
// check that decides whether an activity template is a redundant re-mint, and came back
//   reached:true, status:completed,
//   completion_shapes = template_audit_report, activityTemplate_update
//   selectedTemplateId = universal-tool-fallback   (the FLOOR, not the compose path)
//   produced shapes    = (none recorded)
//   failure_mode       = execution_error
// while NOTHING changed: origin/dev for activity-api was unmoved and the predicate the
// goal named was byte-identical. The grader scored a REPORT ABOUT the code as the code
// change.
//
// Root cause was that the landing requirement was bound to a ROUTE (edit-intent) rather
// than to the GOAL, so any route bypassing edit-intent — here universal-tool-fallback —
// bypassed the guard. The fix asks the question the door had already answered.
//
// The negative cases are the load-bearing ones. This predicate makes reach verdicts
// STRICTER, so a false positive here turns a legitimately-reached analysis goal into a
// false `reached:no`. Read-only asks must never demand landing evidence.

import { describe, expect, test } from "bun:test";
import { goalDemandsLandedEdit } from "./goal-intent";

describe("goalDemandsLandedEdit — change requests must land", () => {
  test("THE REGRESSION: the live symptom-only goal now demands landing evidence", () => {
    const D5 =
      "The check that decides whether an activity template is a redundant re-mint is too " +
      "narrow and should be widened. It only recognises a template whose id ends in a long " +
      "run of digits, so it merges nothing for templates minted recently, and families of " +
      "templates sharing one name accumulate in the pool and split selection traffic.";
    expect(goalDemandsLandedEdit(D5)).toBe(true);
  });

  test("a path-bearing edit goal still demands it (the original behaviour)", () => {
    expect(goalDemandsLandedEdit(
      "Edit repos/activity-api/src/routes/activities.ts to widen the dedup entry gate",
    )).toBe(true);
  });

  test("the make-a-rule-less-restrictive verbs are recognised", () => {
    for (const verb of ["widen", "broaden", "loosen", "relax", "tighten", "narrow"]) {
      expect(goalDemandsLandedEdit(`${verb} the predicate in the resolver`)).toBe(true);
    }
  });
});

describe("the boundary — read-only asks must NOT demand landing evidence", () => {
  // If any of these flips to true, a legitimately-reached analysis goal starts grading
  // reached:false. That is the failure mode this block exists to prevent.
  test("a report ask does not demand a landed edit", () => {
    expect(goalDemandsLandedEdit(
      "Report how many activity templates were minted this week and summarise the duplicate-name families.",
    )).toBe(false);
  });

  test("an explanation ask does not demand a landed edit", () => {
    expect(goalDemandsLandedEdit(
      "Explain which condition decides that a template is a redundant re-mint.",
    )).toBe(false);
  });

  test("a prose/notes ask does not demand a landed edit", () => {
    expect(goalDemandsLandedEdit(
      "Update my notes about the gap queue and write a summary document.",
    )).toBe(false);
  });

  test("a goal with no mutation verb does not demand a landed edit", () => {
    expect(goalDemandsLandedEdit(
      "The resolver is slow when the pool is large and the posterior is flat.",
    )).toBe(false);
  });

  test("undefined and empty are handled", () => {
    expect(goalDemandsLandedEdit(undefined)).toBe(false);
    expect(goalDemandsLandedEdit("")).toBe(false);
  });
});
