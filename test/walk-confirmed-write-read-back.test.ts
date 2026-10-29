// A WALK THAT READ BACK AND CONFIRMED ITS TERMINAL WRITE IS NOT CAPPED HOLLOW, AND ITS READ-BACK IS A STEP OF THE CHAIN.
//
// Measured shape (a note goal, node1): the walk's satisfier wrote the note and read it back (verifyWritePersistedRead,
// the note is in the store), but the reach verifier answered "deterministic:hollow_walklog_capped — all 1 logged walk
// step(s) produced 0 new shapes" and beta-penalised the write: satisfier productions log no "step N ran" line, so the one
// failed template step beside the verified write was the whole step log. Past the cap, the pre-gate's read-back rule
// (rule 7, changeEvidence) would still have refused it "unconfirmed": the read the walk made was never a chain step.
// Now the confirmed read-back is recorded as a pool step after the write (walk-read-back.ts readBackStepFor, from the
// confirming rawResolve only), and a walk with a read-back-confirmed terminal write is not capped.
//
//   [MUST-FAIL] that shape (a confirmed satisfier write + its recorded read-back + one failed template step line) is
//               NOT capped, passes rule 7 and is judged (reached), so it is not beta-penalised as hollow.
//   [MUST-FAIL] no beta charge for that shape, measured: grading posts no feedback/reach, the walk-complete /reach
//               body is reached:true, and the walk's hollow beta site sits inside its reached === false branch.
//   [MUST-FAIL] the recorded read step carries the REAL read-back record (read shape, confirmed id, the read's result);
//               the walk wires it from the two confirming rawResolve reads only, and the cap reads the confirmed writes.
//   [CONTROL a] a walk with NO confirmed write is still capped (judge not asked).
//   [CONTROL b] a write whose read-back failed adds no read step and is still refused "unconfirmed".
//   [CONTROL c] a claimed change with no write at all is still "unwritten".
//   [CONTROL]   nothing is added when the walk only inferred success without a confirming rawResolve.
//
// Fixture goal from a fresh 5-word draw (draw-words.sh):
//   2026-10-29T22:58:52Z seed=1793314732180952063 words=self roundish grub osmosis silo
// The gate is the REAL index.ts verifyGoalReached with every fetch stubbed; the judge stub answers reached.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WR = (await import("../src/walk-read-back").catch(() => ({}))) as Record<string, any>;
const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

type Gate = (goal: string, producedShapes: string[], taskSummary: string, contentDigest?: string, commandEvidence?: string, walkEvidence?: unknown, judgeView?: unknown, deliverables?: string[], poolEvidence?: unknown, writeEvidence?: { persistedWrites: string[]; targets?: string[] }, captureSurface?: string) => Promise<{ reached?: boolean; reason?: string; deterministic?: boolean } | null>;
const realFetch = globalThis.fetch;
const JUDGE_MARK = "You verify whether a substrate execution REACHED";
let judgeCalls = 0;
/** Every URL the gate fetched, so a beta charge (activity-api feedback / reach) would be SEEN, not assumed. */
const fetchedUrls: string[] = [];
let verifyGoalReached: Gate;
let reachVerdictBody: (executionId: string, reached: boolean, completionShapes: string[] | null | undefined, reason?: string | null, goalHash?: string | null, betaWithheldReason?: string | null) => string;

const GOAL = "Note down that the roundish grain silo self-seals by osmosis, so the grub check can wait.";
const NOTE_ID = "roundish-silo-osmosis";
const WRITE = "memoryNote_write";
const READ = "memoryNote";
const TARGETS = ["llm_completion_dispatch", WRITE];
const ANSWER = `I saved the note ${NOTE_ID}: the roundish grain silo self-seals by osmosis.`;
const FAILED_STEP = "walk(/run-goal): step 6 ran activity:⟨learned-composition-fixture-to-memorynote-write⟩ status=failed new_shapes=0 pool=3 chain=6";
const WRITTEN = JSON.stringify({ success: true, body: { notes: [{ id: NOTE_ID, title: NOTE_ID, body: "The roundish grain silo self-seals by osmosis." }] } });
const llm = JSON.stringify({ success: true, shape: "llmTextCompletion", body: { text: ANSWER } });
const CODE = "deterministic:unwritten-change-claim — ";

beforeAll(async () => {
  process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    fetchedUrls.push(String(url));
    const body = typeof init?.body === "string" ? init.body : "";
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
    if (body.includes(JUDGE_MARK)) {
      judgeCalls++;
      const verdict = JSON.stringify({ reached: true, reason: "stub judge: the note was saved and read back", completion_shapes: [WRITE] });
      return json({ content: { body: { content: verdict } }, body: { content: verdict } });
    }
    if (body.includes('"vesselCapability"') && body.includes('"llm_completion"')) {
      return json({ content: { vessels: [{ id: "llm-test-vessel", endpoint: "http://llm-vessel.test.invalid", resolve_endpoint: "http://llm-vessel.test.invalid/resolve", protocol: "http" }] } });
    }
    return new Response(JSON.stringify({ error: "stub: not served" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  const mod = (await import("../src/index")) as Record<string, unknown>;
  verifyGoalReached = mod["verifyGoalReached"] as Gate;
  reachVerdictBody = mod["reachVerdictBody"] as typeof reachVerdictBody;
});
afterAll(() => { globalThis.fetch = realFetch; });

/** The walk's verifier call, as index.ts makes it: pool shapes in production order, their digest, the step log. */
function grade(steps: Array<[string, string]>, walkEvidence: Record<string, unknown>, persisted: string[], targets: string[] = TARGETS, goal = GOAL) {
  const produced = ["goal", "dispatch_id", "llm_completion_dispatch", ...steps.map(([s]) => s)];
  const digest = [`- llm_completion_dispatch: ${llm}`, ...steps.map(([s, c]) => `- ${s}: ${c}`)].join("\n");
  return verifyGoalReached(goal, produced, `walk(${steps.length + 1} steps): ${produced.slice(2).join(" -> ")}`, digest, undefined,
    walkEvidence, undefined, targets, [], { persistedWrites: persisted, targets }, "walk");
}

describe("a read-back-confirmed terminal write", () => {
  test("[MUST-FAIL] is not capped hollow, passes rule 7 and is judged reached", async () => {
    const step = WR["readBackStepFor"]?.(WRITE, new Map([[WRITE, { readShape: READ, confirmedId: NOTE_ID, content: JSON.parse(WRITTEN) }]]), new Set([WRITE]));
    expect(step?.shape).toBe(READ);
    const before = judgeCalls;
    const v = await grade([[WRITE, WRITTEN], [READ, JSON.stringify(step?.content ?? null)]],
      { gapsFiled: 0, walkLog: [FAILED_STEP], confirmedTerminalWrites: [WRITE] }, [WRITE]);
    expect(v?.reason ?? "").not.toContain("hollow_walklog_capped");
    expect(v?.reason ?? "").not.toContain("unwritten-change-claim");
    expect(v?.reached).toBe(true);
    expect(judgeCalls).toBe(before + 1);
  }, 30_000);

  test("[MUST-FAIL] no beta charge: grading posts no feedback/reach, the walk-complete /reach body is reached:true, and the walk's beta site needs reached=false", async () => {
    const from = fetchedUrls.length;
    const v = await grade([[WRITE, WRITTEN], [READ, WRITTEN]], { gapsFiled: 0, walkLog: [FAILED_STEP], confirmedTerminalWrites: [WRITE] }, [WRITE]);
    const during = fetchedUrls.slice(from);
    // nothing the gate fetched is a posterior write (penaliseHollowTemplate posts /v2/activities/feedback; /reach grades)
    expect(during.filter((u) => /\/v2\/activities\/feedback|execution-traces\/reach/.test(u))).toEqual([]);
    // what the walk then delivers for this verdict: a reached /reach, never a not-reached one
    expect(JSON.parse(reachVerdictBody("exec-fixture", v?.reached === true, [WRITE], v?.reason ?? "", "g")).reached).toBe(true);
    // the walk's hollow beta (penaliseHollowTemplate on the last pick) runs only inside its verdict.reached === false branch
    const branch = SRC.indexOf("} else if (verdict && verdict.reached === false) {");
    const charge = SRC.indexOf("else opts.learningSink?.alphaBetaDelta.push(await penaliseHollowTemplate(lastPick,");
    expect(branch).toBeGreaterThan(0);
    expect(charge).toBeGreaterThan(branch);
    expect(SRC.slice(branch + 1, charge)).not.toContain("} else if (verdict");
  }, 30_000);

  test("[MUST-FAIL] the read step is the real read-back record, wired from the confirming reads only", () => {
    const content = { body: { notes: [{ id: NOTE_ID }] } };
    const step = WR["readBackStepFor"]?.(WRITE, new Map([[WRITE, { readShape: READ, confirmedId: NOTE_ID, content }]]), new Set([WRITE]));
    expect(step).toEqual({ shape: READ, content, summary: `write read-back of ${WRITE} (${READ}, confirmed id ${NOTE_ID})` });
    expect(WR["confirmedTerminalWritesOf"]?.(["satisfier:" + WRITE, "satisfier:other_write"], new Map([[WRITE, { readShape: READ, confirmedId: NOTE_ID, content }]]), (s: string) => s === WRITE)).toEqual([WRITE]);
    // the map is written at exactly the two confirming rawResolve reads, nowhere else
    expect(SRC.split("confirmedReadBacks.set(").length - 1).toBe(2);
    expect(SRC).toContain("if (confirms(readResult)) { appliedWrites.noteReadBack(writeShape, readBack); confirmedReadBacks.set(writeShape, { readShape, confirmedId: id, content: readResult });");
    expect(SRC).toContain("if (confirms(byTitle)) { appliedWrites.noteReadBack(writeShape, readBack); confirmedReadBacks.set(writeShape, { readShape, confirmedId: id, content: byTitle });");
    // addToPool records the step after the write; the cap reads the walk's confirmed terminal writes
    expect(SRC).toContain("const rb = readBackStepFor(shape, confirmedReadBacks, producedShapes);");
    expect(SRC).toContain("const confirmedTerminalWrites = confirmedTerminalWritesOf(verifiedWrites, confirmedReadBacks, (sh) => terminalShapes.has(sh) || target.has(sh));");
    expect(SRC).toContain("if (walkEvidence && hollowCapApplies(walkEvidence)) {");
  });
});

describe("[CONTROL] what stays refused", () => {
  test("a) a walk with no confirmed write is still capped, and the judge is not asked", async () => {
    const before = judgeCalls;
    const v = await grade([[WRITE, WRITTEN], [READ, WRITTEN]], { gapsFiled: 0, walkLog: [FAILED_STEP] }, [WRITE]);
    expect(v?.reached).toBe(false);
    expect(v?.reason ?? "").toContain("hollow_walklog_capped");
    expect(judgeCalls).toBe(before);
  }, 30_000);

  test("b) a write whose read-back failed adds no read step and is still refused unconfirmed", async () => {
    // no confirming read: nothing is recorded, so the chain holds the write alone
    expect(WR["readBackStepFor"]?.(WRITE, new Map(), new Set([WRITE])) ?? null).toBeNull();
    expect(WR["confirmedTerminalWritesOf"]?.(["satisfier:" + WRITE], new Map(), () => true) ?? []).toEqual([]);
    const v = await grade([[WRITE, JSON.stringify({ success: true, body: { id: NOTE_ID, action: "created" } })]], { gapsFiled: 0, walkLog: [] }, [WRITE]);
    expect(v?.reached).toBe(false);
    expect((v?.reason ?? "").startsWith(`${CODE}unconfirmed:`)).toBe(true);
  }, 30_000);

  test("c) a claimed change with no write at all is still unwritten", async () => {
    // A question goal whose answer still claims the saved note: with a write goal, write-goal-no-artifact would refuse
    // it first, so rule 7 itself is reached here.
    const v = await grade([], { gapsFiled: 0, walkLog: [] }, [], ["llm_completion_dispatch"], "Why does the roundish grain silo stay dry, and does osmosis matter for the grub check?");
    expect(v?.reached).toBe(false);
    expect((v?.reason ?? "").startsWith(`${CODE}unwritten:`)).toBe(true);
  }, 30_000);

  test("nothing is added when success was only inferred, without a confirming read", () => {
    // a record with no confirmed id, or a read shape already in the pool, adds nothing
    expect(WR["readBackStepFor"]?.(WRITE, new Map([[WRITE, { readShape: READ, confirmedId: "", content: {} }]]), new Set([WRITE])) ?? null).toBeNull();
    expect(WR["readBackStepFor"]?.(WRITE, new Map([[WRITE, { readShape: READ, confirmedId: NOTE_ID, content: {} }]]), new Set([WRITE, READ])) ?? null).toBeNull();
    // the concept-db REST fallback (an id read outside rawResolve) records no read step
    const fb = SRC.indexOf("trying the concept-db id read");
    const fbEnd = SRC.indexOf("return { persisted: false };", fb);
    expect(fb).toBeGreaterThan(0);
    expect(SRC.slice(fb, fbEnd)).not.toContain("confirmedReadBacks");
  });
});
