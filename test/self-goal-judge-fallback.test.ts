// SELF-GOALS EXPIRE TO JUDGE (USER ruling 2026-10-30T03:21:09Z, "Self-goals expire to judge").
//
// A judge-only reach is deferred to a person (person-verdict.ts). When the dispatch's ORIGINATOR is the system (a
// node-self goal, no person principal) it now waits only the shaped tuning row selfGoalVerdictWindowMs, then falls back
// to the judge's walk-end grading: its /reach is delivered as the judge said, alpha stays withheld at the walk's credit
// gate, and nothing is banked or minted on the judge's word alone. A person-originated deferral keeps the 7-day
// personVerdictWindowMs; a person verdict inside the short window still decides a self-goal.
//
//   [MUST-FAIL] a system-originated deferral past the short window falls back to judge grading: one /reach reached:true,
//               state judge-fallback, reachDecidedBy judge, no bank line, no mint read
//   [MUST-FAIL] the window follows the originator, from shaped tuning rows (default 1 h for the system, 7 d otherwise)
//   [CONTROL]   an operator- or agent-initiated deferral (initiator "operator", a key) keeps 7 d: untouched at the same age
//   [CONTROL]   a person verdict inside the 1 h window decides a system deferral normally (the person's verdict, no fallback)
//   [CONTROL]   an observe self-goal resolves ungraded (no /reach)
//
// Fixture words from a 5-word draw (draw-words.sh): 2026-10-30T03:37:41Z seed=1793331461630928134
// words=stimulus crafter slicer enjoying sensuous. The index.ts cases run in a CHILD bun process with every store under a
// temp dir (hostStateEnv) and fetch stubbed.
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostStateEnv } from "./fixtures/host-state-env";

const PV = (await import("../src/person-verdict").catch(() => ({}))) as Record<string, any>;
const ST = (await import("../src/selection-tuning")) as Record<string, any>;
const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
const MIN = 60_000, DAY = 86_400_000;

describe("the window follows the originator", () => {
  it("[MUST-FAIL] system 1 h, everyone else 7 d, both shaped rows; the deferral site records the originator", () => {
    expect(ST["SELECTION_TUNING_DEFAULTS"]["selfGoalVerdictWindowMs"]).toBe(60 * MIN);
    expect(ST["SELECTION_TUNING_DEFAULTS"]["personVerdictWindowMs"]).toBe(7 * DAY);
    const w = { personVerdictWindowMs: 7 * DAY, selfGoalVerdictWindowMs: 60 * MIN };
    expect(PV["deferralWindowMs"]?.({ originator: "system" }, w)).toBe(60 * MIN);
    expect(PV["deferralWindowMs"]?.({ originator: "operator" }, w)).toBe(7 * DAY);
    expect(PV["deferralWindowMs"]?.({}, w)).toBe(7 * DAY);
    expect(PV["expiryOutcome"]?.({ originator: "system", learningMode: "learn" })).toBe("judge-fallback");
    expect(PV["expiryOutcome"]?.({ originator: "system", learningMode: "observe" })).toBe("ungraded");
    expect(PV["expiryOutcome"]?.({ originator: "operator" })).toBe("ungraded");
    expect(SRC).toContain("record.deferredReach.originator = record.initiator ?? null;");
  });
});

type Out = Record<string, any>;
function probe(): Out {
  const dir = mkdtempSync(join(tmpdir(), "self-goal-"));
  try {
    const p = join(dir, "probe.test.ts");
    const src = (f: string) => JSON.stringify(join(import.meta.dir, "..", "src", f));
    writeFileSync(p, `
      import { test } from "bun:test";
      test("probe", async () => {
        const m = await import(${src("index.ts")});
        const pv = await import(${src("person-verdict.ts")});
        const consumer = await import(${src("oracle-label-consumer.ts")});
        const logs = []; const ol = console.log; console.log = (...a) => logs.push(a.map(String).join(" "));
        const fetched = [];
        globalThis.fetch = (async (u, init) => { fetched.push({ url: String(u), body: String(init?.body ?? "") }); return new Response(JSON.stringify({ updated: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }); });
        const store = m.__dispatchStoreForTests();
        const NOW = Date.now();
        const mk = (id, originator, mode, age) => {
          const r = { dispatchId: "d-" + id, executionId: "exec-" + id, startedAt: NOW - age, status: "completed", goal: "the sensuous slicer of the stimulus crafter", reached: true, goalReachReason: "judge: fine", learning: { oracleLabelWritten: false }, initiator: originator,
            deferredReach: pv.openDeferral({ executionId: "exec-" + id, completionShapes: ["llm_completion_dispatch"], reason: "judge: fine", goalHash: "g-" + id, betaWithheldReason: null, learningMode: mode }, NOW - age) };
          r.deferredReach.originator = originator; r.deferredReach.bank = { command: "echo crafter", field: "command", shape: "shellResult", targetShapes: [], goalText: "x" };
          store.set(r.dispatchId, r); return r;
        };
        const sys = mk("sys", "system", "learn", 70 * 60_000);
        const op = mk("op", "operator", "learn", 70 * 60_000);
        const obs = mk("obs", "system", "observe", 70 * 60_000);
        const young = mk("young", "system", "learn", 30 * 60_000);
        // a person verdict inside the short window decides the young self-goal
        await consumer.consumeOracleLabel(young, { activityApiEndpoint: "http://act.test", devVesselEndpoint: "http://dev.test", apiKey: "", fetchImpl: async () => new Response(JSON.stringify({ success: true, content: JSON.stringify([{ verdict: "not_achieved", labeler: "human", labeled_by_principal: { user_id: "p1", caller_type: "session" } }]) }), { status: 200 }), decideDeferredReach: (_x, d) => m.decideDeferredReach(young, d) });
        const n = await m.expireDeferredReaches(NOW);
        await new Promise((r) => setTimeout(r, 80));
        console.log = ol;
        const reach = (id) => fetched.filter((f) => f.url.includes("/execution-traces/reach") && f.body.includes("exec-" + id)).map((f) => JSON.parse(f.body).reached);
        const out = {
          n,
          sys: { state: sys.deferredReach.state, by: sys.reachDecidedBy, reach: reach("sys"), bank: sys.deferredReach.bank ?? null, mintRead: fetched.some((f) => f.url.includes("/execution-traces/exec-sys")) },
          op: { state: op.deferredReach.state, reach: reach("op") },
          obs: { state: obs.deferredReach.state, reach: reach("obs") },
          young: { state: young.deferredReach.state, by: young.reachDecidedBy, reach: reach("young") },
          bankLines: logs.filter((l) => l.includes("person bank")).length,
          fallbackLine: logs.some((l) => l.includes("SELF-GOAL exec-sys fell back to judge grading")),
        };
        process.stdout.write("RESULT " + JSON.stringify(out) + "\\n");
      });
    `);
    const r = Bun.spawnSync([process.execPath, "test", p], {
      cwd: dir,
      env: { HOME: process.env.HOME ?? "/tmp", PATH: process.env.PATH ?? "", NODE_ENV: "test", LLM_VESSEL_ENDPOINT: "http://llm.test.invalid", ACTIVITY_API_ENDPOINT: "http://act.test", DEV_VESSEL_ENDPOINT: "http://dev.test", DISCOVERY_VESSEL_ENDPOINT: "http://127.0.0.1:9", ...hostStateEnv(dir) },
      stdout: "pipe", stderr: "pipe",
    });
    const line = r.stdout.toString().split("\n").find((l) => l.startsWith("RESULT "));
    if (!line) throw new Error(`probe produced no result: ${r.stderr.toString().slice(-2000)}`);
    return JSON.parse(line.slice("RESULT ".length));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("expiry in index.ts (child process)", () => {
  let o: Out;
  beforeAll(() => { o = probe(); }, 60_000);

  it("[MUST-FAIL] a self-goal past its short window falls back to judge grading, with no bank and no mint", () => {
    expect(o.sys.state).toBe("judge-fallback");
    expect(o.sys.by).toBe("judge");
    expect(o.sys.reach).toEqual([true]);
    expect(o.sys.bank).toBeNull();
    expect(o.sys.mintRead).toBe(false);
    expect(o.bankLines).toBe(0);
    expect(o.fallbackLine).toBe(true);
  });
  it("[CONTROL] an operator- or agent-initiated deferral (a key) keeps 7 d: untouched past the 1 h self-goal window", () => {
    expect(o.op).toEqual({ state: "open", reach: [] });
  });
  it("[CONTROL] an observe self-goal resolves ungraded, no /reach", () => {
    expect(o.obs).toEqual({ state: "expired", reach: [] });
  });
  it("[CONTROL] a person verdict inside the 1 h window decides a system deferral normally; no fallback follows", () => {
    expect(o.young).toEqual({ state: "delivered", by: "person", reach: [false] });
  });
});
