// WIRING PIN: every reach-path decision site and both routing sites in src/index.ts call the closed capture
// (src/judge/capture.ts). A capture module nothing calls records nothing, and a recorded-input corpus fed by it would
// be empty while every test of the module stays green. So this reads index.ts as TEXT and asserts, by anchor (never
// by line number):
//   - each anchor is FOUND exactly once (a missing anchor is red, never vacuous);
//   - the capture call sits within a few lines of it, on the right side of the decision.
// Removing any one capture call turns this red.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
const INDEX = readFileSync(join(SRC, "index.ts"), "utf8");
const CAPTURE = readFileSync(join(SRC, "judge", "capture.ts"), "utf8") + "\n" + readFileSync(join(SRC, "judge", "capture-records.ts"), "utf8");
const LINES = INDEX.split("\n");

/** The 0-based line of the ONE line containing `anchor`; fails when absent or ambiguous. */
function lineOf(anchor: string): number {
  const hits = LINES.flatMap((l, i) => (l.includes(anchor) ? [i] : []));
  expect({ anchor, found: hits.length }).toEqual({ anchor, found: 1 });
  return hits[0]!;
}
/** `call` occurs on a line in (anchor, anchor + within]; returns that line. */
function callAfter(anchor: string, call: string, within: number): number {
  const at = lineOf(anchor);
  const window = LINES.slice(at + 1, at + 1 + within);
  const off = window.findIndex((l) => l.includes(call));
  expect({ anchor, call, foundWithin: off >= 0 }).toEqual({ anchor, call, foundWithin: true });
  return at + 1 + off;
}

describe("judge capture wiring pin: every decision site calls the closed capture", () => {
  test("index.ts imports the capture module", () => {
    expect(INDEX).toContain(`import * as judgeCapture from "./judge/capture";`);
  });

  test("reachGate: the single reach gate records its inputs after the verdict", () => {
    const unrestricted = callAfter("async function verifyGoalReached(goal: string,", "await verifyGoalReachedUnrestricted(", 3);
    const cap = callAfter("async function verifyGoalReached(goal: string,", `judgeCapture.captureJudgeInput("reachGate", () => judgeCapture.reachGateInput({`, 12);
    expect(cap).toBeGreaterThan(unrestricted);
    // The capture is in the same function, before its return.
    const ret = LINES.slice(cap).findIndex((l) => l.trim() === "return v;");
    expect(ret).toBeGreaterThan(0);
    expect(ret).toBeLessThan(30);
  });

  test("reachGate: every gate call names its surface (walk / floor / recovery), or is a walk-end call passing its judge view", () => {
    const calls: string[] = [];
    let i = INDEX.indexOf("await verifyGoalReached(");
    while (i >= 0) {
      let depth = 0; let j = INDEX.indexOf("(", i);
      for (; j < INDEX.length; j++) { if (INDEX[j] === "(") depth++; else if (INDEX[j] === ")" && --depth === 0) break; }
      calls.push(INDEX.slice(i, j + 1));
      i = INDEX.indexOf("await verifyGoalReached(", j);
    }
    expect(calls.length).toBe(5);
    const named = calls.filter((c) => /, "(walk|floor|recovery)",? ?\)$/.test(c.replace(/\s+/g, " ")));
    const walkEnd = calls.filter((c) => c.includes("walkEv, judgeView, [...terminalShapes, ...target], poolEvidenceOf(poolImpulses), walkWriteEvidence())"));
    expect(named.length).toBe(3);
    expect(walkEnd.length).toBe(2);
    // A walk-end call is recognised by the judge view it passes.
    expect(INDEX).toContain(`surface: captureSurface ?? (judgeView ? "walk" : null),`);
  });

  test("reachGate: the gate and its capture share ONE landed definition (landedEditOf)", () => {
    lineOf("const landedEdit = landedEditOf(meaningfulShapes, dig);");
    lineOf("function landedEditOf(meaningfulShapes: readonly string[], dig: string): boolean {");
    lineOf("landedEffective: landedEditOf(producedShapes.filter((s) => s !== \"goal\"), (contentDigest ?? \"\").trim()) || writeEvidence?.landed === true,");
    lineOf("landed: landedEdit || writeEvidence.landed === true,");
  });

  test("reachGate: the LLM judge's verdict is recorded as data where the gate consults it", () => {
    callAfter("const judged = await llmJudgeReach(goal, producedShapes, taskSummary, contentDigest, commandEvidence);", "judgeCapture.noteLlmJudge(judged);", 1);
  });

  test("ports: the citation oracle's re-read and the walk's write read-back are recorded", () => {
    callAfter("const f = await read(c.path);", "judgeCapture.noteCitationPort(", 1);
    callAfter("function verifyWritePersisted(writeShape: string, writeResult: unknown)", "judgeCapture.observeWriteReadback(writeShape, verifyWritePersistedRead(writeShape, writeResult))", 1);
    expect(INDEX).not.toContain("async function verifyWritePersisted(");
    lineOf("async function verifyWritePersistedRead(");
  });

  test("floorVerdict: recorded right after the floor's reached decision", () => {
    callAfter("const floorReached = verdict?.reached === true && !_fabricatedTranscript", `judgeCapture.captureJudgeInput("floorVerdict", () => judgeCapture.floorVerdictInput({`, 2);
  });

  test("floorShortcut: recorded after the shortcut decision and before it is acted on", () => {
    const cap = callAfter("const _floorShortcut = reachingPathway ? floorShortcutAllowed({", `judgeCapture.captureJudgeInput("floorShortcut", () => judgeCapture.floorShortcutInput({`, 12);
    expect(lineOf("const floorIsTheProvenPathway = _floorShortcut.allowed;")).toBeGreaterThan(cap);
  });

  test("reframeAccept: recorded after the acceptance inputs and before the acceptance branch", () => {
    const cap = callAfter("const altHasSubstance = altSubstantive.length > 0", `judgeCapture.captureJudgeInput("reframeAccept", () => judgeCapture.reframeAcceptInput({`, 2);
    const branch = LINES.findIndex((l, i) => i > cap && l.includes("if (altWalkResult.abstain) {"));
    expect(branch).toBeGreaterThan(cap);
    expect(branch - cap).toBeLessThan(25);
  });

  test("creditOnHollow: recorded right after the β withhold/charge decision", () => {
    callAfter("const _betaWithheldForSymmetry = !_noOracle && !_alphaWasReachable;", `judgeCapture.captureJudgeInput("creditOnHollow", () => judgeCapture.creditOnHollowInput({`, 12);
  });

  test("routing: the pathless resolution at the door runs through the recorder and its record is attached to the dispatch", () => {
    lineOf("const _routeRec = judgeCapture.routingRecorder();");
    const call = lineOf("await resolvePathlessCodeChangeGoal(rawGoal, _routeRec.search(searchWorkspaceForTerm), _routeRec.tap(");
    const rest = LINES.slice(call, call + 120).join("\n");
    expect(rest).toContain("_routeRec.symbolSearch(searchWorkspaceForSymbol)");
    expect(rest).toContain("_routeRec.propose(async (g: string)");
    expect(rest).toContain("_routeRec.read(async (rel: string)");
    expect(rest).toContain("_routeRec.finish(rawGoal, goal)");
    const attach = lineOf("judgeCapture.attachRoutingInput(record, _routingInput);");
    expect(LINES[attach + 1]).toContain("executionStore.set(dispatchId, record);");
  });

  test("routing: the feature_compose hand-off records the route and its compose gap id", () => {
    callAfter("const earlyGapId = composeGapIdOf(goal, opts.variables);", "judgeCapture.noteRoutingHandOff({ goal: String(goal ?? \"\"), composeGapId: earlyGapId, editSite: earlyEditSite });", 2);
  });

  test("routing: the gap-record hydration records its routing hint after the routing goal is decided", () => {
    const decided = lineOf("goalForRouting = `${goal} (gap cites file: ${hydFile}; fix per gap record:");
    const cap = callAfter("goalForRouting = `${goal} (gap cites file: ${hydFile}; fix per gap record:", "judgeCapture.noteGapHydration({ goal, gapId: hydGap.id, citedFile: hydFile ?? null, applied: goalForRouting !== goal, summary: String(hydGap.summary ?? \"\") });", 4);
    expect(cap).toBeGreaterThan(decided);
  });

  test("routing: the early edit-intent check records the route switch it decided with", () => {
    callAfter(`const earlyEditIntentEnabled = process.env.ROUTE_EDIT_INTENT_TO_COMPOSE !== "0";`, "judgeCapture.noteRouteEnabled({ goal: String(goal ?? \"\"), enabled: earlyEditIntentEnabled });", 2);
  });

  test("binding: the /run-goal dispatch binds its record for every capture below it", () => {
    const bind = lineOf("judgeCapture.bindCaptureTarget(record);");
    expect(LINES[bind + 1]).toContain("const seek = await runGoalWithRecovery(goal, {");
  });

  test("capture.ts and capture-records.ts perform no I/O and reads no env, clock or randomness", () => {
    const code = CAPTURE.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    for (const banned of ["process.env", "fetch(", "Bun.", "readFile", "writeFile", "node:fs", "node:child_process", "Date.now", "new Date", "Math.random", "performance.", "setTimeout", "setInterval"]) {
      expect({ banned, present: code.includes(banned) }).toEqual({ banned, present: false });
    }
  });
});
