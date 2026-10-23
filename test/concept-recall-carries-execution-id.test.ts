// KNOWN-WRONG 21, goal-host's link: a reached walk credited none of the concepts it recalled, because the concept
// search goal-host sends named no execution, so concept-db could not tie a recall to the run that used it.
//
// recallConceptRows now builds its search pointer with conceptRecallPointer, which carries the dispatch's id as
// `execution_id` when the recall runs inside a dispatch. A cache hit sends no request, so an in-dispatch recall reads
// fresh (and still fills the cache); a recall with no dispatch context keeps its cache hits and sends no execution_id.
//
// recallConceptRows is module-private: test/fixtures/concept-recall-child.ts exposes it in a CHILD process and drives
// it against a loopback concept-db stub.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "fixtures", "concept-recall-child.ts");
const MARK = "CONCEPT_RECALL_RESULT ";
interface Case { label: string; rows: number[]; searches: Array<Record<string, unknown>> }
let res: { exposed: boolean; cases: Case[]; refused: string[]; error?: string };
const caseOf = (label: string): Case => { const c = res.cases.find((x) => x.label === label); expect(c).toBeDefined(); return c!; };

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "concept-recall-"));
  try {
    const p = Bun.spawn([process.execPath, CHILD], { cwd: home, env: { PATH: process.env.PATH ?? "", HOME: home, NODE_ENV: "test", TZ: "UTC" }, stdout: "pipe", stderr: "pipe" });
    const kill = setTimeout(() => p.kill(), 90_000);
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    clearTimeout(kill);
    const line = stdout.split("\n").find((l) => l.startsWith(MARK));
    if (!line) throw new Error(`the child printed no result (rc ${p.exitCode}): ${stderr.slice(-800)}`);
    res = JSON.parse(line.slice(MARK.length));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);

describe("MUST-FAIL: a recall inside a dispatch names its execution", () => {
  test("two recalls of one query inside the cache TTL both reach concept-db, and both carry execution_id", () => {
    expect(res.error).toBeUndefined();
    expect(res.exposed).toBe(true);
    const c = caseOf("in-dispatch");
    expect(c.rows).toEqual([1, 1]);
    expect(c.searches.length).toBe(2);
    for (const p of c.searches) {
      expect(p["execution_id"]).toBe("dispatch-recall-1");
      expect(p["type"]).toBe("concept");
      expect(p["query"]).toBe("how to count files in a vessel");
    }
  });
});

describe("CONTROL: a recall with no dispatch context is as before", () => {
  test("no execution_id, and the second call is a cache hit (one request for two recalls)", () => {
    const c = caseOf("no-context");
    expect(c.rows).toEqual([1, 1]);
    expect(c.searches.length).toBe(1);
    expect("execution_id" in c.searches[0]!).toBe(false);
    expect(c.searches[0]).toEqual({ type: "concept", query: "how to list a vessel's routes", limit: 3 });
  });

  test("no fetch left the stub", () => { expect(res.refused).toEqual([]); });
});
