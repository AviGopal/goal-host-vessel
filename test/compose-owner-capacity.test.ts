// SEVERAL COMPOSE OWNERS, AND THE ONE WITH FREE SLOTS TAKES THE EDIT (REALIGNMENT §4, law 11; user ruling: several
// owners, serialised by the landing lease). goal-host routed an edit-intent goal by ownership only when exactly one
// producer owned the repo; with more it filed a "compose-ownership-duplicate" gap (its own rule that a second owner is a
// defect, duplicating development-vessel's ownership decision) and picked by priority over EVERY row, capacity-blind, so
// a full owner took the edit and answered BUSY while another owner sat idle.
//
//   [MUST-FAIL] two eligible owners, the preferred one full: the pick is the owner with free slots.
//   [MUST-FAIL] index.ts files no duplicate-owner gap, reads the owners' free slots and picks with pickComposeOwner at
//               both edit-intent sites.
//   [CONTROL]   one owner is picked as today (full or not); no owner observably free keeps the priority pick among the
//               owners; the most free slots wins.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as SP from "../src/satisfier-pick";

const SRC = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const pick = (SP as Record<string, any>)["pickComposeOwner"] as (<T extends SP.SatisfierProducer>(o: T[], f: (o: T) => number | null) => T | undefined) | undefined;
type Row = SP.SatisfierProducer & { vesselId: string; compose_free: number | null };
const row = (vesselId: string, compose_free: number | null, priority = 0): Row => ({ endpoint: `http://${vesselId}.invalid`, vesselId, compose_free, priority });
const free = (r: Row) => r.compose_free;

describe("a repo's compose owners: the one with free slots takes the edit", () => {
  it("[MUST-FAIL] two eligible owners, the preferred one full: the owner with free slots is picked", () => {
    expect(typeof pick).toBe("function");
    expect(pick!([row("dv-a", 0, 5), row("dv-b", 1, 0)], free)?.vesselId).toBe("dv-b");
    expect(pick!([row("dv-a", 0, 5), row("dv-b", null, 9), row("dv-c", 2, 0)], free)?.vesselId).toBe("dv-c");
  });

  it("[MUST-FAIL] index.ts: no duplicate-owner gap, free slots read, pickComposeOwner at both edit-intent sites", () => {
    expect(SRC).not.toContain("compose-ownership-duplicate-");
    expect(SRC).not.toContain("_dupOwnerFiled");
    expect(SRC).toContain("await readComposeFreeSlots(earlyOwners, earlyAllFiles);");
    expect(SRC).toContain("await readComposeFreeSlots(owners, allEditFiles);");
    expect(SRC).toContain("const earlyV = earlyOwners.length > 0 ? pickComposeOwner(earlyOwners,");
    expect(SRC).toContain("const v = owners.length > 0 ? pickComposeOwner(owners,");
    // the free-slot read is the existing composeOwnership placement read (targets on the pointer), not a new shape
    expect(SRC).toContain('body: JSON.stringify({ impulse: { pointer: { type: "composeOwnership", targets } } })');
  });

  it("[CONTROL] one owner is today's route; none observably free keeps the priority pick among owners; most free wins", () => {
    expect(typeof pick).toBe("function");
    expect(pick!([row("dv-a", 0, 0)], free)?.vesselId).toBe("dv-a");
    expect(pick!([], free)).toBeUndefined();
    expect(pick!([row("dv-a", 0, 1), row("dv-b", null, 3)], free)?.vesselId).toBe("dv-b"); // priority, as pickSatisfierProducer
    expect(pick!([row("dv-a", 1, 9), row("dv-b", 3, 0)], free)?.vesselId).toBe("dv-b");
    expect(pick!([row("dv-a", 2, 9), row("dv-b", 2, 0)], free)?.vesselId).toBe("dv-a"); // a tie goes to the priority pick
  });
});
