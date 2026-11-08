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
  CAPTURE_READ_CAP_CHARS, CAPTURE_TRUNCATION_MARKER, attachRoutingInput, noteRouteEnabled,
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

  test("an unreadable read records text null", async () => {
    const rec = await pathless(undefined);
    expect(rec.resolution.reads.every((r) => r.readable === false && r.text === null)).toBe(true);
  });

  test("the hand-off check's route switch is recorded on the bound dispatch", async () => {
    const target: CaptureTarget = {};
    attachRoutingInput(target, await pathless(TEXT));
    await withCaptureTarget(target, async () => { noteRouteEnabled({ goal: PATHLESS, enabled: true }); });
    expect(target.metadata!.routing_input!.route_enabled).toBe(true);
  });
});
