import { describe, expect, it } from "bun:test";

import { missingVerifierGap, verifierFamilyOf } from "./missing-verifier-gap";

describe("verifierFamilyOf — one gap per FAMILY, never per goal", () => {
  it("collapses the same question about different vessels onto one family", () => {
    // These need ONE verifier between them. A per-goal id would flood the store the way
    // reach-gap-* did: 105 rows describing one missing capability.
    const a = verifierFamilyOf("How many subdirectories are there under repos/activity-api/src?");
    const b = verifierFamilyOf("How many subdirectories are there under repos/concept-db/src?");
    expect(a).toBe("subdirectory-count");
    expect(a).toBe(b);
  });

  it("names the three cold families measured at 0-10/12", () => {
    expect(verifierFamilyOf("How many distinct file extensions appear under repos/x/src?")).toBe("distinct-file-extensions");
    expect(verifierFamilyOf("Which TypeScript module under repos/x/src has the most lines? Give its filename."))
      .toBe("largest-module-by-lines");
    expect(verifierFamilyOf("How many sub-directories are under repos/x/src?")).toBe("subdirectory-count");
  });

  it("orders most-specific first, since 'distinct file extensions' also contains 'file'", () => {
    expect(verifierFamilyOf("How many distinct file extensions appear under repos/x/src?"))
      .not.toBe("largest-module-by-lines");
  });

  it("returns null when it cannot name a family — better silent than a junk gap", () => {
    expect(verifierFamilyOf("How many TypeScript modules are under repos/x/src?")).toBeNull();
    expect(verifierFamilyOf("Summarise repos/x")).toBeNull();
  });
});

describe("missingVerifierGap — scope-narrowed, and it carries the lesson", () => {
  it("uses a stable per-family id so re-emission upserts one row", () => {
    const g1 = missingVerifierGap("subdirectory-count", "How many subdirectories under repos/a/src?");
    const g2 = missingVerifierGap("subdirectory-count", "How many subdirectories under repos/b/src?");
    expect(g1.id).toBe("missing-verifier-subdirectory-count");
    expect(g1.id).toBe(g2.id);
  });

  it("names a CONCRETE FILE — a directory gets REFUSED before authoring starts", () => {
    // Observed: "author a verifier in repos/goal-host-vessel/src" produced target=(no-target)
    // and `[fc-grounding] REFUSED ungrounded decompose; targetFiles=[]`. A gap is a goal the
    // system writes to itself, so the same grounding rule binds as for operator goals.
    const g = missingVerifierGap("subdirectory-count", "How many subdirectories under repos/a/src?");
    expect(g.summary).toMatch(/repos\/goal-host-vessel\/src\/index\.ts/);
  });

  it("forbids widening and repeats the decline rule found three times", () => {
    const g = missingVerifierGap("distinct-file-extensions", "How many distinct file extensions under repos/x/src?");
    expect(g.summary).toMatch(/Do NOT expand scope/);
    expect(g.summary).toMatch(/DECLINE any goal whose\s+scope its parse does not represent/);
    // It must not tell the author to re-run the walk's command — that is the self-confirming
    // oracle this session found in three separate places.
    expect(g.summary).toMatch(/NOT by re-running the walk's own command/);
  });
});
