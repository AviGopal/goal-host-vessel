// A CONTAINMENT REFUSAL IS NOT REPORTED AS "THE COMMAND PRODUCED NO RESULT".
//
// A shell write refused by write-containment reaches the executor as a null result. A runtime rebinding of
// dispatchFailureReasons (a queueMicrotask block under @ts-ignore, appended after the imports of index.ts) added the
// reason "the command produced no result" for any walk log whose first entry executed a shell step with a null result,
// so the refusal read as an empty command and taught the retry nothing: the defect its own gap names. The builder is
// a plain function of the walk log's verdict markers and the terminal reason; nothing rebinds it after load.
//
// Hermetic in the same way as failed-trace-reason.test.ts: fetch is stubbed to refuse, the memory paths are temp
// paths, and the import is dynamic.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "containment-refusal-reason-"));
process.env["GOAL_FAILURE_MEMORY_PATH"] = join(TMP, "failure-memory.jsonl");
process.env["REACHED_CMD_CACHE_PATH"] ||= join(TMP, "reached-commands.jsonl");
process.env["REACH_VERDICT_SPOOL_PATH"] ||= join(TMP, "reach-spool.jsonl");
process.env["MEM_DUMP_PATH"] ||= join(TMP, "mem-dump.json");
process.env["LLM_VESSEL_ENDPOINT"] ||= "http://llm.test.invalid";

const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new TypeError("fetch refused (test: no network)"); }) as unknown as typeof fetch);
const m = await import("../src/index");
// Let any import-time microtask run before the builder is called.
await new Promise((r) => setTimeout(r, 0));
const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

afterAll(() => {
  fetchSpy.mockRestore();
  rmSync(TMP, { recursive: true, force: true });
});

const NO_RESULT = "the command produced no result";
const refusedLog = [{
  goal: "write the report file",
  judgement: { executed: [{ tool: "shell", result: null, refusal: "write-containment: path outside the allowed roots" }] },
}];

describe("a containment-refused shell write keeps its own reason", () => {
  test("the null shell result of a refusal is not reported as a command that produced no result", () => {
    const reasons = m.dispatchFailureReasons(refusedLog, "write-containment refused the shell write");
    expect(reasons).not.toContain(NO_RESULT);
    expect(reasons).toEqual(["write-containment refused the shell write"]);
  });

  test("the builder is the module's own function, not a rebinding", () => {
    expect((m.dispatchFailureReasons as unknown as { __ghv_patched?: boolean }).__ghv_patched).toBeUndefined();
    expect(INDEX.includes("dispatchFailureReasons = patched")).toBe(false);
  });

  test("control: the verdict markers and the terminal reason are still read, in order", () => {
    const log = ["walk: HOLLOW — five families instead of one; β-penalised", "x attempt 1/2 via t: TRACE FAILED — parse(csv): bad row"];
    expect(m.dispatchFailureReasons(log, "terminal reason")).toEqual(["five families instead of one", "parse(csv): bad row", "terminal reason"]);
  });
});
