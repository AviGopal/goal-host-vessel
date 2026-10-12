// THE WALK NEVER RUNS A SYNTHESISED COMMAND AGAINST AN ORIGIN ITS INPUTS DID NOT NAME.
//
// Replays goals through the REAL src/index.ts walk in the verdict-diff harness's hermetic child
// (test/judge-split/verdict-diff/child.ts: fetch and spawn stubbed, virtual clock, every outbound
// request recorded). The LLM's pointer_arg_extraction answers are a scripted sequence (the initial
// synthesis, then each self-correction re-synthesis), and the shell resolver (local-tools'
// shellResult) is a stub that records every command it is asked to run. Nothing is executed and no
// network request leaves the process: the test asserts both.
//
// The sequences are the hops observed on node1 (dispatch 28a669b3), verbatim in host and path:
//   step 9:  127.0.0.1:8100/landing-paths/audit → api.merlonix.com → internetvitals.com
//   step 52: 127.0.0.1:8100/landing/audit → dannykeane.com → api.github.com → api.merlonix.com → merlonix.com
//
// The harness child refuses to run where /workspace or /vessels exists (its hermetic precondition,
// shared with verdict-diff.check.ts), so this file runs on a host checkout, not inside the container.
// The rule itself is pinned by test/command-egress.test.ts, which runs anywhere.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULTS_PATH, HARNESS_DIR, childEnv } from "./judge-split/verdict-diff/runner";

const TREE = resolve(import.meta.dir, "..");
const HERMETIC = !existsSync("/workspace") && !existsSync("/vessels");

interface Rec { url: string; method: string; route: string; body: any }
interface Replay { requests: Rec[]; shellCommands: string[]; synthCalls: number; log: string }

function scenario(id: string, goal: string, commands: string[], shellRespond: Array<{ body: string[]; stdout: string; exitCode?: number }> = [], shellDefault: Record<string, unknown> = { json: { stdout: "", stderr: "", exitCode: 0 } }) {
  return {
    id,
    description: "command-egress loop test (not part of the verdict-diff corpus)",
    routes: [
      // The goal's target is the executor shape, so the walk reaches the satisfier and its loop.
      { id: "llm:target-inference", method: "POST", caller: "goal-host:goal_target_inference",
        respond: { llm: "{\"target_shapes\": [\"shellResult\"], \"confidence\": 0.9, \"alternatives\": []}" } },
      { id: "schema:shellResult", method: "POST", type: "resolver_schema", body: ["\"shape\":\"shellResult\""],
        respond: { json: { success: true, shape: "resolver_schema", body: { shape: "shellResult", known: true, fields: [{ name: "command", required: true, type: "string" }] } } } },
      { id: "llm:arg-extraction", method: "POST", caller: "goal-host:pointer_arg_extraction",
        sequence: commands.map((c) => ({ llm: JSON.stringify({ command: c }) })) },
      ...shellRespond.map((r, i) => ({ id: `tools:shellResult:${i}`, method: "POST", type: "shellResult", body: r.body, respond: { json: { stdout: r.stdout, stderr: "", exitCode: r.exitCode ?? 0 } } })),
      // Every other command: the endpoint answers nothing (degenerate), which is what drives the
      // self-correction loop.
      { id: "tools:shellResult", method: "POST", type: "shellResult", respond: shellDefault },
      { id: "judge", method: "POST", caller: "goal-host:reach_verification", respond: { llm: "{\"reached\": false, \"reason\": \"no value\", \"completion_shapes\": []}" } },
      { id: "floor:answer", method: "POST", caller: "goal-host:floor_tool_loop", respond: { json: { success: true, shape: "llmTextCompletion", body: { text: "UNKNOWN" } } } },
    ],
    steps: [{ op: "runGoal", body: { goal } }],
  };
}

async function replay(sc: ReturnType<typeof scenario>): Promise<Replay> {
  const ws = mkdtempSync(join(tmpdir(), "egress-loop-"));
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
    const requests = rec.requests ?? [];
    const logPath = out.replace(/\.json$/, ".log.json");
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const shellCommands = requests
      .filter((r) => r.body?.impulse?.pointer?.type === "shellResult")
      .map((r) => String(r.body.impulse.pointer.command ?? ""));
    const synthCalls = requests.filter((r) => r.route === "llm:arg-extraction").length;
    return { requests, shellCommands, synthCalls, log };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** No request left the process for a real host: every URL is a stubbed *.test.invalid or loopback test port. */
function assertNoRealEgress(r: Replay): void {
  const hosts = new Set(r.requests.map((q) => { try { return new URL(q.url).hostname; } catch { return q.url; } }));
  for (const h of hosts) expect(h.endsWith(".test.invalid") || h === "127.0.0.1").toBe(true);
}

const INVENTED = ["merlonix", "internetvitals", "dannykeane", "api.github.com", "api.ipify.org"];
const ranInvented = (r: Replay) => r.shellCommands.filter((c) => INVENTED.some((h) => c.includes(h)));

const STEP9 = [
  "curl -s 'http://127.0.0.1:8100/landing-paths/audit?since=24h' | jq '.paths | length'",
  "curl -s 'https://api.merlonix.com/v1/public/landing-paths/audit?since=24h' | jq '.paths | length'",
  "curl -s https://internetvitals.com/api/v1/health | jq .",
  "curl -s 'https://api.merlonix.com/v1/public/landing-paths/audit?since=24h' | head -c 4000",
];
const STEP52 = [
  "curl -s http://127.0.0.1:8100/landing/audit | jq '.lanes | length'",
  "curl -s https://dannykeane.com/developers/api | head -c 4000",
  "curl -s 'https://api.github.com/repos/your/repository/commits?since=2026-10-10T00:00:00Z' | jq length",
  "curl -s 'https://api.merlonix.com/v1/public/improvement-lane-status?since=2026-10-10T00:00:00Z' | jq .",
  "curl -s https://merlonix.com/docs/public-api/ | head -c 4000",
];
const GOAL9 = "Run the landing-paths audit for the last 24h and report how many landing paths it lists.";
const GOAL52 = "Run the landing audit and report how many improvement lanes it lists.";

describe.skipIf(!HERMETIC)("self-correction never runs a rewrite that changes the original command's origin", () => {
  test("(a) step 9: the local audit is run; the api.merlonix.com and internetvitals.com rewrites are REFUSED, never run", async () => {
    const r = await replay(scenario("egress-step9", GOAL9, STEP9));
    assertNoRealEgress(r);
    // The original local command did reach the shell resolver (positive control: the loop was entered).
    expect(r.shellCommands.some((c) => c.includes("127.0.0.1:8100/landing-paths/audit"))).toBe(true);
    expect(r.synthCalls).toBeGreaterThanOrEqual(2);
    expect(ranInvented(r)).toEqual([]);
    expect(r.log).toContain("REJECTED re-synthesis #1 — it introduced origin(s) https://api.merlonix.com:443");
    expect(r.log).toContain("ABANDONED correction");
    // No inspection credit for a host that was never run (qa): the budget never rose.
    expect(r.log).not.toContain("crediting the turn back");
  }, 120_000);

  test("(a) step 52: dannykeane.com → api.github.com → api.merlonix.com → merlonix.com are all REFUSED, never run", async () => {
    const r = await replay(scenario("egress-step52", GOAL52, STEP52));
    assertNoRealEgress(r);
    expect(r.shellCommands.some((c) => c.includes("127.0.0.1:8100/landing/audit"))).toBe(true);
    expect(ranInvented(r)).toEqual([]);
    expect(r.log).toContain("it introduced origin(s) https://dannykeane.com:443");
    expect(r.log).not.toContain("crediting the turn back");
  }, 120_000);

  test("(b) a local→local fix (same host:port, new path, flags and quoting; localhost alias) is allowed and RUN", async () => {
    const fixed = "curl -sS \"http://localhost:8100/landing-paths/audit?since=24h&format=json\" | jq -r '.paths | length'";
    const r = await replay(scenario("egress-local-fix", GOAL9, [STEP9[0]!, fixed], [{ body: ["localhost:8100/landing-paths/audit"], stdout: "12\n" }]));
    assertNoRealEgress(r);
    expect(r.shellCommands).toContain(fixed);
    expect(r.log).not.toContain("REJECTED re-synthesis");
  }, 120_000);

  test("(c) an external original corrected on the SAME host runs; a hop to another external host is refused", async () => {
    const goal = "Using the JPL Horizons API at ssd.jpl.nasa.gov, what is the distance from Earth to Io in AU right now?";
    const orig = "curl -s 'https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND=501' | head -c 4000 | jq .";
    const same = "curl -s 'https://ssd.jpl.nasa.gov/api/horizons.api?format=json&COMMAND=%27501%27&QUANTITIES=%2720%27' | jq -r .result";
    const other = "curl -s https://api.le-systeme-solaire.net/rest/bodies/io | jq .semimajorAxis";
    const ok = await replay(scenario("egress-jpl-same", goal, [orig, same], [{ body: ["QUANTITIES"], stdout: "4.2\n" }]));
    assertNoRealEgress(ok);
    expect(ok.shellCommands).toContain(same);
    const bad = await replay(scenario("egress-jpl-other", goal, [orig, other]));
    assertNoRealEgress(bad);
    expect(bad.shellCommands.some((c) => c.includes("ssd.jpl.nasa.gov"))).toBe(true);
    expect(bad.shellCommands.some((c) => c.includes("le-systeme-solaire"))).toBe(false);
    expect(bad.log).toContain("it introduced origin(s) https://api.le-systeme-solaire.net:443");
  }, 120_000);

  test("(d) an original with no URL, rewritten to add one, is refused", async () => {
    const goal = "How many TypeScript files are in repos/goal-host-vessel/src?";
    const r = await replay(scenario("egress-no-url", goal, ["find repos/goal-host-vessel/src -name '*.tsx' | wc -l | grep -v '^0$'", "curl -s https://api.github.com/repos/AviGopal/goal-host-vessel/contents/src | jq length"]));
    assertNoRealEgress(r);
    expect(r.shellCommands.some((c) => c.includes("find repos/goal-host-vessel/src"))).toBe(true);
    expect(ranInvented(r)).toEqual([]);
    expect(r.log).toContain("it introduced origin(s) https://api.github.com:443");
  }, 120_000);

  test("(f) an ATTEMPT-1 synthesis of an invented external host the goal never named is refused without being run", async () => {
    const r = await replay(scenario("egress-attempt1", GOAL52, ["curl -s https://dannykeane.com/developers/api | jq ."]));
    assertNoRealEgress(r);
    expect(r.synthCalls).toBeGreaterThanOrEqual(1);
    expect(ranInvented(r)).toEqual([]);
    expect(r.log).toContain("REFUSED the synthesised command — it introduced origin(s) https://dannykeane.com:443");
  }, 120_000);

  test("(g) the IP-echo class: api.ipify.org is refused unless the goal names it", async () => {
    const cmd = "curl -s 'https://api.ipify.org?format=json' | jq -r .ip";
    const refused = await replay(scenario("egress-ipify", "What is this node's public IP address?", [cmd]));
    assertNoRealEgress(refused);
    expect(ranInvented(refused)).toEqual([]);
    expect(refused.log).toContain("https://api.ipify.org:443");
    const named = await replay(scenario("egress-ipify-named", "What public IP address does api.ipify.org report for this node?", [cmd], [{ body: ["api.ipify.org"], stdout: "203.0.113.7\n" }]));
    assertNoRealEgress(named);
    expect(named.shellCommands).toContain(cmd);
  }, 120_000);

  test("(h) every entry path: arg-correction and the producer-scan re-entry (vessel-resolver candidate) refuse too", async () => {
    // A 503 from the shell resolver is TRANSIENT, so after the satisfier gives up the producer scan
    // un-poisons shellResult and re-enters vesselResolveShape (the "injecting vesselResolve step"
    // path), which synthesises a fresh command. Every LLM answer after the first is the external host.
    const r = await replay(scenario("egress-producer-scan", GOAL9, [STEP9[0]!, STEP9[1]!], [], { status: 503, text: "upstream unavailable" }));
    assertNoRealEgress(r);
    expect(r.shellCommands.some((c) => c.includes("127.0.0.1:8100/landing-paths/audit"))).toBe(true);
    expect(ranInvented(r)).toEqual([]);
    expect(r.log).toContain("REJECTED re-synthesis #1");
    expect(r.log).toContain("arg-correction REFUSED — it introduced origin(s) https://api.merlonix.com:443");
    expect(r.log).toContain("injecting vesselResolve step");
    expect(r.log).toContain("REFUSED the synthesised command — it introduced origin(s) https://api.merlonix.com:443");
  }, 120_000);
});
