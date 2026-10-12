// A CAPTURED ROUTING RECORD IS REPLAYABLE: it carries every field a replay of the edit-intent route reads, never a
// default. Beyond the §A3 fields (unchanged) that is:
//   - route_enabled: the early edit-intent switch as the hand-off check read it (in-process, at the call site);
//   - localization: the localizationRecord the routing read, or null, ALWAYS present as a key;
//   - resolution.candidates[i].prefer_call_sites: the term search is keyed by it;
//   - resolution.reads[i].text: what the resolver read (null when unreadable), capped per read; a cut read is marked
//     and makes the record `capped` (a capped record does not replay as recorded);
//   - gap_hint.summary when the hydration was applied (the routing goal is built from it).
import { describe, expect, test } from "bun:test";
import {
  CAPTURE_READ_CAP_CHARS, CAPTURE_TRUNCATION_MARKER, attachRoutingInput, noteGapHydration, noteRouteEnabled,
  noteRoutingHandOff, routingRecorder, withCaptureTarget, type CaptureTarget, type RoutingInputRecord,
} from "../../src/judge/capture";
import { resolvePathlessCodeChangeGoal } from "../../src/goal-file-resolution";

const PATHLESS = "Fix the retry budget so the backoff helper stops retrying after three attempts";
const FILE = "repos/example-vessel/src/backoff.ts";
const TEXT = "export const backoffHelper = (n: number) => n;\nconst label = 'backoff helper';\n";

async function pathless(readText: string | undefined): Promise<RoutingInputRecord> {
  const rr = routingRecorder();
  const out = await resolvePathlessCodeChangeGoal(
    PATHLESS,
    rr.search(async (t) => (t === "backoff helper" ? [FILE] : t === "retry budget" ? [FILE, "repos/example-vessel/src/other.ts"] : [])),
    rr.tap(() => {}),
    rr.symbolSearch(async () => []),
    rr.propose(async () => []),
    rr.read(async () => readText),
  );
  return rr.finish(PATHLESS, out)!;
}

describe("routing_input carries what a replay reads", () => {
  test("a pathless resolution: route_enabled and localization are keys; every term search has prefer_call_sites; every read has its text", async () => {
    const rec = await pathless(TEXT);
    expect(Object.prototype.hasOwnProperty.call(rec, "route_enabled")).toBe(true);
    expect(rec.route_enabled).toBeNull(); // not yet read: the hand-off check sets it
    expect(Object.prototype.hasOwnProperty.call(rec, "localization")).toBe(true);
    expect(rec.localization).toBeNull();
    const terms = rec.resolution.candidates.filter((c) => c.via === "term");
    expect(terms.length).toBeGreaterThan(0);
    for (const c of terms) expect(typeof c.prefer_call_sites).toBe("boolean");
    expect(rec.resolution.reads).toEqual([{ path: FILE, readable: true, text: TEXT }]);
    expect(rec.capped).toBeUndefined();
  });

  test("an unreadable read records text null", async () => {
    const rec = await pathless(undefined);
    expect(rec.resolution.reads.every((r) => r.readable === false && r.text === null)).toBe(true);
  });

  test("an oversize read is cut at the per-read cap, marked, and the record is capped", async () => {
    const big = `${TEXT}${"// filler\n".repeat(2_000)}`;
    const rec = await pathless(big);
    const r = rec.resolution.reads[0]!;
    expect(r.capped).toBe(true);
    expect(r.text!).toContain(CAPTURE_TRUNCATION_MARKER);
    expect(r.text!.length).toBeLessThan(CAPTURE_READ_CAP_CHARS + 200);
    expect(rec.capped).toBe(true);
  });

  test("the hand-off check's route switch is recorded on the bound dispatch", async () => {
    const target: CaptureTarget = {};
    attachRoutingInput(target, await pathless(TEXT));
    await withCaptureTarget(target, async () => { noteRouteEnabled({ goal: PATHLESS, enabled: true }); });
    expect(target.metadata!.routing_input!.route_enabled).toBe(true);
  });

  test("an applied hydration records the gap summary; one not applied records none", async () => {
    const goal = "Close gap gap-fixture-stale-stage by fixing the stage timer";
    const applied: CaptureTarget = {};
    await withCaptureTarget(applied, async () => {
      noteGapHydration({ goal, gapId: "gap-fixture-stale-stage", citedFile: FILE, applied: true, summary: "the stage timer never resets" });
      noteRouteEnabled({ goal, enabled: true });
      noteRoutingHandOff({ goal, composeGapId: "gap-fixture-stale-stage", editSite: FILE });
    });
    expect(applied.metadata!.routing_input!.gap_hint).toEqual({ gap_id: "gap-fixture-stale-stage", cited_file: FILE, applied: true, summary: "the stage timer never resets" });
    const notApplied: CaptureTarget = {};
    await withCaptureTarget(notApplied, async () => { noteGapHydration({ goal: `${goal} in ${FILE}`, gapId: "gap-fixture-stale-stage", citedFile: FILE, applied: false, summary: "x" }); });
    expect(notApplied.metadata!.routing_input!.gap_hint!.summary).toBeNull();
  });
});
