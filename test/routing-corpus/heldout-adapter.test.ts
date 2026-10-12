// PROTECTED: the captured -> replay adapter (src/routing-core/replay-adapter.ts) and the held-out contract
// (corpus-runner.ts heldoutReplay; cli.ts heldout).
//   - a field the replay needs that a record lacks, or carries as null where null is not a value, makes the record
//     UNREPLAYABLE with that field named, and it is never answered;
//   - a record the capture (src/judge/capture.ts routingRecorder) writes, through the production door and the
//     hand-off's route switch, replays with nothing unreplayable (the routing-replay demo);
//   - a complete record replays to the same answer its corpus case gives;
//   - the output is [{record_hash, decision | null, unreplayable?}], one per input line, in order;
//   - MUTANT: an adapter that fills a missing field with a default answers an incomplete record, and is red here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attachRoutingInput, noteRouteEnabled, routingRecorder, withCaptureTarget } from "../../src/judge/capture";
import type { CaptureTarget } from "../../src/judge/records";
import { resolveDoorGoal } from "../../src/routing-core/entries";
import { editIntentReplayOf } from "../../src/routing-core/replay-adapter";
import { heldoutReplay, loadCases, verifyChain, type Adapted, type HeldoutLine } from "./runner";

const line = (record_hash: string, input: unknown, over: Partial<HeldoutLine> = {}): HeldoutLine =>
  ({ record_hash, family: "routing_input", entry: "editIntent", delivered: { routed_to: "walk" }, input, ports: null, llm: null, ...over });
const complete = (over: Record<string, unknown> = {}) => ({
  schema: 1, entry: "editIntent", goal: "What does the retry handler do when a request fails validation?", is_edit_intent: false,
  is_pathless_code_change: false, resolution: { terms: [], candidates: [], chosen_file: null, method: "not-pathless", reads: [] },
  restated_goal: null, compose_gap_id: null, routed_to: "walk", edit_site: null, gap_hint: null, trail: [],
  route_enabled: true, localization: null, ...over,
});
const omit = (o: Record<string, unknown>, k: string) => { const c = { ...o }; delete c[k]; return c; };

/** Incomplete records and the field each must be refused for. */
const INCOMPLETE: Array<[string, unknown, string]> = [
  ["no route_enabled", omit(complete(), "route_enabled"), "route_enabled"],
  ["route_enabled null", complete({ route_enabled: null }), "route_enabled"],
  ["no localization", omit(complete(), "localization"), "localization"],
  ["no gap_hint", omit(complete(), "gap_hint"), "gap_hint"],
  ["hydration applied without its summary", complete({ gap_hint: { gap_id: "gap-x", cited_file: "repos/v/src/x.ts", applied: true } }), "gap_hint.summary"],
  ["an errored search", complete({ resolution: { terms: ["x"], candidates: [{ via: "term", term: "x", scope: null, hits: null, error: true }], chosen_file: null, method: "search-error", reads: [] } }), "resolution.candidates[0].error"],
  ["a search with no hits recorded", complete({ resolution: { terms: ["x"], candidates: [{ via: "term", term: "x", scope: null, hits: null, error: false, prefer_call_sites: false }], chosen_file: null, method: "unresolved", reads: [] } }), "resolution.candidates[0].hits"],
  ["a term search without its call-site flag", complete({ resolution: { terms: ["x"], candidates: [{ via: "term", term: "x", scope: null, hits: [], error: false }], chosen_file: null, method: "unresolved", reads: [] } }), "resolution.candidates[0].prefer_call_sites"],
  ["a read without its text", complete({ resolution: { terms: ["x"], candidates: [], chosen_file: null, method: "unresolved", reads: [{ path: "repos/v/src/x.ts", readable: true }] } }), "resolution.reads[0].text"],
  ["a capped record", complete({ capped: true }), "capped"],
  ["a read cut to the capture cap", complete({ resolution: { terms: ["x"], candidates: [], chosen_file: null, method: "unresolved", reads: [{ path: "repos/v/src/x.ts", readable: true, text: "export const", capped: true }] } }), "resolution.reads[0].capped"],
  ["no goal", omit(complete(), "goal"), "goal"],
];

/** The incomplete lines an adapter set ANSWERS (it must answer none). */
async function answeredIncomplete(adapters?: Record<string, (l: HeldoutLine) => Adapted>): Promise<string[]> {
  const res = await heldoutReplay(INCOMPLETE.map(([label, rec]) => line(label, rec)), adapters);
  return res.filter((r) => r.decision !== null).map((r) => r.record_hash);
}

describe("held-out adapter: a missing replay field is unreplayable, never defaulted", () => {
  for (const [label, rec, field] of INCOMPLETE) {
    test(`${label}: unreplayable, naming ${field}`, () => {
      const a = editIntentReplayOf(rec);
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.unreplayable).toContain(field);
    });
  }
  test("no incomplete record is answered", async () => { expect(await answeredIncomplete()).toEqual([]); });
  test("MUTANT an adapter that defaults route_enabled and localization answers incomplete records (red)", async () => {
    const defaulting: Record<string, (l: HeldoutLine) => Adapted> = {
      editIntent: (l) => {
        const i = { ...(l.input as Record<string, unknown>) };
        i.route_enabled ??= true;
        if (!("localization" in i)) i.localization = null;
        return editIntentReplayOf(i, l.ports, l.llm);
      },
    };
    expect((await answeredIncomplete(defaulting)).length).toBeGreaterThan(0);
  });
  test("a wrong family or an unknown entry is unreplayable", async () => {
    const res = await heldoutReplay([line("f", complete(), { family: "judge_input" }), line("e", complete(), { entry: "notAnEntry" })]);
    expect(res).toEqual([{ record_hash: "f", decision: null, unreplayable: ["family"] }, { record_hash: "e", decision: null, unreplayable: ["entry"] }]);
  });
});

describe("held-out contract", () => {
  test("one answer per line, in order, decision for a complete record", async () => {
    const res = await heldoutReplay([line("a", complete()), line("b", omit(complete(), "route_enabled"))]);
    expect(res.map((r) => r.record_hash)).toEqual(["a", "b"]);
    expect(res[0]).toEqual({ record_hash: "a", decision: { route: "walk", target: null, needs_localization: false } });
    expect(res[1]!.decision).toBeNull();
    expect(res[1]!.unreplayable).toContain("route_enabled");
  });
  test("a complete captured record of a corpus case replays to the case's own answer", async () => {
    const dir = import.meta.dir;
    const c = loadCases(dir, verifyChain(dir)).find((x) => x.id === "0004-phrase-after-ambiguous-and-comment-only")!;
    const input = c.input as { goal: string; localization: unknown };
    const candidates = Object.entries(c.ports.search).map(([k, hits]) => { const [scope, cs, term] = k.split("|"); return { via: "term", term, scope: scope === "*" ? null : scope, hits, error: false, prefer_call_sites: cs === "1" }; });
    const reads = Object.entries(c.ports.read_file).map(([path, text]) => (text === null ? { path, readable: false } : { path, readable: true, text }));
    const rec = complete({ goal: input.goal, is_pathless_code_change: true, resolution: { terms: [], candidates, chosen_file: null, method: "unique-term-hit", reads } });
    const [r] = await heldoutReplay([line("c4", rec)]);
    expect(r!.decision).toEqual({ route: "feature_compose", target: "repos/example-vessel/src/selftest/facts.ts", needs_localization: false });
  });
  test("a cli line in the corpus replay form (case input + ports) also needs every field", async () => {
    const res = await heldoutReplay([line("p", { schema: 1, entry: "editIntent", goal: "x", route_enabled: true, hydration: null }, { ports: { search: {}, symbol_search: {}, read_file: {} } })]);
    expect(res[0]!.unreplayable).toEqual(["localization"]);
  });
});

describe("a real capture replays", () => {
  test("the recorder's record of a door resolution, completed by the hand-off's route switch, replays with nothing unreplayable", async () => {
    const rr = routingRecorder();
    const goal = "The retry handler should stop retrying a request after it failed validation.";
    const F = "repos/example-vessel/src/retry/policy.ts";
    // The production door (resolveDoorGoal) over the recorder's wrappers, as index.ts calls it.
    const out = await resolveDoorGoal(goal, rr.search(async () => [F]), rr.tap(() => {}), rr.symbolSearch(async () => []),
      rr.propose(async () => []), rr.read(async () => 'export const NAME = "retry handler";\n'));
    await new Promise((r) => setTimeout(r, 0));
    const target: CaptureTarget = {};
    attachRoutingInput(target, rr.finish(goal, out));
    withCaptureTarget(target, () => noteRouteEnabled({ goal, enabled: true }));
    const rec = target.metadata?.routing_input;
    expect(rec).toBeDefined();
    const [r] = await heldoutReplay([line("real", JSON.parse(JSON.stringify(rec)))]);
    console.log(`[routing-heldout] real capture -> ${JSON.stringify(r)}`);
    expect(r!.unreplayable).toBeUndefined();
    expect(r!.decision).toEqual({ route: "feature_compose", target: F, needs_localization: false });
  });
  test("the same record before the hand-off's switch is recorded is unreplayable, naming route_enabled", async () => {
    const rr = routingRecorder();
    const goal = "The retry handler should stop retrying a request after it failed validation.";
    const out = await resolveDoorGoal(goal, rr.search(async () => ["repos/example-vessel/src/retry/policy.ts"]), rr.tap(() => {}), undefined, undefined,
      rr.read(async () => 'export const NAME = "retry handler";\n'));
    await new Promise((r) => setTimeout(r, 0));
    const a = editIntentReplayOf(JSON.parse(JSON.stringify(rr.finish(goal, out))));
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.unreplayable).toEqual(["route_enabled"]);
  });
});

// The schema file the adapter's localization field refers to is the corpus's own.
test("the localization schema is present", () => {
  expect(JSON.parse(readFileSync(join(import.meta.dir, "localization-record.schema.json"), "utf8")).title).toBe("localizationRecord");
});
