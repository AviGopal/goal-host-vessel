// S1: THE ONE-INSTANCE ASSUMPTION IS DELETED, NOT SHADOWED.
//
// The walk kept one impulse per shape (addToPool's early return) and marked a producer tried for the rest of the walk
// (satisfierTried, with a one-shot un-poison for transient failures). Both are replaced by walk-instances.ts: the
// instance key and the attempt ledger. This pins that the old code is gone (identifiers and code lines, the reworded
// comments included) and that both satisfier call sites ask the ledger first. Counted, then asserted.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
const count = (needle: string): number => SRC.split(needle).length - 1;

describe("S1 the old early return is gone", () => {
  test("no first-instance early return, no tried set, no un-poison", () => {
    const gone = [
      "if (!shape || producedShapes.has(shape)) return;",
      "producedShapes.has(shape) || satisfierTried.has(shape)",
      "satisfierTried",
      "satisfierRetry",
      "un-poisoning",
    ];
    const counts = Object.fromEntries(gone.map((g) => [g, count(g)]));
    expect(counts).toEqual(Object.fromEntries(gone.map((g) => [g, 0])));
  });
  test("suppressSatisfierShapes is read once, by the attempt ledger, not by a second seeding loop", () => {
    expect(count("opts.suppressSatisfierShapes ?? []")).toBe(1);
    expect(SRC).toContain("const attemptLedger = new AttemptLedger((opts.suppressSatisfierShapes ?? []).map((s) => `satisfier:${s}`));");
  });
  test("both satisfier call sites ask mayAttempt( first", () => {
    const sat = SRC.indexOf("const resolved = await vesselResolveShape(satisfiableNow);");
    const satStart = SRC.lastIndexOf("const missingForSatisfier = [...target]", sat);
    expect(sat).toBeGreaterThan(0);
    expect(satStart).toBeGreaterThan(0);
    expect(SRC.slice(satStart, sat)).toContain("mayAttempt(");
    const scan = SRC.indexOf("const _vrResolved = await vesselResolveShape(missingShape);");
    const scanStart = SRC.lastIndexOf("let _vrCandidateInjected = false;", scan);
    expect(scan).toBeGreaterThan(0);
    expect(scanStart).toBeGreaterThan(0);
    expect(SRC.slice(scanStart, scan)).toContain("mayAttempt(");
    // and the satisfier itself asks the ledger before anything else
    const inner = SRC.indexOf("const vesselResolveShapeInner = async (shape: string)");
    expect(SRC.slice(inner, inner + 300)).toContain("if (!shape || !(await mayAttempt(shape))) return null; attemptBegin(shape);");
  });
});
