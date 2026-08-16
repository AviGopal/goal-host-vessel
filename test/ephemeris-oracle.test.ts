import { describe, it, expect } from "bun:test";

// THE MEASURED FAILURE THIS ORACLE EXISTS FOR (2026-08-16).
//
// Three dispatches of one goal class — "distance from Earth to <body> right now, in astronomical
// units" — identical phrasing, three bodies:
//
//   Io       -> shellResult @0.90 -> 6.26946016292196  EXACT
//   Europa   -> shellResult @0.95 -> 6.26699189304474  EXACT
//   Ganymede -> web_search  @0.90 -> "approximately 1.49e+8 km (0.993 AU)"  FALSE REACH
//
// Ganymede was graded reached:true because an LLM read a plausible sentence off a content farm.
// 0.993 AU against a true 6.264 AU is off by 6.3x and physically impossible — Ganymede orbits
// Jupiter at ~5.2 AU and can never be 1 AU from Earth. Nothing in the substrate could tell the
// difference, because this family had no independent oracle.
//
// These tests pin the two halves that matter: the GUARD abstains on anything it cannot verify
// (a wrong deterministic verdict carries the authority of a measurement, so it is worse than
// none), and the COMPARISON catches the real error while still passing the two real successes.

const HORIZONS_NAIF_IDS: Record<string, string> = {
  io: "501", europa: "502", ganymede: "503", callisto: "504",
  mercury: "199", venus: "299", mars: "499", jupiter: "599",
  saturn: "699", uranus: "799", neptune: "899", pluto: "999",
  moon: "301", luna: "301", sun: "10",
  titan: "606", enceladus: "602", phobos: "401", deimos: "402", triton: "801",
};

/** Mirrors the guard in verifyEphemerisDistanceReach: returns the NAIF id, or null to abstain. */
function guard(goal: string): string | null {
  const g = goal.toLowerCase();
  const asksDistance = /\b(distance|how far|range)\b/.test(g);
  const asksAu = /\b(astronomical units?|\bau\b)\b/.test(g);
  const asksNow = /\b(right now|currently|now|today|at (the|this) moment|as of (now|today))\b/.test(g);
  if (!asksDistance || !asksAu || !asksNow) return null;
  if (!/\bearth\b/.test(g)) return null;
  const body = Object.keys(HORIZONS_NAIF_IDS).find(
    (b) => new RegExp(`\\b${b}\\b`, "i").test(g) && b !== "earth",
  );
  return body ? HORIZONS_NAIF_IDS[body]! : null;
}

/** Mirrors the comparison: "reached" | "false" | "abstain". */
function compare(expected: number, dig: string): "reached" | "false" | "abstain" {
  const cleaned = dig
    .replace(/\b[0-9a-f]{4,}(?:-[0-9a-f]{4,}){2,}\b/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b/g, " ");
  const claimed = [...new Set((cleaned.match(/\d+\.\d+/g) ?? []).map(parseFloat))].filter((n) =>
    Number.isFinite(n),
  );
  if (claimed.length === 0) return "abstain";
  const tol = Math.abs(expected) * 0.005;
  return claimed.some((n) => Math.abs(n - expected) <= tol) ? "reached" : "false";
}

describe("ephemeris oracle — guard abstains rather than guessing", () => {
  it("fires on the goal class it was built for, mapping the body to its NAIF id", () => {
    expect(guard("What is the distance from Earth to Io right now, in astronomical units?")).toBe("501");
    expect(guard("What is the distance from Earth to Europa currently, in AU?")).toBe("502");
    expect(guard("What is the distance from Earth to Ganymede right now, in astronomical units?")).toBe("503");
  });

  it("ABSTAINS on a definitional question — the prose route owns those", () => {
    expect(guard("Explain what an ephemeris is.")).toBeNull();
    expect(guard("What is an astronomical unit?")).toBeNull();
  });

  it("ABSTAINS without temporal deixis — a non-'now' distance is not this query", () => {
    expect(guard("What is the average distance from Earth to Io in astronomical units?")).toBeNull();
  });

  it("ABSTAINS when the observer is not Earth — a different centre is a different query", () => {
    expect(guard("How far is Pluto right now in astronomical units?")).toBeNull();
  });

  it("ABSTAINS on a body it has no id for, rather than inventing one", () => {
    expect(guard("What is the distance from Earth to Kepler-442b right now, in astronomical units?")).toBeNull();
    expect(guard("What is the distance from Earth to Makemake right now, in astronomical units?")).toBeNull();
  });
});

describe("ephemeris oracle — comparison, against the real measured runs", () => {
  it("PASSES the two dispatches that were genuinely correct", () => {
    expect(compare(6.26946016292196, 'stdout:"6.26946016292196\\n"')).toBe("reached");
    expect(compare(6.26699189304474, 'stdout:"6.26699189304474\\n"')).toBe("reached");
  });

  it("CATCHES the Ganymede false reach — 0.993 AU against a true 6.264", () => {
    expect(
      compare(6.26429020392091, "on average, Ganymede is approximately 1.49e+8 km (0.993 AU) away from Earth"),
    ).toBe("false");
  });

  it("ABSTAINS when the output carries no number at all", () => {
    expect(compare(6.264, "The web search successfully found relevant information.")).toBe("abstain");
  });

  it("does not read a dispatch id or a timestamp as a measurement", () => {
    // The registry oracle learned this the hard way: digit runs inside a UUID scored as the value.
    expect(compare(6.26429020392091, "dispatch dbcddbbe-0622-4eb3-9f0f-20697a60803f at 2026-08-16T22:00 -> 6.2643")).toBe("reached");
    expect(compare(6.26429020392091, "dispatch dbcddbbe-0622-4eb3-9f0f-20697a60803f at 2026-08-16T22:00")).toBe("abstain");
  });

  it("tolerance is tight enough to matter and loose enough for rounding", () => {
    // 0.5% of 6.264 is ~0.031 AU, so the boundary sits between 6.28 and 6.30.
    expect(compare(6.264, "6.2645")).toBe("reached"); // a rounded correct answer is accepted
    expect(compare(6.264, "6.28")).toBe("reached");   // 0.26% off — inside tolerance
    expect(compare(6.264, "6.30")).toBe("false");     // 0.57% off — rejected
    expect(compare(6.264, "0.993")).toBe("false");    // the real failure: 84% off
  });
});
