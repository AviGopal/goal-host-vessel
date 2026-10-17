/**
 * J2a: needs_information is the LAST resort (src/needs-information.ts). The trigger is structural: a required input
 * the resolver named, that the pool bind AND the tool investigation both failed to derive, on a dispatch that did not
 * reach. Every must-fail has its control, a paraphrase set, and the held-out cases that prove the trigger is neither
 * "a refusal happened" nor wording.
 */
import { describe, test, expect } from "bun:test";
import { UnboundInputs, needsInformationOutcome, questionFor } from "../src/needs-information";
import { requiredFieldsFromCorrection } from "../src/bind-args";

const refuse = (rec: UnboundInputs, shape: string, refusal: string) => {
  const fields = requiredFieldsFromCorrection(refusal);
  rec.noteUnderived(shape, fields, "pool_bind");
  rec.noteUnderived(shape, fields, "investigation");
};

describe("needs_information", () => {
  test("[MF] a required input the resolver named, underived by the pool and by the investigation, on a not-reached dispatch, is NEEDS_INFORMATION naming it and what was tried", () => {
    const rec = new UnboundInputs();
    refuse(rec, "fileContent", "path is required");
    expect(needsInformationOutcome(rec, false)).toEqual({ kind: "needs_information", reason: "unbound_input", missing: [{ shape: "fileContent", field: "path", tried: ["pool_bind", "investigation"] }] });
  });

  test("[PARAPHRASE] three refusal wordings the resolver may use name the same missing input", () => {
    for (const r of ["error: pointer.path is required", "Bad request — path and encoding are required", "validation failed: path is required (string)"]) {
      const rec = new UnboundInputs();
      refuse(rec, "fileContent", r);
      expect(needsInformationOutcome(rec, false)?.missing.map((m) => m.field)).toContain("path");
    }
  });

  test("[CONTROL] the same refusal on a dispatch that REACHED carries no outcome", () => {
    const rec = new UnboundInputs();
    refuse(rec, "fileContent", "path is required");
    expect(needsInformationOutcome(rec, true)).toBeUndefined();
  });

  test("[HELD-OUT] refused on attempt 1, ACCEPTED on attempt 2 (the path was in the goal after all): no outcome, so the trigger is not 'a refusal happened'", () => {
    const rec = new UnboundInputs();
    refuse(rec, "fileContent", "path is required");
    rec.noteAccepted("fileContent");
    expect(needsInformationOutcome(rec, false)).toBeUndefined();
  });

  test("[DERIVE BEFORE ASK] an input the INVESTIGATION derived from the environment is never asked for, even if the dispatch then fails", () => {
    const rec = new UnboundInputs();
    rec.noteUnderived("fileContent", ["path"], "pool_bind");
    rec.noteDerived("fileContent", "path"); // the investigation found it
    expect(needsInformationOutcome(rec, false)).toBeUndefined();
  });

  test("[DERIVE BEFORE ASK] an input only the POOL bind was tried for (no investigation ran) is not asked for", () => {
    const rec = new UnboundInputs();
    rec.noteUnderived("fileContent", ["path"], "pool_bind");
    expect(needsInformationOutcome(rec, false)).toBeUndefined();
  });

  test("[DERIVE BEFORE ASK, paraphrase] an input the pool supplied (an existing impulse carries it) is not asked for", () => {
    const rec = new UnboundInputs();
    rec.noteUnderived("fileContent", ["path"], "investigation");
    rec.noteDerived("fileContent", "path"); // bound from the pool on the next synthesis
    expect(needsInformationOutcome(rec, false)).toBeUndefined();
  });

  test("[HELD-OUT] a vague but fully parameterised goal (no refusal for a required input at all) never asks, whatever its wording", () => {
    expect(needsInformationOutcome(new UnboundInputs(), false)).toBeUndefined();
    expect(needsInformationOutcome(undefined, false)).toBeUndefined();
  });

  test("[UNIT] only the missing fields are reported; a second shape's accepted attempt does not clear the first", () => {
    const rec = new UnboundInputs();
    refuse(rec, "fileContent", "path and encoding are required");
    rec.noteDerived("fileContent", "encoding");
    refuse(rec, "other", "x is required");
    rec.noteAccepted("other");
    const o = needsInformationOutcome(rec, false)!;
    expect(o.missing.map((m) => `${m.shape}.${m.field}`)).toEqual(["fileContent.path"]);
    expect(questionFor(o)).toContain("`path`");
    expect(questionFor(o)).toContain("tried: pool_bind, investigation");
  });
});
