// THE PERSON-VERDICT PIPE (pending-person-verdicts.ts): a judge-only reach deferred to a person is SERVED, and a
// person's label is APPLIED WITHIN ONE SWEEP (~60 s) with nobody polling the dispatch.
//
//   [MUST-FAIL] activeDispatches with awaiting:"person_verdict" lists the open deferrals only, soonest to lapse first,
//               each with a bounded personVerdict view (no bank, no compact trace); goalWalkState carries the same view
//   [MUST-FAIL] a person's label written after the deferral is decided by the sweep alone: no goalWalkState, no GET
//               /executions/:id; "person bank APPLIED", the person's /reach, the deferral delivered
//   [MUST-FAIL] ORDERING: the sweep consumes before it expires. A person verdict on a self-goal in its final minute wins
//               over the 60-min judge fallback, and one on an operator goal in its final minute over the 7-day expiry
//   [CONTROL]   a completed run with no deferral is not listed, and its row's personVerdict is null
//   [CONTROL]   an operator-key verdict:human row and an automated row decide NOTHING on a deferral: still open, no
//               /reach, no bank (the ruling stands: neither the judge nor a key banks)
//   [CONTROL]   the sweep reads labels only for open deferrals: a run without one keeps its verdict, unread
//
// Fixture words from a 5-word draw (draw-words.sh): 2026-10-31T09:19:05Z seed=1793438345724725440
// words=reverse winnings dullness boxlike onlooker. The index.ts cases run in a CHILD bun process with every store under
// a temp dir (hostStateEnv) and fetch stubbed.
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostStateEnv } from "./fixtures/host-state-env";

const GOAL = "Tell an onlooker which boxlike stalls reversed their winnings after the dullness of the week.";
const MIN = 60_000, DAY = 86_400_000;

type Out = Record<string, any>;
function probe(): Out {
  const dir = mkdtempSync(join(tmpdir(), "pending-pv-"));
  try {
    const p = join(dir, "probe.test.ts");
    const src = (f: string) => JSON.stringify(join(import.meta.dir, "..", "src", f));
    writeFileSync(p, `
      import { test } from "bun:test";
      test("probe", async () => {
        const m = await import(${src("index.ts")});
        const pv = await import(${src("person-verdict.ts")});
        const GOAL = ${JSON.stringify(GOAL)};
        const logs = []; const ol = console.log, ow = console.warn;
        console.log = (...a) => logs.push(a.map(String).join(" ")); console.warn = (...a) => logs.push(a.map(String).join(" "));
        const person = (verdict) => ({ verdict, labeler: "human", labeled_by_principal: { user_id: "person-1", caller_type: "session" } });
        const keyRow = (verdict) => ({ verdict, labeler: "human", labeled_by_principal: { key_id: "key-verdict", auth_type: "apikey", scopes: ["read", "write", "verdict:human"] } });
        const autoRow = (verdict) => ({ verdict, labeler: "deterministic" });
        const rows = {};
        const fetched = [];
        globalThis.fetch = (async (u, init) => {
          const url = String(u), body = String(init?.body ?? "");
          fetched.push({ url, body });
          let j = null; try { j = JSON.parse(body); } catch {}
          if (j?.pointer?.type === "goal_verification_label") return new Response(JSON.stringify({ success: true, content: JSON.stringify(rows[j.pointer.execution_id] ?? []) }), { status: 200 });
          return new Response(JSON.stringify({ updated: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
        });
        const store = m.__dispatchStoreForTests();
        const NOW = Date.now();
        const mk = (id, originator, age, deferred = true) => {
          const r = { dispatchId: "d-" + id, executionId: "exec-" + id, startedAt: NOW - age, status: "completed", goal: GOAL, reached: true, goalReachReason: "judge: fine", learning: { oracleLabelWritten: false }, initiator: originator };
          if (deferred) {
            r.deferredReach = pv.openDeferral({ executionId: "exec-" + id, completionShapes: ["llm_completion_dispatch"], reason: "judge: fine", goalHash: "g-" + id, betaWithheldReason: null, learningMode: "learn" }, NOW - age);
            r.deferredReach.originator = originator;
            r.deferredReach.bank = { command: "echo boxlike " + id, field: "command", shape: "shellResult", targetShapes: ["shellResult"], goalText: "x" };
            r.deferredReach.bankStoreMark = 0;
            r.reachDecidedBy = "person";
          }
          store.set(r.dispatchId, r); return r;
        };
        const later = mk("later", "operator", 5 * ${MIN});
        const plain = mk("plain", "operator", 1 * ${MIN}, false);
        const key = mk("key", "operator", 20 * ${MIN});
        const auto = mk("auto", "operator", 30 * ${MIN});
        const selfLast = mk("selflast", "system", 60 * ${MIN} + 30_000);
        const weekLast = mk("weeklast", "operator", 7 * ${DAY} + 20_000);
        const selfOpen = mk("selfopen", "system", 10 * ${MIN});
        const resolve = async (b) => (await (await m.handleResolve(new Request("http://gh.test/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }))).json());
        // 1. the served view, before any label exists
        const listed = await resolve({ type: "activeDispatches", awaiting: "person_verdict" });
        const board = await resolve({ type: "activeDispatches" });
        const ws = await resolve({ type: "goalWalkState", dispatchId: "d-later" });
        // 2. labels arrive; only the sweep runs (no goalWalkState, no GET /executions/:id)
        rows["exec-later"] = [person("achieved")];
        rows["exec-key"] = [keyRow("achieved")];
        rows["exec-auto"] = [autoRow("achieved")];
        rows["exec-selflast"] = [person("not_achieved")];
        rows["exec-weeklast"] = [person("achieved")];
        rows["exec-plain"] = [keyRow("not_achieved")];
        const before = fetched.length;
        const n = await m.expireDeferredReaches(NOW);
        await new Promise((r) => setTimeout(r, 80));
        const sweepFetches = fetched.slice(before);
        const after = await resolve({ type: "activeDispatches", awaiting: "person_verdict" });
        console.log = ol; console.warn = ow;
        const reach = (id) => sweepFetches.filter((f) => f.url.includes("/execution-traces/reach") && f.body.includes("exec-" + id)).map((f) => JSON.parse(f.body).reached);
        const st = (r) => ({ state: r.deferredReach.state, by: r.reachDecidedBy ?? null, reach: reach(r.executionId.slice(5)), applied: logs.some((l) => l.includes("person bank APPLIED for " + r.executionId)) });
        const out = {
          listed: listed.body.dispatches.map((d) => ({ id: d.dispatchId, pv: d.personVerdict })),
          boardPlain: board.body.dispatches.find((d) => d.dispatchId === "d-plain"),
          boardText: JSON.stringify(board.body) + JSON.stringify(listed.body) + JSON.stringify(ws.body),
          ws: ws.body.personVerdict,
          n,
          later: st(later), key: st(key), auto: st(auto), selfLast: st(selfLast), weekLast: st(weekLast), selfOpen: st(selfOpen),
          plain: { reached: plain.reached, humanGraded: plain.humanGraded ?? null, read: sweepFetches.some((f) => f.body.includes('"exec-plain"')) },
          labelReads: sweepFetches.filter((f) => f.body.includes('"goal_verification_label"')).map((f) => JSON.parse(f.body).pointer.execution_id).sort(),
          walkReads: sweepFetches.filter((f) => f.url.includes("/executions/") || f.body.includes("goalWalkState")).length,
          afterIds: after.body.dispatches.map((d) => d.dispatchId),
          fallbackSelfLast: logs.some((l) => l.includes("SELF-GOAL exec-selflast fell back")),
          expiredWeekLast: logs.some((l) => l.includes("exec-weeklast EXPIRED")),
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

describe("the person-verdict pipe (index.ts, child process)", () => {
  let o: Out;
  beforeAll(() => { o = probe(); }, 60_000);

  it("[MUST-FAIL] awaiting:person_verdict lists open deferrals only, soonest to lapse first, with the bounded view", () => {
    // selflast (system, 60.5 min) and weeklast (7 d + 20 s) are past their windows but not yet swept: still open.
    expect(o.listed.map((x: any) => x.id)).toEqual(["d-selflast", "d-weeklast", "d-selfopen", "d-auto", "d-key", "d-later"]);
    const later = o.listed.find((x: any) => x.id === "d-later").pv;
    expect(Object.keys(later).sort()).toEqual(["deferredAt", "executionId", "expiresAt", "originator", "state"]);
    expect(later.executionId).toBe("exec-later");
    expect(later.state).toBe("open");
    expect(later.originator).toBe("operator");
    expect(later.expiresAt - later.deferredAt).toBe(7 * DAY);
    const self = o.listed.find((x: any) => x.id === "d-selfopen").pv;
    expect(self.originator).toBe("system");
    expect(self.expiresAt - self.deferredAt).toBe(60 * MIN);
    expect(o.ws).toEqual(later);
    // the bank candidate is never served
    expect(o.boardText).not.toContain("echo boxlike");
    expect(o.boardText).not.toContain("bankStoreMark");
  });

  it("[CONTROL] a run with no deferral is not listed, and its board row's personVerdict is null", () => {
    expect(o.listed.some((x: any) => x.id === "d-plain")).toBe(false);
    expect(o.boardPlain.personVerdict).toBeNull();
  });

  it("[MUST-FAIL] a person's label is applied by the sweep alone, with no poll", () => {
    expect(o.walkReads).toBe(0);
    expect(o.later).toEqual({ state: "delivered", by: "person", reach: [true], applied: true });
    expect(o.afterIds).not.toContain("d-later");
  });

  it("[MUST-FAIL] ORDERING: a person verdict in the final minute wins over the judge fallback and over the 7-day expiry", () => {
    expect(o.selfLast).toEqual({ state: "delivered", by: "person", reach: [false], applied: false });
    expect(o.fallbackSelfLast).toBe(false);
    expect(o.weekLast).toEqual({ state: "delivered", by: "person", reach: [true], applied: true });
    expect(o.expiredWeekLast).toBe(false);
  });

  it("[CONTROL] an operator-key row and an automated row decide nothing on a deferral", () => {
    expect(o.key).toEqual({ state: "open", by: "person", reach: [], applied: false });
    expect(o.auto).toEqual({ state: "open", by: "person", reach: [], applied: false });
    expect(o.afterIds).toEqual(expect.arrayContaining(["d-key", "d-auto", "d-selfopen"]));
    // nothing else expired or fell back this tick: the two final-minute deferrals were decided by their persons
    expect(o.n).toBe(0);
  });

  it("[CONTROL] the sweep reads labels only for open deferrals", () => {
    expect(o.labelReads).toEqual(["exec-auto", "exec-key", "exec-later", "exec-selflast", "exec-selfopen", "exec-weeklast"]);
    expect(o.plain).toEqual({ reached: true, humanGraded: null, read: false });
  });
});
