// THE WRITE DOORS — WIRING (source pins on index.ts; the walk is a closure that cannot run without the fleet).
// Measured: a read-only goal inferred ["fs_edit"] ran auto-bridge-fs_edit at an ordinary template pick and again at
// the composite path. Every door that can choose a write producer or target calls the shared write-door.ts helper,
// and admission is set only where the edit-intent route hands the dispatch to feature_compose.
import { describe, expect, test } from "bun:test";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
const after = (anchor: string, span: number): string => {
  const i = src.indexOf(anchor);
  expect(i).toBeGreaterThan(0);
  return src.slice(i, i + span);
};

describe("write doors are wired", () => {
  test("template pick: the walk's candidates pass the door before any single-pick tier", () => {
    const door = src.indexOf('candidates = writeDoorFilter(candidates, (c) => c.outputShapes, changeAdmitted, "template_pick"');
    expect(door).toBeGreaterThan(0);
    expect(door).toBeLessThan(src.indexOf("// (b) SELECT BEST — goal-gap weighted."));
  });
  test("template pick: the horizontal OR-edge's own forward fetch passes the door", () => {
    expect(src).toContain('forward = writeDoorFilter(forward, (c) => c.outputShapes, changeAdmitted, "template_pick"');
  });
  test("composite pick: missing targets and the composite's outputs both pass the door", () => {
    expect(src).toContain('const _missingC = writeDoorShapes([...target].filter((s) => !producedShapes.has(s)), changeAdmitted, "composite_pick"');
    expect(after("const _c = await authorComposite(", 400)).toContain('writeDoorFilter([_c.pick], (p) => p.outputShapes, changeAdmitted, "composite_pick"');
  });
  test("bridge pick: no wrapper is minted around a write resolver", () => {
    expect(src).toContain('const missingTargets = writeDoorShapes([...target].filter((s) => !producedShapes.has(s)), changeAdmitted, "bridge_pick"');
  });
  test("recovery pick: recommendExcluding refuses write producers and every call site passes the admission", () => {
    expect(src).toContain('writeDoorFilter([x], () => recShapes.map(String), writeDoor.admitted, "recovery_pick"');
    expect(src.match(/recommendExcluding\(goal, [^\n]*\{ admitted: _changeAdmitted, goalHash: goalHashOf\(goal\), record: tap \}\)/g)?.length).toBe(3);
  });
  test("target: the walk's target and the dispatch's seeded target pass the door", () => {
    expect(src).toContain('const target = new Set<string>(writeDoorShapes(opts.expectedOutputShapes ?? [], changeAdmitted, "target"');
    const seed = src.indexOf('if (seededOutputShapes) seededOutputShapes = writeDoorShapes(seededOutputShapes, false, "target"');
    expect(seed).toBeGreaterThan(0);
    expect(seed).toBeLessThan(src.indexOf("reachingPathway = await recommendReachingPath(goal, seededOutputShapes ?? null);", seed));
  });
  test("satisfier and vesselResolve stay unconditional and count their refusals", () => {
    expect(src).toContain('noteWriteRefusal("satisfier", _fsBlocked.length);');
    expect(after("const vesselResolveShapeInner = async (shape: string)", 1200)).toContain('noteWriteRefusal("vessel_resolve");');
  });
  test("admission: set only where the edit-intent route hands off to feature_compose, carried to every walk", () => {
    expect(after('if (earlyHandoff.route === "feature_compose" && earlyHandoff.target) {', 120)).toContain("_changeAdmitted = true;");
    expect(src.match(/_changeAdmitted = true/g)?.length).toBe(1);
    expect(src).toContain("let _changeAdmitted = admittedChange({ admittedEditRoute: false, declaredOutputShapes: opts.expectedOutputShapes });");
    expect(src.match(/runGoalAsPoolWalk\(goal, \{\n\s*changeAdmitted: _changeAdmitted,/g)?.length).toBe(4);
    expect(src).toContain("const changeAdmitted = opts.changeAdmitted === true;");
  });
  test("the counters are published on /health", () => {
    expect(src).toContain("write_door: writeDoorCounters(),");
  });
});

// BEYOND THE FILESYSTEM: a store write outside the goal's product and every change shape are refused at the same doors,
// and a template's own tasks get the door in the executor (a composed learned template ran uiPanel_write, concept_write
// and code_modification_proposal on a goal not admitted; no walk door saw its tasks).
describe("write doors: store and change classes are wired", () => {
  test("the goal's product is the walk's own targets and terminals", () => {
    expect(src).toContain("const writeDoorProduct = new Set<string>([...(opts.expectedOutputShapes ?? []), ...(opts.terminalOutputShapes ?? [])]);");
  });
  test("template pick, the OR-edge forward fetch and the composite outputs pass the goal's product", () => {
    expect(src).toContain('candidates = writeDoorFilter(candidates, (c) => c.outputShapes, changeAdmitted, "template_pick", writeDoorHash, tap, (c) => normActivityId(c.id), writeDoorProduct);');
    expect(src).toContain('forward = writeDoorFilter(forward, (c) => c.outputShapes, changeAdmitted, "template_pick", writeDoorHash, tap, (c) => normActivityId(c.id), writeDoorProduct);');
    expect(after("const _c = await authorComposite(", 400)).toContain('writeDoorFilter([_c.pick], (p) => p.outputShapes, changeAdmitted, "composite_pick", writeDoorHash, tap, (p) => p.id, writeDoorProduct)');
    expect(src).toContain('writeDoorShapes(authored.inputShapes, changeAdmitted, "bridge_pick", writeDoorHash, tap, writeDoorProduct)');
  });
  test("[MUST-FAIL] template pick: the backward-chain's producer fetch passes the door before any producer is picked or recursed on", () => {
    // Measured: a question goal not admitted as a change ran learned-composition-shellresult-to-llm-completion-to-
    // memorynote-write, whose memoryNote_write task executed; a producer this fetch finds is picked with no other door.
    const door = src.indexOf('const producers = writeDoorFilter(_found, (c) => c.outputShapes, changeAdmitted, "template_pick", writeDoorHash, tap, (c) => normActivityId(c.id), writeDoorProduct);');
    expect(door).toBeGreaterThan(0);
    const pick = src.indexOf("pick = producers.find((c) => !isHollowScaffold(c.id)", door);
    expect(pick).toBeGreaterThan(door);
    expect(pick - door).toBeLessThan(400);
    // every pick drawn from a discover-by-shapes fetch in the walk is drawn from a list that passed the door
    expect(src.match(/pick = producers\.find\(/g)?.length).toBe(1);
  });
  test("[MUST-FAIL] recovery pick: a known-reaching pathway head passes the template door before it is pinned, and a refused head is excluded from the alternatives", () => {
    const pinned = src.indexOf("        nextTarget = pinnable;");
    expect(pinned).toBeGreaterThan(0);
    const door = src.lastIndexOf('} else if (templateRefused(_changeAdmitted ? null : await getTemplateLocalFirst(pinnable).catch((e) => {', pinned);
    expect(door).toBeGreaterThan(0);
    expect(src.slice(door, pinned)).toContain('_changeAdmitted, "recovery_pick", goalHashOf(goal), tap, new Set(seededOutputShapes ?? opts.expectedOutputShapes ?? []))) {');
    expect(pinned - door).toBeLessThan(1000);
    expect(src.slice(door, pinned)).toContain("doorRefusedHeads.push(pinnable);");
    expect(src).toContain("const firstPick = await recommendExcluding(goal, doorRefusedHeads, null, seededOutputShapes,");
    expect(src).toContain("const altPick = await recommendExcluding(goal, doorRefusedHeads, null, alt,");
  });
  test("[MUST-FAIL] recovery pick: a head that cannot be fetched is logged as unjudged, not silently pinned", () => {
    const pinned = src.indexOf("        nextTarget = pinnable;");
    const door = src.lastIndexOf("} else if (templateRefused(", pinned);
    expect(src.slice(door, pinned)).toContain("unjudged: head unfetchable");
    expect(src.slice(door, pinned)).not.toContain(".catch(() => null)");
  });
  test("recovery pick: the recommendation's goal product is the target it was asked for", () => {
    expect(src).toContain('writeDoorFilter([x], () => recShapes.map(String), writeDoor.admitted, "recovery_pick", writeDoor.goalHash, writeDoor.record, () => id, new Set(targetShapes ?? []))');
  });
  test("satisfier and vesselResolve refuse the rest of the class on a goal not admitted", () => {
    expect(after("const vesselResolveShapeInner = async (shape: string)", 2000)).toContain("if (!changeAdmitted && refusedWrite(shape, writeDoorProduct)) {");
    expect(src).toContain("const _doorBlocked = changeAdmitted ? [] : eligibleForSatisfier.filter((s) => !SATISFIER_FORBIDDEN_FS_WRITE.has(String(s)) && refusedWrite(String(s), writeDoorProduct));");
    expect(src).toContain("!SATISFIER_FORBIDDEN_FS_WRITE.has(String(s)) && !_doorBlocked.includes(s)");
    expect(src).toContain('noteWriteRefusal("satisfier", _doorNew.length); tap(writeDropLine("satisfier", _doorNew, writeDoorHash));');
  });
  test("task level: every template run the walk and the recovery loop make carries the door to the executor", () => {
    expect(src.match(/host\.runTemplate\([^)]*\{[^}]*goalContext: \{ goal \},\n\s*\/\/ WRITE DOOR \(task level\)[^\n]*\n\s*\.\.\.taskWriteDoor\(changeAdmitted, writeDoorProduct\),/g)?.length).toBe(2);
    expect(src.match(/host\.runTemplate\(/g)?.length).toBe(2);
    expect(after("result = await host.runGoal(goal ?? `execute template ${nextTarget}`, {", 700)).toContain("...taskWriteDoor(_changeAdmitted, seededOutputShapes ?? opts.expectedOutputShapes ?? []),");
  });
  test("the executor's own drop counts are on /health, null on a dist without them", () => {
    expect(src).toContain("write_door_ias_task: (iasExecutor as unknown as { writeDoorTaskCounters?: () => unknown }).writeDoorTaskCounters?.() ?? null,");
  });
});

// WHAT A TEMPLATE WRITES, AT EVERY PICK THAT RUNS ONE (write-door.ts templateRunRefused, DoorRefusals). Measured: the
// template_pick door dropped learned-composition-test-suite-to-substrategap-write twice, then the composite author
// re-offered it with outputs [test_suite] and the composite door, judging only those outputs, let it run.
describe("write doors: run shapes and the dispatch's refusals are wired", () => {
  test("[MUST-FAIL] composite pick: the composite's own run shapes and the dispatch's refusals are judged before it is picked", () => {
    const at = after("const _c = await authorComposite(", 1200);
    expect(at).toContain('|| await templateRunRefused(_c.pick.id, _c.pick.outputShapes, () => getTemplateLocalFirst(_c.pick.id), changeAdmitted, "composite_pick", doorRefused, writeDoorHash, tap, writeDoorProduct))) {');
    expect(at.indexOf("templateRunRefused(")).toBeLessThan(at.indexOf('pickSource = "improvise";'));
    expect(at.indexOf("doorRefused.add(_c.pick.id);")).toBeLessThan(at.indexOf('pickSource = "improvise";'));
  });
  test("[MUST-FAIL] execute step: every pick's fetched template passes the run door before host.runTemplate", () => {
    const run = src.indexOf("trace = await host.runTemplate(template, bvars, {");
    const gate = src.lastIndexOf('if (await templateRunRefused(pick.id, pick.outputShapes ?? [], async () => template, changeAdmitted, pickSource === "improvise" ? "composite_pick" : pickSource === "bridge" ? "bridge_pick" : "template_pick", doorRefused, writeDoorHash, tap, writeDoorProduct)) {', run);
    expect(gate).toBeGreaterThan(src.indexOf("template = await getTemplateLocalFirst(pick.id);"));
    expect(run - gate).toBeLessThan(900);
    expect(src.slice(gate, run)).toContain("continue;");
  });
  test("[MUST-FAIL] horizontal bundle: each branch's template passes the run door", () => {
    const at = after("const tmpl = await getTemplateLocalFirst(c.id);", 500);
    expect(at).toContain('if (await templateRunRefused(c.id, c.outputShapes, async () => tmpl, changeAdmitted, "template_pick", doorRefused, writeDoorHash, tap, writeDoorProduct)) return null;');
    expect(at.indexOf("templateRunRefused(")).toBeLessThan(at.indexOf("host.runTemplate("));
  });
  test("[MUST-FAIL] the dispatch's record: one per dispatch, fed by every template_pick drop, taken at the terminal record", () => {
    expect(src).toContain('const doorRefused = doorRefusals.forDispatch(String(opts.variables?.dispatch_id ?? ""));');
    expect(src.match(/doorRefused\.noteDropped\(/g)?.length).toBe(3);
    expect(after("candidates = writeDoorFilter(candidates,", 300)).toContain("doorRefused.noteDropped(_preDoor, candidates, (c) => c.id);");
    expect(after("forward = writeDoorFilter(forward,", 300)).toContain("doorRefused.noteDropped(_preForward, forward, (c) => c.id);");
    expect(after("const producers = writeDoorFilter(_found,", 300)).toContain("doorRefused.noteDropped(_found, producers, (c) => c.id);");
    expect(src).toContain('doorRefusals.take(String(variables?.dispatch_id ?? record.dispatchId ?? ""));');
  });
  test("[MUST-FAIL] recovery pick: templates refused earlier in the dispatch are excluded from the pinned head and every recommendation", () => {
    expect(src).toContain("const doorRefusedHeads: string[] = _changeAdmitted ? [] : _doorRefused.list();");
    const pinned = src.indexOf("        nextTarget = pinnable;");
    expect(src.slice(src.lastIndexOf("} else if (!_changeAdmitted && _doorRefused.has(pinnable)) {", pinned), pinned)).toContain("doorRefusedHeads.push(pinnable);");
    expect(src).toContain("_doorRefused.add(pinnable);");
    expect(src).toContain("const altPickRetry = await recommendExcluding(goal, [...excluded, ...doorRefusedHeads], repairKey,");
  });
});
