// A LANDING IS NOT A REACH, AT THE REACH GATE'S FAVORABLE-COMPOSE CHECK (sibling of the landed latch,
// landed-latch-needs-a-decided-post-state.test.ts).
//
// verifyGoalReachedUnrestricted credits a FAVORABLE featureComposeReport whose named sha is confirmed on origin/dev
// (confirmComposeLanding). The goal's edit was checked only for REFUTATION: verifyEditPostState false fell through to
// the gate, and null (no add/replace symbol it can parse, an unreadable file, or no goal file on the landing's vessel)
// still credited reached:true, strong (deterministic:true) when the report carried verified + reachable_symbols. Rule:
// the check credits only when the probe ran and confirmed the edit (true); undecided is an oracle abstain with the
// landing in the reason; refuted falls through as before.
//
// Test seam: index.ts boots a server on import, so the check is cut out of src/index.ts (the favorableCompose test to
// the next check's comment) and transpiled, as landed-latch-needs-a-decided-post-state.test.ts does, with its
// collaborators injected. oracleAbstainVerdict is cut from the source too, so the abstain record is the real one.
import { describe, expect, test } from "bun:test";

const src = require("node:fs").readFileSync(`${import.meta.dir}/../src/index.ts`, "utf8") as string;
const tp = new Bun.Transpiler({ loader: "ts" });
const from = src.indexOf("    const favorableCompose = dig.split(\"\\n\").some((l) =>");
const to = src.indexOf("    // Residual 2 (honest-grade)", from);
const blockTs = src.slice(from, to);
const abstainStart = src.indexOf("function oracleAbstainVerdict(");
const abstainTs = src.slice(abstainStart, src.indexOf("\n}\n", abstainStart) + 2);

const SHA = "b2".repeat(20);
const GOAL = "in repos/fixture-vessel/src/quiesce.ts make the drain wait for in-flight work";
const DIG = `- featureComposeReport: {"verdict":"FAVORABLE","semantic_gate":{"verified":true,"reachable_symbols":["drain"]},"cutovers":[{"new_git_sha":"${SHA}"}]}`;

type Run = { v: Record<string, unknown> | "fell-through"; decisions: unknown[][] };
async function runCheck(postOk: boolean | null): Promise<Run> {
  const decisions: unknown[][] = [];
  const fn = new Function(
    "confirmComposeLanding", "verifyEditPostState", "noteOracleDecision",
    `${tp.transformSync(abstainTs)}\n${tp.transformSync(`async function check(goal: string, dig: string) {\n${blockTs}\nreturn "fell-through";\n}\n`)}\nreturn check;`,
  )(
    async (d: string) => (d.includes(SHA) ? { vessel: "fixture-vessel", sha: SHA } : null),
    async () => postOk,
    async (...a: unknown[]) => { decisions.push(a); },
  ) as (goal: string, dig: string) => Promise<Record<string, unknown> | "fell-through">;
  return { v: await fn(GOAL, DIG), decisions };
}

describe("the favorable-compose check credits only a decided post-state", () => {
  test("cut the real check", () => {
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    expect(blockTs).toContain("await confirmComposeLanding(dig)");
    expect(blockTs).toContain("await verifyEditPostState(goal, _fm[0], _composeLanding.sha)");
    expect(blockTs).toContain("deterministic:favorable-compose");
  });

  test("[MUST-FAIL] a confirmed landing with an undecided post-state (null) is not reached: an oracle abstain, no deterministic reason", async () => {
    const { v, decisions } = await runCheck(null);
    expect(v).not.toBe("fell-through");
    const r = v as Record<string, unknown>;
    expect(r.reached).toBe(false);
    expect(r.deterministic).not.toBe(true);
    expect(String(r.reason)).not.toMatch(/^deterministic:/);
    expect(String(r.reason)).toMatch(/^abstain:edit-post-state — /);
    expect((r.abstain as { kind?: string } | undefined)?.kind).toBe("oracle-abstain");
    expect(decisions.map((d) => d[1])).toEqual(["abstain"]);
    // the landing stays visible as evidence
    expect(String(r.reason)).toContain(SHA);
  });

  test("a landing whose post-state refutes the edit (false) falls through to the reach gate, unchanged", async () => {
    const { v, decisions } = await runCheck(false);
    expect(v).toBe("fell-through");
    expect(decisions).toEqual([]);
  });

  test("control: a landing whose post-state confirms the edit (true) still credits, strong on verified substance", async () => {
    const { v, decisions } = await runCheck(true);
    const r = v as Record<string, unknown>;
    expect(r.reached).toBe(true);
    expect(r.deterministic).toBe(true);
    expect(String(r.reason)).toMatch(/^deterministic:favorable-compose — /);
    expect(r.completion_shapes).toEqual(["featureComposeReport"]);
    expect(decisions).toEqual([]);
  });
});
