// THE SATISFIER'S ACTION-THEN-READ SIBLING PASSES THE WRITE DOOR (write-door.ts; index.ts vesselResolveShapeInner (b)).
// Measured: a goal not admitted as a change inferred the read target uiFeedback; its resolve failed, and the satisfier's
// action-then-read branch picked and RAN the sibling uiPanel_write (goal-host's own resolve), leaving empty "Untitled"
// panels on the human surface, with no door counting it: the satisfier and vesselResolve doors judged only the target
// shape they were asked for, never the sibling that wrote. The walk is a closure that cannot run without the fleet, so
// the wiring is pinned on the source (as write-door-wiring.test.ts does) and the decision it calls is run for real.
//
// Goal texts come from 5-word draws (EFF large list, research-watch/draw-words.sh):
//   MF       seed=1793036686681289084 words=figurine hurray devalue multitask coleslaw
//   CONTROL1 seed=1793036686703174258 words=protozoan marina encroach astrology elective
//   CONTROL2 seed=1793036686719448057 words=stammer hedging litmus dramatize vagabond
import { beforeEach, describe, expect, test } from "bun:test";

import { goalHashOf } from "../src/goal-target-inference";
import { isFsWriteShape } from "../src/fs-write-shapes";
import { noteWriteRefusal, refusedWrite, resetWriteDoorCounters, writeDoorCounters, writeDoorFilter } from "../src/write-door";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;

const MF_GOAL = "Tell me which of my figurine listings lost value while I was multitasking, and whether the coleslaw sale earned a hurray.";
const CHANGE_GOAL = "Pin a panel noting that the protozoan survey at the marina now encroaches on the astrology elective's room.";
const READ_GOAL = "Show me the litmus answers where the vagabond character stammers or hedges, without dramatizing them.";

// The same call the action branch makes (index.ts actionRefused): one sibling, judged by its own shape, door "satisfier".
const judgeAction = (actionShape: string, admitted: boolean, goal: string, product: ReadonlySet<string>, lines: string[]): boolean =>
  writeDoorFilter([actionShape], (s) => [s], admitted, "satisfier", goalHashOf(goal), (l) => lines.push(l), String, product).length === 0;

// The whole of index.ts actionRefused: a filesystem sibling refused whatever the admission, then the shared door.
const actionRefusedLike = (actionShape: string, admitted: boolean, goal: string, product: ReadonlySet<string>, lines: string[]): boolean => {
  if (isFsWriteShape(actionShape)) { noteWriteRefusal("satisfier"); lines.push(`fs ${actionShape}`); return true; }
  return judgeAction(actionShape, admitted, goal, product, lines);
};

describe("satisfier action-then-read: wiring", () => {
  const branch = (() => {
    const start = src.indexOf("// (b) ACTION-THEN-READ: the target didn't resolve");
    expect(start).toBeGreaterThan(0);
    return src.slice(start, src.indexOf("// Goal impulse (shape \"goal\").", start));
  })();

  test("[MUST-FAIL] the first pick is judged by the door before goal-host resolves it", () => {
    const pick = branch.indexOf("let action = await llmPickProducingAction(shape, siblings);");
    const guard = branch.indexOf("if (actionRefused(action.shape)) return null;");
    const run = branch.indexOf('let actionResult = await rawResolve(action.shape, actionEp.endpoint, actionEp.resolvePath, action.args, "satisfier-action");');
    expect(pick).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(pick);
    expect(run).toBeGreaterThan(guard);
  });

  test("[MUST-FAIL] the retry's pick (which may name another sibling) is judged before it is resolved", () => {
    const pick = branch.indexOf("const retryAction = await llmPickProducingAction(shape, siblings, refusal);");
    const guard = branch.indexOf("if (actionRefused(retryAction.shape)) return null;");
    const run = branch.indexOf('rawResolve(retryAction.shape, retryEp.endpoint, retryEp.resolvePath, mergedArgs, "satisfier-action-retry")');
    expect(pick).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(pick);
    expect(run).toBeGreaterThan(guard);
  });

  test("[MUST-FAIL] the judge is the shared door on the walk's admission and goal product, counted under satisfier", () => {
    expect(branch).toContain('writeDoorFilter([actionShape], (s) => [s], changeAdmitted, "satisfier", writeDoorHash, (l) => tap(`${l}; satisfier action for target ${shape}`), String, writeDoorProduct).length === 0');
    // a filesystem-write sibling is refused whatever the admission, like the satisfier's own target door
    expect(branch).toMatch(/if \(isFsWriteShape\(actionShape\)\) \{\s*noteWriteRefusal\("satisfier"\);/);
    // every resolve of a picked sibling in the branch sits behind the guard: exactly the two above
    expect(branch.match(/rawResolve\((?:action|retryAction)\.shape,/g)?.length).toBe(2);
  });
});

describe("satisfier action-then-read: the decision", () => {
  beforeEach(() => resetWriteDoorCounters());

  test("MF shape: a goal not admitted, read target uiFeedback, sibling uiPanel_write → refused, counted, recorded", () => {
    const lines: string[] = [];
    const product = new Set(["uiFeedback", "human_surface:ui_view"]);
    expect(judgeAction("uiPanel_write", false, MF_GOAL, product, lines)).toBe(true);
    expect(writeDoorCounters().satisfier).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`[write-door] dropped uiPanel_write: goal not admitted as a change (door=satisfier, goal_hash=${goalHashOf(MF_GOAL)})`);
    // three retries of the same pick are three attempted writes, three counts
    judgeAction("uiPanel_write", false, MF_GOAL, product, lines);
    judgeAction("uiPanel_write", false, MF_GOAL, product, lines);
    expect(writeDoorCounters().satisfier).toBe(3);
  });

  test("CONTROL: a goal admitted as a change keeps its panel write, nothing counted", () => {
    const lines: string[] = [];
    expect(judgeAction("uiPanel_write", true, CHANGE_GOAL, new Set(["uiPanel_write"]), lines)).toBe(false);
    expect(judgeAction("uiPanel_write", true, CHANGE_GOAL, new Set(), lines)).toBe(false);
    expect(writeDoorCounters().satisfier).toBe(0);
    expect(lines).toEqual([]);
  });

  test("CONTROL: an admitted goal's NON-filesystem store write via an action sibling still runs; only a filesystem sibling is refused there", () => {
    const lines: string[] = [];
    for (const store of ["uiPanel_write", "uiQuestion_write", "memoryNote_write"]) {
      expect(isFsWriteShape(store)).toBe(false);
      expect(actionRefusedLike(store, true, CHANGE_GOAL, new Set(), lines)).toBe(false);
    }
    expect(writeDoorCounters().satisfier).toBe(0);
    expect(lines).toEqual([]);
    // deliberate (qa ruling): a filesystem sibling is refused on an admitted goal too, counted under satisfier
    expect(actionRefusedLike("fs_write", true, CHANGE_GOAL, new Set(["fs_write"]), lines)).toBe(true);
    expect(writeDoorCounters().satisfier).toBe(1);
  });

  test("CONTROL: a sibling that is the goal's own product is not refused on a goal not admitted", () => {
    const lines: string[] = [];
    expect(judgeAction("uiPanel_write", false, CHANGE_GOAL, new Set(["uiPanel_write"]), lines)).toBe(false);
    expect(writeDoorCounters().satisfier).toBe(0);
  });

  test("CONTROL: a satisfier that runs its requested read shape is unaffected", () => {
    const lines: string[] = [];
    const product = new Set(["uiQuestion"]);
    for (const read of ["uiQuestion", "uiFeedback", "interactorEvent"]) {
      expect(refusedWrite(read, product)).toBe(false);
      expect(judgeAction(read, false, READ_GOAL, product, lines)).toBe(false);
    }
    expect(writeDoorCounters().satisfier).toBe(0);
    expect(lines).toEqual([]);
  });
});
