// THE READ-ONLY SHELL GATE NEVER LETS A VERIFIER OR A RECIPE REACH AN ORIGIN THE GOAL DID NOT NAME.
//
// `isReadOnlyShellCommand` (src/independent-recompute.ts) is the only gate in front of two paths
// that run a command nobody typed: the reach verifier's independent derivations
// (recomputeIndependently, authored by a model from the goal text) and the learned family recipes
// (recipeCommandFor: floor seed, walk answer, executor recovery). It admitted curl to any host. These
// replays drive the REAL src/index.ts walk through the verdict-diff harness's hermetic child
// (test/judge-split/verdict-diff/child.ts: fetch and spawn stubbed, virtual clock, every outbound
// request recorded), with the shell resolver (local-tools' shellResult) a stub that records every
// command it is asked to run. Nothing is executed and no request leaves the process; each test
// asserts both.
//
// Like test/command-egress-loop.test.ts, the child refuses to run where /workspace or /vessels
// exists, so this file runs on a host checkout. The rule itself is pinned by
// test/read-only-gate-egress.test.ts, which runs anywhere.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULTS_PATH, HARNESS_DIR, childEnv } from "./judge-split/verdict-diff/runner";

const TREE = resolve(import.meta.dir, "..");
const HERMETIC = !existsSync("/workspace") && !existsSync("/vessels");

interface Rec { url: string; method: string; route: string; body: any }
interface Replay { requests: Rec[]; shellCommands: string[]; recomputeAuthorings: number; log: string }

const RECOMPUTE_PROMPT = "Author ONE read-only shell command that MEASURES the answer";

function scenario(id: string, goal: string, opts: { walk: string[]; recompute?: string[]; shell?: Array<{ body: string[]; stdout: string }> }) {
  return {
    id,
    description: "read-only gate egress loop test (not part of the verdict-diff corpus)",
    routes: [
      { id: "llm:target-inference", method: "POST", caller: "goal-host:goal_target_inference",
        respond: { llm: "{\"target_shapes\": [\"shellResult\"], \"confidence\": 0.9, \"alternatives\": []}" } },
      { id: "schema:shellResult", method: "POST", type: "resolver_schema", body: ["\"shape\":\"shellResult\""],
        respond: { json: { success: true, shape: "resolver_schema", body: { shape: "shellResult", known: true, fields: [{ name: "command", required: true, type: "string" }] } } } },
      { id: "llm:arg-extraction", method: "POST", caller: "goal-host:pointer_arg_extraction",
        sequence: opts.walk.map((c) => ({ llm: JSON.stringify({ command: c }) })) },
      // The verifier's authoring call shares the judge's caller; it is told apart by its prompt.
      // First match wins, so it sits ahead of the judge route.
      { id: "llm:recompute-authoring", method: "POST", caller: "goal-host:reach_verification", body: [RECOMPUTE_PROMPT],
        sequence: (opts.recompute ?? ["{}"]).map((c) => ({ llm: c === "{}" ? c : JSON.stringify({ command: c }) })) },
      ...(opts.shell ?? []).map((r, i) => ({ id: `tools:shellResult:${i}`, method: "POST", type: "shellResult", body: r.body, respond: { json: { stdout: r.stdout, stderr: "", exitCode: 0 } } })),
      { id: "tools:shellResult", method: "POST", type: "shellResult", respond: { json: { stdout: "", stderr: "", exitCode: 0 } } },
      { id: "judge", method: "POST", caller: "goal-host:reach_verification", respond: { llm: "{\"reached\": false, \"reason\": \"no value\", \"completion_shapes\": []}" } },
      { id: "floor:answer", method: "POST", caller: "goal-host:floor_tool_loop", respond: { json: { success: true, shape: "llmTextCompletion", body: { text: "UNKNOWN" } } } },
    ],
    steps: [{ op: "runGoal", body: { goal } }],
  };
}

async function replay(sc: ReturnType<typeof scenario>, state: Record<string, string> = {}): Promise<Replay> {
  const ws = mkdtempSync(join(tmpdir(), "ro-gate-egress-"));
  try {
    // Durable state the module loads at boot (SUBSTRATE_STATE_DIR = <ws>/state in childEnv).
    mkdirSync(join(ws, "state"), { recursive: true });
    for (const [name, content] of Object.entries(state)) writeFileSync(join(ws, "state", name), content);
    const scPath = join(ws, "scenario.json");
    const out = join(ws, "out.json");
    writeFileSync(scPath, JSON.stringify(sc));
    const proc = Bun.spawn([process.execPath, join(HARNESS_DIR, "child.ts"), TREE, scPath, DEFAULTS_PATH, out], {
      cwd: ws, env: childEnv(ws), stdout: "pipe", stderr: "pipe",
    });
    const [code, , stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (!existsSync(out)) throw new Error(`child produced no output (exit ${code}): ${stderr.slice(-1500)}`);
    const rec = JSON.parse(readFileSync(out, "utf8")) as { fatal?: string; requests?: Rec[] };
    if (rec.fatal) throw new Error(`child fatal: ${rec.fatal}`);
    const requests = rec.requests ?? [];
    const logPath = out.replace(/\.json$/, ".log.json");
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const shellCommands = requests
      .filter((r) => r.body?.impulse?.pointer?.type === "shellResult")
      .map((r) => String(r.body.impulse.pointer.command ?? ""));
    const recomputeAuthorings = requests.filter((r) => r.route === "llm:recompute-authoring").length;
    return { requests, shellCommands, recomputeAuthorings, log };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** No request left the process for a real host: every URL is a stubbed *.test.invalid or loopback test port. */
function assertNoRealEgress(r: Replay): void {
  const hosts = new Set(r.requests.map((q) => { try { return new URL(q.url).hostname; } catch { return q.url; } }));
  for (const h of hosts) expect(h.endsWith(".test.invalid") || h === "127.0.0.1").toBe(true);
}

const recipeFile = (family: string, template: string) =>
  JSON.stringify({ family, template, originGoal: "How many subdirectories are under repos/activity-api/src?", originValue: 7, agreed: 12, disagreed: 0 }) + "\n";

const EXTERNAL = "curl -s https://api.merlonix.com/v1/x | jq .n";
const LOOPBACK = "curl -s http://127.0.0.1:8100/v2/registry/shapes | jq '.shapes|length'";
const GOAL_A = "How many landing paths does the landing-paths audit list for the last 24h?";
const WALK_A = "curl -s 'http://127.0.0.1:8100/landing-paths/audit?since=24h' | jq '.paths | length'";

const ranHost = (r: Replay, host: string) => r.shellCommands.filter((c) => c.includes(host));
const RECOVERED = "RECOVERING with the learned family recipe";

describe.skipIf(!HERMETIC)("recomputeIndependently: an authored derivation reaches only loopback or a goal-named origin", () => {
  test("(a) an LLM-proposed derivation against api.merlonix.com is REFUSED and never reaches the shell resolver", async () => {
    const r = await replay(scenario("ro-recompute-external", GOAL_A, { walk: [WALK_A], recompute: [EXTERNAL], shell: [{ body: ["landing-paths/audit"], stdout: "12\n" }] }));
    assertNoRealEgress(r);
    // Positive control: the verifier ran and asked for derivations (the path was entered).
    expect(r.recomputeAuthorings).toBeGreaterThanOrEqual(2);
    expect(r.shellCommands.some((c) => c.includes("127.0.0.1:8100/landing-paths/audit"))).toBe(true);
    // The executor stub was never asked to run the external derivation.
    expect(ranHost(r, "merlonix")).toEqual([]);
    expect(r.log).toContain("[recompute] REFUSED authored first command (network origin(s) neither loopback nor named by the goal: https://api.merlonix.com:443)");
    expect(r.log).toContain("[recompute] REFUSED authored second command");
  }, 120_000);

  test("(b) a loopback derivation (127.0.0.1:8100 registry) is allowed and RUN", async () => {
    const r = await replay(scenario("ro-recompute-loopback", GOAL_A, { walk: [WALK_A], recompute: [LOOPBACK], shell: [{ body: ["landing-paths/audit"], stdout: "12\n" }] }));
    assertNoRealEgress(r);
    expect(r.shellCommands).toContain(LOOPBACK);
    expect(r.log).not.toContain("[recompute] REFUSED");
  }, 120_000);

  test("(d) an external host the goal names is allowed and RUN", async () => {
    const goal = "How many records does the public API at api.merlonix.com report in its n field?";
    const derivation = "curl -sS https://api.merlonix.com/v1/records | jq '.n'";
    const r = await replay(scenario("ro-recompute-named", goal, { walk: ["curl -s https://api.merlonix.com/v1/records | jq -r .n"], recompute: [derivation], shell: [{ body: ["api.merlonix.com"], stdout: "5\n" }] }));
    assertNoRealEgress(r);
    expect(r.shellCommands).toContain(derivation);
    expect(r.log).not.toContain("[recompute] REFUSED");
  }, 120_000);
});

describe.skipIf(!HERMETIC)("recipe recovery: a learned family recipe runs only against loopback or a goal-named origin", () => {
  const GOAL_C = "How many subdirectories are under repos/concept-db/src?";
  // The walk's own command answers nothing, so self-correction exhausts and the recovery site is reached.
  const WALK_C = "find /workspace/git/vessels/concept-db/src -mindepth 1 -type d | wc -l | grep -v '^0$'";

  test("(c) a recipe against an external host is REFUSED at every recipe site (answer, recovery, seed, derivation) and never run", async () => {
    const r = await replay(scenario("ro-recipe-external", GOAL_C, { walk: [WALK_C] }), { "verifier-recipes.jsonl": recipeFile("subdirectory-count", "curl -s https://api.merlonix.com/v1/dirs/{{vessel}} | jq .n") });
    assertNoRealEgress(r);
    // Positive control: the recipe was loaded and the walk's executor ran (the loop was entered).
    expect(r.log).toContain("loaded 1 family recipe(s)");
    expect(r.shellCommands.some((c) => c.includes("find /workspace/git/vessels/concept-db/src"))).toBe(true);
    expect(ranHost(r, "merlonix")).toEqual([]);
    expect(r.log).not.toContain(RECOVERED);
    // (The log file is JSON, so the family's quotes are escaped there; match around them.)
    expect(r.log).toContain("[verifier-recipe] recipe for \\\"subdirectory-count\\\" REFUSED by the read-only gate (network origin(s) neither loopback nor named by the goal: https://api.merlonix.com:443) — not run");
  }, 120_000);

  test("(c) a loopback recipe RUNS, including at the recovery site", async () => {
    const recipe = "curl -s http://127.0.0.1:8100/dirs/{{vessel}} | jq .n";
    const r = await replay(scenario("ro-recipe-loopback", GOAL_C, { walk: [WALK_C] }), { "verifier-recipes.jsonl": recipeFile("subdirectory-count", recipe) });
    assertNoRealEgress(r);
    expect(r.shellCommands).toContain("curl -s http://127.0.0.1:8100/dirs/concept-db | jq .n");
    expect(r.log).toContain(RECOVERED);
    expect(r.log).not.toContain("REFUSED by the read-only gate");
  }, 120_000);

  test("(d) a recipe against a host the goal names RUNS", async () => {
    const goal = "How many subdirectories under repos/concept-db/src does the index at api.merlonix.com list?";
    const r = await replay(scenario("ro-recipe-named", goal, { walk: [WALK_C] }), { "verifier-recipes.jsonl": recipeFile("subdirectory-count", "curl -s https://api.merlonix.com/v1/dirs/{{vessel}} | jq .n") });
    assertNoRealEgress(r);
    expect(r.shellCommands).toContain("curl -s https://api.merlonix.com/v1/dirs/concept-db | jq .n");
    expect(r.log).not.toContain("REFUSED by the read-only gate");
  }, 120_000);
});
