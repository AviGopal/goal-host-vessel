import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  verifyAggregateReport, reportClassFrom, reportClassForTargets, producedContentOf, rowsOf, getPath, REPORT_CLASS_SHAPE,
  type ReportClass,
} from "../src/aggregate-report-verifier";

// Synthetic shapes only: a report class is data, and nothing here names a live goal class.
const CLASS_ROW = {
  target_shape: "widgetLedgerReport",
  sections: [{ field: "per_widget_tallies", source: { shape: "widgetTally", pointer: { metric: "count", window_hours: 24 } }, top_n: 3, rel_drift: 0.05 }],
  required_fields: ["per_widget_tallies", "stray_widgets"],
  abstain_when_true: ["stray_widgets.degraded"],
};
const cls = reportClassFrom(CLASS_ROW) as ReportClass;

const section = (rows: Array<[string, number]>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ shape: "widgetTally", rows: rows.map(([key, value]) => ({ key, value })), ...extra });
const store = (rows: Array<[string, number]>, truncated: boolean, total_groups: number) =>
  ({ shape: "widgetTally", rows: rows.map(([key, value]) => ({ key, value })), truncated, total_groups });

const produced = (rows: Array<[string, number]>, stray: Record<string, unknown> = { count: 1, degraded: false }) =>
  ({ per_widget_tallies: section(rows, { truncated: true, total_groups: 50 }), stray_widgets: stray });

const truth = store([["a", 1000], ["b", 500], ["c", 200], ["d", 10]], true, 50);

describe("aggregate-report faithfulness", () => {
  it("a report that carries the store's rows within drift is faithful, and says it is not a recount", async () => {
    const v = await verifyAggregateReport({ cls, produced: produced([["a", 1010], ["b", 500], ["c", 199]]), fetchSource: async () => truth });
    expect(v?.reached).toBe(true);
    expect(v?.reason).toContain("deterministic:report-faithful");
    expect(v?.reason).toContain("not an independent recount");
  });

  it("MUST-FAIL: a row off by more than the drift is unfaithful", async () => {
    const v = await verifyAggregateReport({ cls, produced: produced([["a", 1000], ["b", 900], ["c", 200]]), fetchSource: async () => truth });
    expect(v?.reached).toBe(false);
    expect(v?.reason).toContain("deterministic:report-unfaithful");
    expect(v?.reason).toContain("row b");
  });

  it("MUST-FAIL: a missing required section is incomplete", async () => {
    const v = await verifyAggregateReport({ cls, produced: { per_widget_tallies: section([["a", 1000], ["b", 500], ["c", 200]]) }, fetchSource: async () => truth });
    expect(v?.reached).toBe(false);
    expect(v?.reason).toContain("deterministic:report-incomplete");
    expect(v?.reason).toContain("stray_widgets");
  });

  it("MUST-FAIL: fewer rows than the class asks for (and the store has) is incomplete", async () => {
    const v = await verifyAggregateReport({ cls, produced: produced([["a", 1000]]), fetchSource: async () => truth });
    expect(v?.reached).toBe(false);
    expect(v?.reason).toContain("has 1 rows");
  });

  it("MUST-FAIL: a row the store's TRUNCATED read cannot confirm abstains (never a guess)", async () => {
    const v = await verifyAggregateReport({ cls, produced: produced([["a", 1000], ["zz", 5], ["c", 200]]), fetchSource: async () => truth });
    expect(v).toBeNull();
  });

  it("a row absent from an UNtruncated store is unfaithful (invented)", async () => {
    const whole = store([["a", 1000], ["b", 500], ["c", 200]], false, 3);
    const v = await verifyAggregateReport({ cls, produced: produced([["a", 1000], ["zz", 5], ["c", 200]]), fetchSource: async () => whole });
    expect(v?.reached).toBe(false);
    expect(v?.reason).toContain("does not exist");
  });

  it("MUST-FAIL: a source that does not state truncated/total_groups abstains (absent is not false)", async () => {
    const bare = { shape: "widgetTally", rows: truth.rows };
    const v = await verifyAggregateReport({ cls, produced: produced([["a", 1000], ["b", 500], ["c", 200]]), fetchSource: async () => bare });
    expect(v).toBeNull();
  });

  it("an unreadable source abstains", async () => {
    expect(await verifyAggregateReport({ cls, produced: produced([["a", 1000], ["b", 500], ["c", 200]]), fetchSource: async () => null })).toBeNull();
    expect(await verifyAggregateReport({ cls, produced: produced([["a", 1000], ["b", 500], ["c", 200]]), fetchSource: async () => { throw new Error("down"); } })).toBeNull();
  });

  it("a field named in abstain_when_true abstains", async () => {
    const v = await verifyAggregateReport({ cls, produced: produced([["a", 1000], ["b", 500], ["c", 200]], { count: 1, degraded: true }), fetchSource: async () => truth });
    expect(v).toBeNull();
  });

  it("a store with fewer groups than top_n needs only that many rows", async () => {
    const small = store([["a", 1000], ["b", 500]], false, 2);
    const v = await verifyAggregateReport({ cls, produced: produced([["a", 1000], ["b", 500]]), fetchSource: async () => small });
    expect(v?.reached).toBe(true);
  });
});

describe("report classes are data", () => {
  it("MUST-FAIL: no class row for the walk's targets means nothing is checked", () => {
    expect(reportClassForTargets([CLASS_ROW], ["someOtherShape"])).toBeNull();
    expect(reportClassForTargets([], ["widgetLedgerReport"])).toBeNull();
    expect(reportClassForTargets([CLASS_ROW], ["widgetLedgerReport"])?.target_shape).toBe("widgetLedgerReport");
  });

  it("a malformed row is unusable rather than half-applied", () => {
    expect(reportClassFrom({ ...CLASS_ROW, sections: [] })).toBeNull();
    expect(reportClassFrom({ ...CLASS_ROW, sections: [{ ...CLASS_ROW.sections[0], rel_drift: 2 }] })).toBeNull();
    expect(reportClassFrom({ ...CLASS_ROW, sections: [{ ...CLASS_ROW.sections[0], top_n: 0 }] })).toBeNull();
    expect(reportClassFrom(JSON.stringify(CLASS_ROW))?.sections.length).toBe(1);
  });

  it("the produced report is read from the latest impulse of the target shape, unwrapping an {emitted, content} envelope", () => {
    const inner = { per_widget_tallies: "[]" };
    expect(producedContentOf([{ shape: "widgetLedgerReport", content: { emitted: "widgetLedgerReport", content: inner } }], "widgetLedgerReport")).toEqual(inner);
    expect(producedContentOf([{ shape: "other", content: inner }], "widgetLedgerReport")).toBeUndefined();
  });

  it("rows and paths read through JSON strings and resolver envelopes", () => {
    expect(rowsOf({ content: JSON.stringify(truth) })?.rows.length).toBe(4);
    expect(rowsOf({ rows: [{ key: "a", value: "x" }] })).toBeNull();
    expect(getPath({ a: JSON.stringify({ b: { c: 3 } }) }, "a.b.c")).toBe(3);
  });

  it("the class-row shape is a generic pool shape", () => {
    expect(REPORT_CLASS_SHAPE).toBe("aggregateReportClass");
  });
});

describe("the hook observes and never decides (source pin)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");
  const at = src.indexOf("void observeAggregateReport(");
  it("fires only on a reused, non-deterministic early reach", () => {
    expect(at).toBeGreaterThan(0);
    const guard = src.slice(Math.max(0, at - 400), at);
    expect(guard).toContain("verdict === earlyReachVerdict && verdict.deterministic !== true");
  });
  it("runs off the walk's path with its failure logged in the catch, before completion shapes are read", () => {
    const after = src.slice(at, at + 600);
    expect(after).toContain(".catch((e) => console.warn(`[report-faithfulness] observe failed");
    expect(src.indexOf("completionShapes = verdict?.completion_shapes ?? null;", at)).toBeGreaterThan(at);
  });
  it("the observer never assigns the verdict", () => {
    const fnAt = src.indexOf("async function observeAggregateReport(");
    const body = src.slice(fnAt, src.indexOf("\n}\n", fnAt));
    expect(body.length).toBeGreaterThan(100);
    expect(/\bverdict\s*=[^=]/.test(body)).toBe(false);
    expect(body).toContain('verdict: "partial"');
  });
});
