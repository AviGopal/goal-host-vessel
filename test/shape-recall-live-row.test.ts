// A RECALLED ROW AS THE LIVE ENGINE RETURNS IT NAMES ITS SHAPE (B2 live .check, 2026-10-17). concept is SCHEMAFULL and
// `pointer` is a plain object, so SurrealDB drops pointer.name on write: no live recall row carries it. entryOf read the
// name ONLY from pointer.name, so every recalled row was skipped ("no recalled shape is advertised here"), recall ran on
// the degraded tier, and the target chooser (which runs only on the recall tier) never ran: 17 of 17 recalls on node1
// since 2026-10-16 were degraded and no goal was ever answered NOVEL. test/shape-recall.test.ts's fixture row carries
// pointer.name, a shape the engine never returns, so it could not see this.
// MUST-FAIL at the parent 944a5c1: contentShapeName does not exist and a live-shaped row yields the degraded tier.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as sr from "../src/shape-recall";

const recalledCandidates = sr.recalledCandidates;
const contentShapeName = (sr as unknown as { contentShapeName?: (c: unknown) => string | null }).contentShapeName ?? (() => null);
/** A row exactly as recall returns it from the live engine: content and summary survive, pointer's nested fields do not. */
const liveRow = (name: string, desc: string, pointer: Record<string, unknown> | undefined = {}) => ({ content: `${name}: ${desc}`, summary: `${name}: ${desc}`.slice(0, 300), ...(pointer ? { pointer } : {}) });

describe("a live-shaped recall row", () => {
  it("[MUST-FAIL] a row with no pointer.name (as the engine returns it) is recalled by the name its content carries", () => {
    const c = recalledCandidates([liveRow("widgetLedger_tally", "Counts widgets per category: one row each."), liveRow("ghost_shape", "Not advertised here.", undefined)], [], new Set(["widgetLedger_tally", "shellResult"]));
    expect(c.tier).toBe("recall");
    expect(c.shapes).toEqual(["widgetLedger_tally"]);
    expect(c.catalog["widgetLedger_tally"]!.description).toBe("Counts widgets per category: one row each.");
  });

  it("[MUST-FAIL] contentShapeName reads every name concept-db's indexedContent writes (plain, dotted, colon-namespaced)", () => {
    for (const n of ["fileContent", "gapLearningCredit_write", "development-vessel:feature_compose", "a.b", "x@y"]) {
      expect(contentShapeName(`${n}: a description: with a colon inside`)).toBe(n);
    }
  });

  it("[CONTROL] content without the format names nothing, and is never recalled", () => {
    expect(contentShapeName("no separator here")).toBeNull();
    expect(contentShapeName(": starts with separator")).toBeNull();
    expect(contentShapeName("has space: description")).toBeNull();
    expect(contentShapeName(undefined)).toBeNull();
    const c = recalledCandidates([{ content: "free text with no name", pointer: {} }], [], new Set(["a"]));
    expect(c.tier).toBe("degraded");
  });

  it("[CONTROL] a row that does still carry pointer.name keeps working (older rows, other writers)", () => {
    const c = recalledCandidates([{ content: "a description with no prefix", pointer: { name: "a" } }], [], new Set(["a"]));
    expect(c.shapes).toEqual(["a"]);
  });

  it("[WIRING] entryOf reads the content name first; the content format pinned is the one concept-db writes", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "shape-recall.ts"), "utf8");
    expect(src).toContain("const name = contentShapeName(row.content) ?? (typeof row.pointer?.name === \"string\" ? row.pointer.name : \"\");");
  });
});
