// A DEFERRAL OPENED BEFORE THE ORIGINATOR STAMP IS JUDGED BY ITS RECORD'S INITIATOR.
//
// Self-goals expire to judge (USER ruling 2026-10-30T03:21:09Z) keys the short window on deferredReach.originator, which
// the deferral site stamps from record.initiator. A deferral opened BEFORE that commit installed carries no originator, so
// a node-self dispatch's deferral got the 7-day window and would expire ungraded, never judge-fallback. The expiry sweep
// now judges such a deferral by effectiveOriginator: record.initiator first; only if that is absent too, a node_self
// principal means "system"; anything else stays undefined (7 d). A stamped deferral is never overwritten.
//
//   [MUST-FAIL] a pre-stamp deferral on an initiator=system record falls back after 1 h (judge-fallback, one /reach,
//               no bank, no mint)
//   [CONTROL]   a pre-stamp deferral on an operator/agent record keeps 7 d (still open, no /reach)
//   [CONTROL]   a STAMPED deferral's originator is never overwritten by the derivation (stamped operator on an
//               initiator=system record stays 7 d and keeps "operator")
//   [MUST-FAIL] no initiator and a node_self principal is "system" (falls back after 1 h)
//   [MUST-FAIL] a deferral STAMPED null (its record had no initiator) is judged as absent: on a node_self record with no
//               initiator it falls back (qa ruling: null and absent are the same)
//   [MUST-FAIL] the derivation (pure): record.initiator first; node_self only when initiator is absent; a stamped
//               originator wins; absence never infers "system". At BASE the export is absent and the test sees a
//               sentinel, so it is red by assertion, not by a missing import
//   [CONTROL]   no initiator and a key principal stays 7 d; absence never infers "system"
//   [CONTROL]   a stamped null on an operator-key record keeps 7 d
//
// Fixture words from a 5-word draw (draw-words.sh): 2026-10-30T04:10:04Z seed=1793333404840590044
// words=cogwheel ebony sloppy probation reputable. The index.ts cases run in a CHILD bun process on temp stores.
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostStateEnv } from "./fixtures/host-state-env";

const PV = (await import("../src/person-verdict")) as Record<string, any>;

describe("effectiveOriginator (pure)", () => {
  it("[MUST-FAIL] record.initiator first; node_self only when initiator is absent; absence never infers system; stamped wins", () => {
    const eo = PV["effectiveOriginator"] ?? (() => "absent");
    expect(eo({}, { initiator: "system" })).toBe("system");
    expect(eo({}, { initiator: "operator", principal: { kind: "node_self" } })).toBe("operator");
    expect(eo({}, { principal: { kind: "node_self" } })).toBe("system");
    expect(eo({}, { principal: { kind: "key" } })).toBeUndefined();
    expect(eo({}, {})).toBeUndefined();
    expect(eo({ originator: "operator" }, { initiator: "system" })).toBe("operator");
    expect(eo({ originator: null }, { initiator: "system" })).toBe("system");
    expect(eo({ originator: null }, { principal: { kind: "node_self" } })).toBe("system");
    expect(eo({ originator: null }, { initiator: "operator", principal: { kind: "key" } })).toBe("operator");
    expect(eo({ originator: null }, { principal: { kind: "key" } })).toBeUndefined();
  });
});

type Out = Record<string, any>;
function probe(): Out {
  const dir = mkdtempSync(join(tmpdir(), "prestamp-"));
  try {
    const p = join(dir, "probe.test.ts");
    const src = (f: string) => JSON.stringify(join(import.meta.dir, "..", "src", f));
    writeFileSync(p, `
      import { test } from "bun:test";
      test("probe", async () => {
        const m = await import(${src("index.ts")});
        const pv = await import(${src("person-verdict.ts")});
        const logs = []; const ol = console.log; console.log = (...a) => logs.push(a.map(String).join(" "));
        const fetched = [];
        globalThis.fetch = (async (u, init) => { fetched.push({ url: String(u), body: String(init?.body ?? "") }); return new Response(JSON.stringify({ updated: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }); });
        const store = m.__dispatchStoreForTests();
        const NOW = Date.now(), AGE = 70 * 60_000;
        const mk = (id, rec, stamp) => {
          const r = { dispatchId: "d-" + id, executionId: "exec-" + id, startedAt: NOW - AGE, status: "completed", goal: "the reputable cogwheel on probation", reached: true, goalReachReason: "judge: fine", learning: { oracleLabelWritten: false }, ...rec,
            deferredReach: pv.openDeferral({ executionId: "exec-" + id, completionShapes: ["llm_completion_dispatch"], reason: "judge: fine", goalHash: "g-" + id, betaWithheldReason: null, learningMode: "learn" }, NOW - AGE) };
          if (stamp !== undefined) r.deferredReach.originator = stamp;
          r.deferredReach.bank = { command: "echo ebony", field: "command", shape: "shellResult", targetShapes: [], goalText: "x" };
          store.set(r.dispatchId, r); return r;
        };
        const sys = mk("sys", { initiator: "system" });
        const op = mk("op", { initiator: "operator" });
        const stamped = mk("stamped", { initiator: "system" }, "operator");
        const selfP = mk("selfp", { principal: { kind: "node_self", label: "node-self", operator: false } });
        const keyP = mk("keyp", { principal: { kind: "key", label: "k", operator: false } });
        const nullSelf = mk("nullself", { principal: { kind: "node_self", label: "node-self", operator: false } }, null);
        const nullOp = mk("nullop", { initiator: "operator", principal: { kind: "key", label: "k", operator: true } }, null);
        await m.expireDeferredReaches(NOW);
        await new Promise((r) => setTimeout(r, 80));
        console.log = ol;
        const reach = (id) => fetched.filter((f) => f.url.includes("/execution-traces/reach") && f.body.includes("exec-" + id)).map((f) => JSON.parse(f.body).reached);
        const view = (r, id) => ({ state: r.deferredReach.state, originator: r.deferredReach.originator === undefined ? "<unset>" : r.deferredReach.originator, reach: reach(id), bank: r.deferredReach.bank ? "kept" : null });
        process.stdout.write("RESULT " + JSON.stringify({
          sys: view(sys, "sys"), op: view(op, "op"), stamped: view(stamped, "stamped"), selfP: view(selfP, "selfp"), keyP: view(keyP, "keyp"), nullSelf: view(nullSelf, "nullself"), nullOp: view(nullOp, "nullop"),
          mintReads: fetched.filter((f) => /\\/execution-traces\\/exec-/.test(f.url)).length,
          bankLines: logs.filter((l) => l.includes("person bank")).length,
        }) + "\\n");
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

describe("the expiry sweep (child process)", () => {
  let o: Out;
  beforeAll(() => { o = probe(); }, 60_000);

  it("[MUST-FAIL] a pre-stamp deferral on an initiator=system record falls back after 1 h, with no bank and no mint", () => {
    expect(o.sys).toEqual({ state: "judge-fallback", originator: "<unset>", reach: [true], bank: null });
    expect(o.mintReads).toBe(0);
    expect(o.bankLines).toBe(0);
  });
  it("[CONTROL] a pre-stamp deferral on an operator/agent record keeps 7 d", () => {
    expect(o.op).toEqual({ state: "open", originator: "<unset>", reach: [], bank: "kept" });
  });
  it("[CONTROL] a stamped deferral's originator is never overwritten by the derivation", () => {
    expect(o.stamped).toEqual({ state: "open", originator: "operator", reach: [], bank: "kept" });
  });
  it("[MUST-FAIL] no initiator: a node_self principal falls back", () => {
    expect(o.selfP.state).toBe("judge-fallback");
  });
  it("[CONTROL] no initiator: a key principal keeps 7 d", () => {
    expect(o.keyP).toEqual({ state: "open", originator: "<unset>", reach: [], bank: "kept" });
  });
  it("[MUST-FAIL] a deferral stamped null on a node_self record with no initiator falls back, stamp left as stored", () => {
    expect(o.nullSelf).toEqual({ state: "judge-fallback", originator: null, reach: [true], bank: null });
  });
  it("[CONTROL] a stamped null on an operator-key record keeps 7 d", () => {
    expect(o.nullOp).toEqual({ state: "open", originator: null, reach: [], bank: "kept" });
  });
});
