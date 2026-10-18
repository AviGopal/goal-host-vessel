// EXECUTOR SHAPE (isExecutorShape) and the executor self-correction short-circuits.
// Measured: one resolve of executionTraceWithSignatures made eight heavy trace reads — the shape was
// taken for an executor because `(^|[_-])exec` matches the start of "execution", was handed shell
// commands to run, and every client-side timeout was "corrected" (executor_correction_budget turns)
// and then arg-corrected once more. The walk is a closure that cannot run without the fleet, so the
// loop is pinned by source text (pattern: write-door-wiring.test.ts); the classifier is pure.
import { describe, expect, test } from "bun:test";
import { isExecutorShape, unanswered } from "../src/executor-shape";

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

describe("unanswered: no value AND no response arrived", () => {
  test("a transport failure (timeout, refused connection) with no status is unanswered", () => {
    expect(unanswered(null, undefined, "transport: The operation timed out.")).toBe(true);
    expect(unanswered(undefined, undefined, "transport: Unable to connect. Is the computer able to access the url?")).toBe(true);
  });
  test("an HTTP 5xx is an ANSWER: a resolver host reports a resolver's throw over bad args as 500", () => {
    expect(unanswered(null, 500, "invalid URL: example")).toBe(false);
    expect(unanswered(null, 500, "pattern is required")).toBe(false);
    expect(unanswered(null, 503, "upstream unavailable")).toBe(false);
  });
  test("control: other failures and any reply are not unanswered", () => {
    expect(unanswered(null, undefined, "resolver returned empty content")).toBe(false);
    expect(unanswered(null, undefined, "egress: synthesised command introduced origin(s) x")).toBe(false);
    expect(unanswered(null, undefined, null)).toBe(false);
    expect(unanswered({ stdout: "" }, undefined, "transport: The operation timed out.")).toBe(false);
  });
});

describe("index.ts wiring", () => {
  test("all three executor sites call the shared helper; no inline exec regex remains", () => {
    expect(src).toContain('import { isExecutorShape, unanswered } from "./executor-shape";');
    expect(src.match(/\(\^\|\[_-\]\)exec/g)).toBeNull();
    expect(src).toContain('if (_em) execField = _em[2].toLowerCase(); else if (isExecutorShape(shape)) execField = "command"; }');
    expect(src).toContain("const _isExecShape = isExecutorShape(shape);");
    expect(src).toContain("eligibleForSatisfier = eligibleForSatisfier.filter((sh) => !isExecutorShape(sh));");
  });
  test("the correction loop stops on an unanswered attempt, at entry and after each re-resolve, and says so", () => {
    const loop = after("while (_deg && _tries < _correctionBudget", 1200);
    const entry = loop.indexOf("if (_tries === 0 && unanswered(direct, lastRawResolveStatus, lastRawResolveReason)) {");
    expect(entry).toBeGreaterThan(0);
    expect(entry).toBeLessThan(loop.indexOf("_tries++;"));
    expect(loop.slice(entry, loop.indexOf("_tries++;"))).toContain("_execUnanswered = true;");
    const re = after("const _re = await rawResolve(shape, ep.endpoint, ep.resolvePath, directArgs);", 1200);
    const brk = re.indexOf("if (unanswered(_re, lastRawResolveStatus, lastRawResolveReason)) {");
    expect(brk).toBeGreaterThan(0);
    const set = re.slice(brk, re.indexOf("if (_re != null) direct = _re;"));
    expect(set).toContain("_execUnanswered = true;");
    expect(set).toContain("break;");
    // an unanswered executor is reported as such, and is not marked refused
    const un = after("if (_deg && _execUnanswered) {", 600);
    expect(un).toContain("not a command failure");
    expect(un.slice(0, un.indexOf("} else if (_deg && !/returned \"0\"/.test(_deg)) {"))).not.toContain("_execRefused = true;");
  });
  test("the refusal is recorded and the post-loop arg-correction is skipped after a refusal or an unanswered resolve", () => {
    expect(after("refusing to satisfy with a failed/empty command", 200)).toContain("_execRefused = true;");
    const skip = src.indexOf("if (lastRawResolveReason && (_execRefused || _lastResolveUnanswered)) {");
    expect(skip).toBeGreaterThan(src.indexOf("_execRefused = true;"));
    // the no-response test reads the satisfier's own resolve, captured before the write read-back can overwrite it
    const cap = src.indexOf("const _lastResolveUnanswered = _execUnanswered || unanswered(direct, lastRawResolveStatus, lastRawResolveReason);");
    expect(cap).toBeGreaterThan(src.indexOf("_execRefused = true;"));
    expect(src.indexOf("const v = await verifyWritePersisted(shape, direct);", cap)).toBeLessThan(skip);
    // never the any-5xx transient classification
    expect(src.slice(cap, skip)).not.toContain("lastRawResolveTransient");
    const corr = src.indexOf("} else if (lastRawResolveReason) {\n      const correctedRaw = await llmExtractPointerArgs(shape, lastRawResolveReason);");
    expect(corr).toBeGreaterThan(skip);
    expect(src.match(/(?<!else )if \(lastRawResolveReason\) \{\n\s*const correctedRaw = await llmExtractPointerArgs/g)).toBeNull();
  });
});
