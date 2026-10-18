// EXECUTOR SHAPE (isExecutorShape) and the executor self-correction short-circuits.
// Measured: one resolve of executionTraceWithSignatures made eight heavy trace reads — the shape was
// taken for an executor because `(^|[_-])exec` matches the start of "execution", was handed shell
// commands to run, and every client-side timeout was "corrected" (executor_correction_budget turns)
// and then arg-corrected once more. The walk is a closure that cannot run without the fleet, so the
// loop is pinned by source text (pattern: write-door-wiring.test.ts); the classifier is pure.
import { describe, expect, test } from "bun:test";
import { isExecutorShape, unansweredTransiently } from "../src/executor-shape";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
const after = (anchor: string, span: number): string => {
  const i = src.indexOf(anchor);
  expect(i).toBeGreaterThan(0);
  return src.slice(i, i + span);
};

describe("isExecutorShape: the exec token is a whole word segment", () => {
  test("trace shapes that merely begin with 'exec' are not executors", () => {
    expect(isExecutorShape("executionTraceWithSignatures")).toBe(false);
    expect(isExecutorShape("execution_trace")).toBe(false);
    expect(isExecutorShape("executionTraceList")).toBe(false);
    // takes a command_id, not a command to run: the old `_exec` match handed it a shell command field
    expect(isExecutorShape("obsidian_execute_gated")).toBe(false);
  });
  test("control: real executor shapes still are", () => {
    for (const sh of ["shellResult", "exec_result", "execResult", "aws-exec-read", "run_command", "bash", "bounded_shell", "sqlResult", "script_result", "cmd"]) {
      expect(isExecutorShape(sh)).toBe(true);
    }
  });
  test("control: ordinary shapes are not", () => {
    for (const sh of ["memoryNote", "web_resource", "httpResponse", "fs_edit"]) expect(isExecutorShape(sh)).toBe(false);
  });
});

describe("unansweredTransiently", () => {
  test("no reply and a transient failure is unanswered; a reply (even a degenerate one) is not", () => {
    expect(unansweredTransiently(null, true)).toBe(true);
    expect(unansweredTransiently(undefined, true)).toBe(true);
    expect(unansweredTransiently(null, false)).toBe(false);
    expect(unansweredTransiently({ stdout: "" }, true)).toBe(false);
    expect(unansweredTransiently({ stdout: "" }, false)).toBe(false);
  });
});

describe("index.ts wiring", () => {
  test("all three executor sites call the shared helper; no inline exec regex remains", () => {
    expect(src).toContain('import { isExecutorShape, unansweredTransiently } from "./executor-shape";');
    expect(src.match(/\(\^\|\[_-\]\)exec/g)).toBeNull();
    expect(src).toContain('if (_em) execField = _em[2].toLowerCase(); else if (isExecutorShape(shape)) execField = "command"; }');
    expect(src).toContain("const _isExecShape = isExecutorShape(shape);");
    expect(src).toContain("eligibleForSatisfier = eligibleForSatisfier.filter((sh) => !isExecutorShape(sh));");
  });
  test("the correction loop stops on a transiently unanswered attempt, at entry and after each re-resolve", () => {
    const loop = after("while (_deg && _tries < _correctionBudget", 1200);
    expect(loop.indexOf("if (_tries === 0 && unansweredTransiently(direct, lastRawResolveTransient)) {")).toBeLessThan(loop.indexOf("_tries++;"));
    expect(loop).toContain("if (_tries === 0 && unansweredTransiently(direct, lastRawResolveTransient)) {");
    const re = after("const _re = await rawResolve(shape, ep.endpoint, ep.resolvePath, directArgs);", 1200);
    const brk = re.indexOf("if (unansweredTransiently(_re, lastRawResolveTransient)) {");
    expect(brk).toBeGreaterThan(0);
    expect(brk).toBeLessThan(re.indexOf("if (_re != null) direct = _re;"));
    expect(re.slice(brk, re.indexOf("if (_re != null) direct = _re;"))).toContain("break;");
  });
  test("the refusal is recorded and the post-loop arg-correction is skipped after a refusal or a transient failure", () => {
    expect(after("refusing to satisfy with a failed/empty command", 200)).toContain("_execRefused = true;");
    const skip = src.indexOf("if (lastRawResolveReason && (_execRefused || _lastResolveTransient)) {");
    expect(skip).toBeGreaterThan(src.indexOf("_execRefused = true;"));
    // the transient flag is the satisfier's own resolve, captured before the write read-back can overwrite it
    const cap = src.indexOf("const _lastResolveTransient = lastRawResolveTransient;");
    expect(cap).toBeGreaterThan(src.indexOf("_execRefused = true;"));
    expect(cap).toBeLessThan(src.indexOf("const v = await verifyWritePersisted(shape, direct);", cap));
    expect(src.indexOf("const v = await verifyWritePersisted(shape, direct);", cap)).toBeLessThan(skip);
    const corr = src.indexOf("} else if (lastRawResolveReason) {\n      const correctedRaw = await llmExtractPointerArgs(shape, lastRawResolveReason);");
    expect(corr).toBeGreaterThan(skip);
    expect(src.match(/(?<!else )if \(lastRawResolveReason\) \{\n\s*const correctedRaw = await llmExtractPointerArgs/g)).toBeNull();
  });
});
