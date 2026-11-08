// A RE-RUN AFTER A SUCCESS IS DECIDED PER INSTANCE (qa R-B1).
//
// The attempt ledger keyed by producer let a producer run once per world-state key: a second bounded_shell with a
// different command, after the first one succeeded, was a "re-attempt" and, with walkBudget.max_attempts_per_producer
// absent, never ran. A ReAct-style walk needs one shell after another. Here the walk's next attempt after a success
// is decided at its send, by the instance key (shape + bound fields + world-state key): a command this producer never
// sent is a new instance and runs; the same command again is a re-attempt of that instance (off with the cap absent).
//
// Replays through the REAL src/index.ts in the verdict-diff harness's hermetic child (the pattern of
// test/walk-pool-instances.test.ts). The child refuses to run where /workspace or /vessels exists.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULTS_PATH, HARNESS_DIR, childEnv } from "./judge-split/verdict-diff/runner";

const TREE = resolve(import.meta.dir, "..");
const HERMETIC = !existsSync("/workspace") && !existsSync("/vessels");

interface Rec { url: string; method: string; route: string; body: any }

async function replay(sc: unknown): Promise<{ requests: Rec[]; log: string }> {
  const ws = mkdtempSync(join(tmpdir(), "ledger-per-instance-"));
  try {
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
    const logPath = out.replace(/\.json$/, ".log.json");
    const logs = existsSync(logPath) ? (JSON.parse(readFileSync(logPath, "utf8")) as { logs?: string[] }).logs ?? [] : [];
    return { requests: rec.requests ?? [], log: logs.join("\n") };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

const firstWalk = (log: string): string => {
  const ends = ["recordGoalPath PRECONDITIONS", "(walk-complete)", "ADDITIVE — continuing"].map((m) => log.indexOf(m)).filter((i) => i >= 0);
  return ends.length === 0 ? log : log.slice(0, Math.min(...ends));
};
const count = (text: string, needle: string): number => text.split(needle).length - 1;
const N = 7;

/** N hops each need a bounded_shell run and refuse the run they are given (curable), so each refusal demands a new
 *  run (two hops more than shell answers, so the walk asks past the last distinct command). The shell's argument synthesis answers step-1 … step-N, then repeats step-N. No walkBudget is served (cap
 *  absent): no hop is ever re-attempted, so every new run comes from a different hop's first refusal. */
const hops = Array.from({ length: N + 2 }, (_, i) => `hop${String.fromCharCode(97 + i)}`);
const shells = () => ({
  id: "ledger-per-instance-shells",
  description: "walk ledger per-instance test (not part of the verdict-diff corpus)",
  fleet: { vessels: [
    { id: "hop-vessel", endpoint: "http://hop-vessel.test.invalid", resolve_endpoint: "/v2/impulses/resolve", shapes: [...hops, "bounded_shell"] },
  ] },
  routes: [
    { id: "llm:target-inference", method: "POST", caller: "goal-host:goal_target_inference",
      respond: { llm: JSON.stringify({ target_shapes: ["bounded_shell", ...hops], confidence: 0.9, alternatives: [] }) } },
    ...hops.map((h) => ({ id: `schema:${h}`, method: "POST", type: "resolver_schema", body: [`"shape":"${h}"`],
      respond: { json: { success: true, shape: "resolver_schema", body: { shape: h, known: true, fields: [{ name: "out", required: true, type: "string", from_shape: "bounded_shell" }] } } } })),
    { id: "schema:bounded_shell", method: "POST", type: "resolver_schema", body: ['"shape":"bounded_shell"'],
      respond: { json: { success: true, shape: "resolver_schema", body: { shape: "bounded_shell", known: true, fields: [{ name: "command", required: true, type: "string" }] } } } },
    // the hops' own argument synthesis answers nothing (their input is bound from the pool); the shell's answers the commands
    ...hops.map((h) => ({ id: `llm:arg-extraction-${h}`, method: "POST", caller: "goal-host:pointer_arg_extraction", body: [h], respond: { llm: "{}" } })),
    { id: "llm:arg-extraction", method: "POST", caller: "goal-host:pointer_arg_extraction",
      sequence: Array.from({ length: N }, (_, i) => ({ llm: JSON.stringify({ command: `echo step-${i + 1}` }) })) },
    ...Array.from({ length: N }, (_, i) => ({ id: `shell:step-${i + 1}`, method: "POST", type: "bounded_shell", body: [`echo step-${i + 1}"`],
      respond: { json: { shape: "boundedShellResult", stdout: `ran step-${i + 1}`, stderr: "", exit_code: 0 } } })),
    ...hops.map((h) => ({ id: `hop:${h}`, method: "POST", type: h, respond: { json: { success: false, error: `${h}: out is not the run this hop needs` } } })),
    { id: "judge", method: "POST", caller: "goal-host:reach_verification", respond: { llm: "{\"reached\": false, \"reason\": \"the hops refused\", \"completion_shapes\": []}" } },
    { id: "floor:answer", method: "POST", caller: "goal-host:floor_tool_loop", respond: { json: { success: true, shape: "llmTextCompletion", body: { text: "UNKNOWN" } } } },
  ],
  steps: [{ op: "runGoal", body: { goal: "Run the shell steps and report the answers." } }],
});

describe.skipIf(!HERMETIC)("a re-run after a success is decided per instance (cap absent)", () => {
  test(`${N} distinct bounded_shell instances in one walk are each a first attempt; the same instance again is refused`, async () => {
    const r = await replay(shells());
    const walk1 = firstWalk(r.log);
    const commands = r.requests.filter((q) => q.body?.impulse?.pointer?.type === "bounded_shell").map((q) => String(q.body.impulse.pointer.command));
    // the first walk sent every distinct command once, in order (a recovery walk after it starts a fresh ledger)
    expect(commands.slice(0, N)).toEqual(Array.from({ length: N }, (_, i) => `echo step-${i + 1}`));
    expect(walk1).not.toContain(`pool: instance #${N + 1} of bounded_shell`);
    // each was pooled as its own instance, and never counted as a re-attempt
    expect(walk1).toContain(`pool: instance #${N} of bounded_shell from satisfier:bounded_shell`);
    expect(walk1).not.toContain("RE-ATTEMPT satisfier:bounded_shell");
    expect(walk1).not.toContain("walkBudget.max_attempts_per_producer absent: satisfier:bounded_shell would be re-eligible");
    // the ledger's per-instance decisions are in the walk log: N-1 firsts after the first success, then the refused re-run
    expect(count(walk1, '"decision":"first"')).toBe(N - 1);
    expect(count(walk1, '"decision":"refused"')).toBe(1);
    expect(walk1).toContain("walk rawResolve bounded_shell (satisfier-direct): NOT sent — the same instance re-run is not re-attempted");
  }, 180_000);
});

/** noteS is produced by its action sibling noteS_make (the direct read always fails). hopR, on another vessel, needs noteS
 *  and refuses it (curable), so its bound demand re-runs satisfier:noteS after that success. The re-run's direct read
 *  fails again (an identical failed instance) and the action pick answers the SAME sibling call again. */
const sibling = () => ({
  id: "ledger-per-instance-sibling",
  description: "walk ledger per-instance test (not part of the verdict-diff corpus)",
  fleet: { vessels: [
    { id: "note-vessel", endpoint: "http://note-vessel.test.invalid", resolve_endpoint: "/v2/impulses/resolve", shapes: ["noteS", "noteS_make"] },
    { id: "hop-vessel", endpoint: "http://hop-vessel.test.invalid", resolve_endpoint: "/v2/impulses/resolve", shapes: ["hopR"] },
  ] },
  routes: [
    { id: "llm:target-inference", method: "POST", caller: "goal-host:goal_target_inference",
      respond: { llm: JSON.stringify({ target_shapes: ["noteS", "hopR"], confidence: 0.9, alternatives: [] }) } },
    { id: "schema:hopR", method: "POST", type: "resolver_schema", body: ['"shape":"hopR"'],
      respond: { json: { success: true, shape: "resolver_schema", body: { shape: "hopR", known: true, fields: [{ name: "n", required: true, type: "string", from_shape: "noteS" }] } } } },
    { id: "schema:noteS", method: "POST", type: "resolver_schema", body: ['"shape":"noteS"'],
      respond: { json: { success: true, shape: "resolver_schema", body: { shape: "noteS", known: true, fields: [{ name: "title", required: true, type: "string" }] } } } },
    { id: "llm:arg-extraction", method: "POST", caller: "goal-host:pointer_arg_extraction", respond: { llm: JSON.stringify({ title: "t1" }) } },
    { id: "llm:action", method: "POST", caller: "goal-host:action_shape_selection", respond: { llm: JSON.stringify({ shape: "noteS_make", args: { title: "t1" } }) } },
    { id: "hop:noteS_make", method: "POST", type: "noteS_make", respond: { json: { success: true, shape: "noteS_make", body: { made: "t1" } } } },
    { id: "hop:noteS", method: "POST", type: "noteS", respond: { json: { success: false, error: "noteS: t1 is not readable here" } } },
    { id: "hop:hopR", method: "POST", type: "hopR", respond: { json: { success: false, error: "hopR: n is not the note this hop needs" } } },
    { id: "judge", method: "POST", caller: "goal-host:reach_verification", respond: { llm: "{\"reached\": false, \"reason\": \"hopR refused\", \"completion_shapes\": []}" } },
    { id: "floor:answer", method: "POST", caller: "goal-host:floor_tool_loop", respond: { json: { success: true, shape: "llmTextCompletion", body: { text: "UNKNOWN" } } } },
  ],
  steps: [{ op: "runGoal", body: { goal: "Make the note and report what the hop answers." } }],
});

describe.skipIf(!HERMETIC)("a re-run after a success checks its action sibling's send too (cap absent)", () => {
  test("the same sibling call the earlier success made is not sent again", async () => {
    const r = await replay(sibling());
    const walk1 = firstWalk(r.log);
    expect(walk1).toContain('satisfier action "noteS_make" produced');
    expect(walk1).toContain("bound demand — hopR refused with hopR.n bound to noteS");
    expect(walk1).toContain("walk rawResolve noteS_make (satisfier-action): NOT sent — the same instance re-run is not re-attempted");
    expect(walk1).toContain('"producer":"satisfier:noteS"');
    // one sibling call in the first walk (a recovery walk after it starts a fresh ledger)
    expect(count(walk1, 'satisfier action "noteS_make" produced')).toBe(1);
  }, 180_000);
});
