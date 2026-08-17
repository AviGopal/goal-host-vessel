import { describe, it, expect } from "bun:test";

// THE MEASURED FAILURE (2026-08-17).
//
// The registry-count oracle harvested claimed numbers with \b\d{1,7}\b after stripping only
// UUID-shaped runs and long hex. Every vessel_health_report body carries
//
//     "discovery":{"registered":true,"endpoint":"http://127.0.0.1:8210", ...}
//
// so the scan read 127 out of the loopback address and reported it as the claimed count:
//
//     deterministic:wrong-registry-count — independently queried registry totalShapes=368,
//     but the output reports 127
//
// A health report is in the chain of essentially every compositional goal about the fleet, so
// this deterministically FAILED CORRECT COMPOSITIONS — twice measured, once with the field
// selection already fixed, which is what isolated it as an extraction defect rather than a
// field-selection one. A false rejection is worse than a missed green: it β-penalises an arm
// that computed the right answer.
//
// The same partial sanitiser was copy-pasted into the git-commit-count oracle (harvesting
// \b\d{1,9}\b), which has the identical defect and was simply never hit, and a third variant
// in the ephemeris oracle strips UUIDs and ISO timestamps but not addresses. Three private
// copies, each missing a different exclusion, is why this class keeps reappearing somewhere
// new after being fixed in the last place. See gap
// `three-oracles-duplicate-a-partial-numeric-sanitiser` for the shared-sanitiser refactor.
//
// These tests pin the behaviour at BOTH call sites by reading the shipped source, so a future
// edit that drops a strip pass fails here rather than silently resurrecting the false
// rejections. Reading the source rather than re-implementing the regex is deliberate: a test
// against a copied constant passes while the shipped code is broken, which is the defect this
// file exists to prevent.

const SRC = new URL("../src/index.ts", import.meta.url);

/** The two strip passes added on 2026-08-17, in the form they ship. */
const URL_STRIP = String.raw`.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, " ")`;
const IPV4_STRIP = String.raw`.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, " ")`;

async function source(): Promise<string> {
  return await Bun.file(SRC).text();
}

/** Mirrors the shipped scan: strip, then harvest digit runs of the given width. */
function claimed(dig: string, maxDigits: number): string[] {
  const cleaned = dig
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, " ")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, " ")
    .replace(/\b[0-9a-f]{4,}(?:-[0-9a-f]{4,}){2,}\b/gi, " ")
    .replace(/\b[0-9a-f]{16,}\b/gi, " ");
  const re = new RegExp(String.raw`\b\d{1,${maxDigits}}\b`, "g");
  return [...new Set(cleaned.match(re) ?? [])];
}

/** The real shape of a vessel_health_report body, trimmed to the part that broke the scan. */
const HEALTH_REPORT =
  '{"success":true,"shape":"vessel_health_report","body":{"vessel_id":"goal-host-vessel",' +
  '"overall_health":"healthy","discovery":{"registered":true,"endpoint":"http://127.0.0.1:8210"}}}' +
  ' {"shape":"shellResult","stdout":"368\\n"}';

describe("numeric sanitiser — both oracles strip addresses before harvesting", () => {
  it("the registry-count oracle carries both strip passes", async () => {
    const src = await source();
    // The registry oracle is the one harvesting \d{1,7}. Locate its scan and assert the
    // strips precede it, rather than merely asserting the strips exist somewhere in a
    // 15,000-line file — which would pass if they were added only to the sibling.
    const idx = src.indexOf(String.raw`(digIds.match(/\b\d{1,7}\b/g)`);
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, idx - 600), idx);
    expect(block).toContain(URL_STRIP);
    expect(block).toContain(IPV4_STRIP);
  });

  it("the git-commit-count oracle carries both strip passes", async () => {
    const src = await source();
    const idx = src.indexOf(String.raw`(digIds.match(/\b\d{1,9}\b/g)`);
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, idx - 600), idx);
    expect(block).toContain(URL_STRIP);
    expect(block).toContain(IPV4_STRIP);
  });
});

describe("numeric sanitiser — the measured failure does not recur", () => {
  it("THE REGRESSION: 127 is no longer harvested from the loopback endpoint", () => {
    // Before the fix this returned ["127","0","1","8210","368"] and the verdict reported 127.
    expect(claimed(HEALTH_REPORT, 7)).toEqual(["368"]);
  });

  it("holds at the git oracle's wider digit range too", () => {
    expect(claimed(HEALTH_REPORT, 9)).toEqual(["368"]);
  });

  it("strips the port along with the host, not just the address", () => {
    // Stripping the whole URL is what removes 8210; an IPv4-only strip would leave the port
    // behind and a port has already been misread as a count on this substrate once.
    expect(claimed('see http://127.0.0.1:8210/health — total 42', 7)).toEqual(["42"]);
  });

  it("still strips dispatch ids and long hex, which the earlier fix added", () => {
    expect(claimed("dispatch dbcddbbe-0622-4eb3-9f0f-20697a60803f produced 11", 7)).toEqual(["11"]);
  });

  it("does not eat legitimate values that merely sit near an address", () => {
    // The point of the fix is to remove address noise, not to suppress real answers; a
    // sanitiser that swallowed the true value would turn a false rejection into a false
    // reach, which is the worse trade.
    expect(claimed('endpoint http://localhost:8090 reports 305 shapes', 7)).toEqual(["305"]);
    expect(claimed("the registry advertises 368 shapes across 13 vessels", 7)).toEqual(["368", "13"]);
  });

  it("a bare dotted quad with no scheme is still stripped", () => {
    expect(claimed("peer 10.0.0.7 returned 99", 7)).toEqual(["99"]);
  });

  it("KNOWN LIMIT: a bare host:port with no scheme keeps its port", () => {
    // Recorded rather than papered over. Closing it needs a host:port pattern that cannot
    // also match a legitimate "ratio 3:4" or a timestamp fragment, which is a wider change
    // than the measured failure justified.
    expect(claimed("localhost:8090 reported 42", 7)).toContain("8090");
  });
});

// THE EPHEMERIS ORACLE IS THE DANGEROUS ONE (added 2026-08-17).
//
// The registry and git-commit oracles compare by SET MEMBERSHIP — `claimed.includes(expected)` —
// so a contaminant can only corrupt the failure message, never the verdict. The ephemeris oracle
// compares by TOLERANCE:
//
//     const hit = claimed.find((n) => Math.abs(n - expected) <= tol);
//
// and it harvests decimals with /\d+\.\d+/. So "http://127.0.0.1:8210" yields the candidates
// 127.0 and 0.1, and a goal whose true answer is near 0.1 AU MATCHES on a loopback address that
// carries no measurement at all. That is a false REACH, not a bad message — the failure mode this
// whole document argues is the worse one, because a false green teaches the learner that a
// composition worked.

/** Mirrors the ephemeris scan after the fix: strip, then harvest decimals. */
function auCandidates(dig: string): number[] {
  const cleaned = dig
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, " ")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, " ")
    .replace(/\b[0-9a-f]{4,}(?:-[0-9a-f]{4,}){2,}\b/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b/g, " ");
  return [...new Set((cleaned.match(/\d+\.\d+/g) ?? []).map(parseFloat))].filter((n) => Number.isFinite(n));
}

const WITH_ENDPOINT = 'report {"endpoint":"http://127.0.0.1:8210"} distance 6.264 AU';

describe("ephemeris oracle — a loopback address is not a measurement", () => {
  it("the ephemeris scan carries both strip passes", async () => {
    const src = await Bun.file(SRC).text();
    const idx = src.indexOf(String.raw`(cleaned.match(/\d+\.\d+/g)`);
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, idx - 700), idx);
    expect(block).toContain(URL_STRIP);
    expect(block).toContain(IPV4_STRIP);
  });

  it("THE FALSE REACH: 0.1 no longer matches on 127.0.0.1 alone", () => {
    // Before the fix, auCandidates included 0.1 and 127.0 from the endpoint, so a goal whose
    // true answer was near 0.1 AU reached on a string containing no measurement.
    const tol = 0.1 * 0.005;
    expect(auCandidates(WITH_ENDPOINT).some((n) => Math.abs(n - 0.1) <= tol)).toBe(false);
  });

  it("the real measurement still matches", () => {
    const tol = 6.264 * 0.005;
    expect(auCandidates(WITH_ENDPOINT).some((n) => Math.abs(n - 6.264) <= tol)).toBe(true);
  });

  it("timestamps are still stripped, as the earlier fix established", () => {
    expect(auCandidates("at 2026-08-17T08:12 the range was 6.264 AU")).toEqual([6.264]);
  });
});
