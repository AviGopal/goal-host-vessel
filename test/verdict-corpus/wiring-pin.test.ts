// PROTECTED: the corpus pins what PRODUCTION calls (a corpus-green function off the production path is a hollow
// gate). src/index.ts is read as text and each judge entry must be called at its site, found by anchor (never by
// line); the expressions that moved into the entries must be GONE from index.ts. Every anchor must be found: a
// missing anchor is red, never vacuous. The live-shadow check of the runner is the runtime twin.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "index.ts"), "utf8");

/** [site, the anchor that locates the site, the call that must sit within WINDOW chars after it]. */
const WINDOW = 3500;
export const SITES: ReadonlyArray<readonly [string, string, string]> = [
  ["the reach gate in verifyGoalReachedUnrestricted", "if (writeEvidence) {", "judge.reachGate(judgeInputs.reachInput("],
  ["the floor's reach decision", "const _floorV = ", "judge.floorVerdict(judgeInputs.floorInput("],
  ["the floor's completion-shapes tag", "PRODUCED, NEVER REQUESTED (judge entry completionShapes", "judge.completionShapes(judgeInputs.completionInput("],
  ["the floor's reach return", "const _floorCompletionShapes = ", "judge.completionShapes(judgeInputs.completionInput("],
  ["the REUSE-BEFORE-DERIVE floor shortcut", "const _floorShortcut = reachingPathway ? ", "judge.floorShortcut(judgeInputs.shortcutInput("],
  ["the re-framing acceptance", "const altSkippedPlannedRetrieval = ", "judge.reframeAccept(judgeInputs.reframeInput("],
  ["the β block on a hollow", "const _noOracle = /^deterministic:no-oracle-for-goal-class", "judge.creditOnHollow(judgeInputs.creditInput("],
];

/** Each entry's live decision is also CAPTURED (src/judge/capture.ts), so a red corpus case can be re-recorded
 *  from production and the live-shadow check has the record to replay: [entry, the entry call, the capture call]. */
export const CAPTURED: ReadonlyArray<readonly [string, string, string]> = [
  ["reachGate", "judge.reachGate(judgeInputs.reachInput(", `judgeCapture.captureJudgeInput("reachGate", () => judgeCapture.reachGateInput(`],
  ["floorVerdict", "judge.floorVerdict(judgeInputs.floorInput(", `judgeCapture.captureJudgeInput("floorVerdict", () => judgeCapture.floorVerdictInput(`],
  ["floorShortcut", "judge.floorShortcut(judgeInputs.shortcutInput(", `judgeCapture.captureJudgeInput("floorShortcut", () => judgeCapture.floorShortcutInput(`],
  ["reframeAccept", "judge.reframeAccept(judgeInputs.reframeInput(", `judgeCapture.captureJudgeInput("reframeAccept", () => judgeCapture.reframeAcceptInput(`],
  ["creditOnHollow", "judge.creditOnHollow(judgeInputs.creditInput(", `judgeCapture.captureJudgeInput("creditOnHollow", () => judgeCapture.creditOnHollowInput(`],
];

/** Expressions that live in the entries now; finding one in index.ts means a local copy bypasses the corpus. */
export const MOVED: readonly string[] = [
  "writeGoalArtifactGate(",
  "floorShortcutAllowed(",
  "floorCompletionShapes(",
  "altWalkResult.reached && altHasSubstance",
  "const altHasSubstance",
  "verdict.deterministic === true || consumedInChain.size > 0",
  "/\\btool\\s+(?:call|response|output|result)\\b/i.test(finalText)",
  "!(executed.length > 0 && executedOk === 0)",
  "from \"./write-goal-artifact\"",
  "from \"./judge-rules",
];

describe("wiring pin: index.ts calls each judge entry at its site", () => {
  for (const [site, anchor, call] of SITES) {
    test(site, () => {
      const i = SRC.indexOf(anchor);
      expect([site, "anchor found", i >= 0]).toEqual([site, "anchor found", true]);
      expect([site, SRC.slice(i, i + WINDOW).includes(call)]).toEqual([site, true]);
    });
  }
  test("each entry the corpus replays is called from index.ts", () => {
    for (const e of ["reachGate", "floorVerdict", "floorShortcut", "reframeAccept", "completionShapes", "creditOnHollow"]) expect([e, SRC.includes(`judge.${e}(`)]).toEqual([e, true]);
  });
  test("index.ts imports the closed core, never the open rules", () => {
    expect(SRC).toContain(`import * as judge from "./judge/entries";`);
    expect(SRC).toContain(`import * as judgeInputs from "./judge/inputs";`);
  });
  for (const [entry, call, capture] of CAPTURED) test(`${entry}: the decision is captured after the entry decides it`, () => {
    const i = SRC.indexOf(call);
    const j = SRC.indexOf(capture);
    expect([entry, i >= 0, j >= 0]).toEqual([entry, true, true]);
    if (entry !== "reachGate") expect([entry, j > i, j - i < 6000]).toEqual([entry, true, true]); // reachGate is captured in verifyGoalReached, the wrapper that returns its verdict
  });
  test("the reach verdict is captured in verifyGoalReached, which calls the gate's container", () => {
    const f = SRC.indexOf("async function verifyGoalReached(");
    const body = SRC.slice(f, SRC.indexOf("async function verifyGoalReachedUnrestricted(", f));
    expect(body).toContain("verifyGoalReachedUnrestricted(");
    expect(body).toContain(`judgeCapture.captureJudgeInput("reachGate", () => judgeCapture.reachGateInput(`);
  });
  for (const m of MOVED) test(`moved expression is gone from index.ts: ${m}`, () => { expect([m, SRC.includes(m)]).toEqual([m, false]); });
});

describe("MUST-FAIL: the pin sees an off-path copy", () => {
  test("a reach site that calls a local copy instead of judge.reachGate is red", () => {
    const mutant = SRC.replace("judge.reachGate(judgeInputs.reachInput(", "localReachGate(judgeInputs.reachInput(");
    const i = mutant.indexOf("if (writeEvidence) {");
    expect(mutant.slice(i, i + WINDOW).includes("judge.reachGate(judgeInputs.reachInput(")).toBe(false);
  });
  test("a re-inlined decision expression is red", () => {
    expect((SRC + "\nconst altHasSubstance = 1;").includes("const altHasSubstance")).toBe(true);
  });
});

describe("the gate's landing is the shared landedEditOf, and the replay's landed is what the gate was handed", () => {
  test("the reach gate computes landedEdit with landedEditOf and hands landedEdit || writeEvidence.landed to the entry", () => {
    const i = SRC.indexOf("async function verifyGoalReachedUnrestricted(");
    const body = SRC.slice(i, SRC.indexOf("\nasync function ", i + 10));
    expect(body).toContain("const landedEdit = landedEditOf(meaningfulShapes, dig);");
    expect(body).toContain("landed: landedEdit || writeEvidence.landed === true");
  });
  test("the capture records the same effective value (landed_effective) from the same function", () => {
    expect(SRC).toContain("landedEffective: landedEditOf(producedShapes.filter((s) => s !== \"goal\"), (contentDigest ?? \"\").trim()) || writeEvidence?.landed === true");
  });
});
