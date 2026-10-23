/**
 * Row: a-refused-run-is-never-persisted-as-a-declined-outcome-so-refusals-are-recorded-as-failures-or-not-at-all.
 *
 * The satisfier decline already writes declined:<class> + metadata.decline (credit-declined-is-not-hollow). The
 * dispatch's other refusals did not: the secret-extraction gate (walk and handler entry) and the spend-rate breaker
 * ended status failed, reached false, the handler-entry ones with no row at all, and a needs_information outcome lived
 * only on the in-memory record while its failed-walk row read as a failure. These pin the same contract on them,
 * except the spend-rate breaker: a breaker refusal is a front-door throttle (a 429), not an execution outcome, so it
 * writes no trace row (a row per throttled dispatch is routine telemetry, and floods while the breaker is tripped);
 * read from the dispatch's structural outcome. The walk and the handler need a live host, so their wiring is pinned
 * on the source (as credit-declined-is-not-hollow does); the mapping and the stamp are driven directly.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
const fnBody = (head: string, len: number) => { const i = SRC.indexOf(head); return i >= 0 ? SRC.slice(i, i + len) : ""; };
const persistFn = (() => { const i = SRC.indexOf("async function persistFailedWalkTrace("); return i >= 0 ? SRC.slice(i, SRC.indexOf("  return execId;", i)) : ""; })();
const breaker = (() => { const i = SRC.indexOf("// SPEND-RATE BREAKER (4.4)"); return i >= 0 ? SRC.slice(i, SRC.indexOf("// RESOLVE THE FILE THE OPERATOR DID NOT NAME", i)) : ""; })();
const postSeek = (() => { const i = SRC.indexOf("} else if (seek.reached !== true) {"); return i >= 0 ? SRC.slice(i, SRC.indexOf("record.selectedTemplateId = seek.selectedTemplateId;", i)) : ""; })();

const mod = async () => await import("../src/refusal-decline");
const SECRET_REASON = "deterministic:secret-extraction-refused — the goal asks to reveal a secret/credential VALUE";
const NI = { kind: "needs_information" as const, reason: "unbound_input" as const, missing: [{ shape: "gapDecomposition", field: "edit_site", tried: ["pool_bind", "investigation"] as Array<"pool_bind" | "investigation"> }] };

describe("MUST-FAIL: a refused dispatch is declined, on a row, in the satisfier decline's shape", () => {
  test("a refused outcome declines with its refuse_class; needs_information with the satisfier decline's class", async () => {
    const { declineOfOutcome } = await mod();
    expect(declineOfOutcome({ kind: "refused", refuse_class: "secret_extraction" }, SECRET_REASON)).toEqual({ class: "secret_extraction", reason: SECRET_REASON, decliner_id: "goal-host:refusal:secret_extraction" });
    const ni = declineOfOutcome(NI, "ignored");
    expect(ni?.class).toBe("needs_information");
    expect(ni?.reason).toContain("`edit_site` (needed by `gapDecomposition`");
  });

  test("the stamp is the satisfier decline's: one declined:<class> tag and metadata.decline {class, reason_text, decliner_id}", async () => {
    const { declinedTags, declineMetadata } = await mod();
    const d = { class: "secret_extraction", reason: SECRET_REASON, decliner_id: "goal-host:refusal:secret_extraction" };
    expect(declinedTags(["dispatcher_used:goal-host", "declined:old"], d)).toEqual(["dispatcher_used:goal-host", "declined:secret_extraction"]);
    expect(declineMetadata(d)).toEqual({ decline: { class: "secret_extraction", reason_text: SECRET_REASON, decliner_id: "goal-host:refusal:secret_extraction" } });
  });

  test("the failed-walk row carries the decline it is handed", () => {
    expect(persistFn).toContain("decline: RefusalDecline | null = null,");
    expect(persistFn).toContain('tags: declinedTags(["dispatcher_used:goal-host"], decline),');
    expect(persistFn).toContain("...declineMetadata(decline),");
  });

  test("the walk's secret-extraction refusal states its outcome, so its row is declined", () => {
    expect(SRC).toContain('selectedTemplateId: "secret-extraction-refused", completionShapes: null, attempts: 0, reached: false, outcome: { kind: "refused", refuse_class: "secret_extraction" },');
  });

  test("the post-walk persist reads the decline from the seek's outcome, else needs_information, before it writes, and withholds β", () => {
    const decl = postSeek.indexOf("const _decline = declineOfOutcome(seek.outcome ?? needsInformationOutcome(");
    const write = postSeek.indexOf('"walk-terminated-unreached", _decline);');
    expect(decl).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(decl);
    expect(postSeek).toContain('if (_decline) betaWithheld.set(record.executionId, "declined");');
  });

  test("CONTROL: the handler-entry secret-extraction refusal still persists one declined row and links it on the record", () => {
    const calls = SRC.match(/void persistFailedWalkTrace\((goal|rawGoal), \[\], null, reason, \[\], "refused-at-entry", declineOfOutcome\(outcome, reason\)\)\.then\(\(id\) => \{ refusalRec\.executionId = id; \}, \(\) => \{\}\);/g) ?? [];
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("persistFailedWalkTrace(goal,");
    expect(SRC).toContain('const outcome: DispatchOutcome = { kind: "refused", refuse_class: "secret_extraction" };');
    expect(SRC).toContain('selectedTemplateId: "secret-extraction-refused", goalReachReason: reason, outcome };');
  });
});

describe("MUST-FAIL: a spend-rate breaker refusal is a throttle and writes no trace row", () => {
  test("the breaker block persists nothing; its log line and its 429 stay", () => {
    expect(breaker.length).toBeGreaterThan(0);
    expect(breaker.includes("persistFailedWalkTrace(")).toBe(false);
    expect(breaker.includes("persistSatisfierTrace(")).toBe(false);
    expect(breaker.includes("satisfierTraceSink")).toBe(false);
    expect(breaker).toContain("SPEND-RATE REFUSED at handler entry (no LLM call)");
    expect(breaker).toContain("{ status: 429,");
  });

  test("a spend_rate outcome is not a decline", async () => {
    const { declineOfOutcome } = await mod();
    expect(declineOfOutcome({ kind: "refused", refuse_class: "spend_rate", retry_after_s: 30 }, "deterministic:spend-rate-refused - x")).toBeNull();
  });
});

describe("CONTROL: what is not a refusal is written as before", () => {
  test("no outcome, or a compose lane's non_attempt, is not a decline; an unknown class is named generically", async () => {
    const { declineOfOutcome } = await mod();
    expect(declineOfOutcome(undefined, "x")).toBeNull();
    expect(declineOfOutcome(null)).toBeNull();
    expect(declineOfOutcome({ kind: "non_attempt", failure_kind: "capacity" }, "BUSY")).toBeNull();
    expect(declineOfOutcome({ kind: "refused", refuse_class: "Bad Class!" }, "r")?.class).toBe("refused");
  });

  test("no decline: the row's tags and metadata are exactly today's", async () => {
    const { declinedTags, declineMetadata } = await mod();
    expect(declinedTags(["dispatcher_used:goal-host"], null)).toEqual(["dispatcher_used:goal-host"]);
    expect(declineMetadata(null)).toEqual({});
  });

  test("the thrown-walk persist and the satisfier decline writer are unchanged", () => {
    expect(SRC).toContain('(record as { completionShapes?: string[] | null }).completionShapes ?? null, record.error, [], "walk-threw");');
    expect(SRC).toContain("if (!reached && walkDeclined) { durableTrace.tags = [...(durableTrace.tags ?? []).filter((t) => !t.startsWith(\"declined:\")), `declined:${walkDeclined.class}`];");
    expect(fnBody("async function persistFailedWalkTrace(", 600)).toContain("await persistSatisfierTrace({");
  });
});
