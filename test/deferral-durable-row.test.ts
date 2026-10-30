// AN OPEN DEFERRAL ALWAYS HAS A ROW TO GRADE: A LATE VERDICT ON A PRUNED ROW IS RE-INSERTED GRADED.
//
// Gap an-open-person-verdict-deferral-has-no-protected-durable-row-so-a-late-verdict-or-fallback-matches-no-row-and-the-
// run-stays-ungraded. One cause: the deferred durable trace is persisted untagged, untagged is ungraded, and trace
// retention deletes ungraded rows, so the person's verdict (or a self-goal's judge fallback) found no row. The deferral
// now keeps a bounded compact copy, and a /reach that matches no row re-inserts it graded through the existing sink.
//
//   [MUST-FAIL] (a)+(b) a person's "achieved" on a deferred walk-satisfier reach whose row is gone (/reach updated:0) is
//               persisted: one graded insert, reached:true, tagged reinserted_from_deferral:<id> and decided_by:person
//               — through the existing decideDeferredReach + the existing sink, red at BASE by assertion (no new seam)
//   [MUST-FAIL] (a) a self-goal's judge fallback past the window on a pruned row: re-inserted reached:true with the
//               beta_withheld markers (no α on the judge's word) and decided_by:judge-fallback
//   [MUST-FAIL] (c) a lost reached verdict's gap emit that fails once is retried and delivered (existing
//               deliverReachVerdict), and (b) a deferral with nothing to patch is refused at open with a reason
//   [MUST-FAIL] a person's not_achieved on a pruned row re-inserts reached:false; the compact copy is bounded and
//               carries no content or metadata
//   [CONTROL]   a deferral whose /reach matches a row (updated:1) re-inserts nothing; no log line or insert carries the
//               copy's content; a deferral with a persisted trace, or on a template run, is not refused
//
// Fixture words from a 5-word draw (draw-words.sh): 2026-10-30T05:29:19Z seed=1793338159658922810
// words=wrongdoer campsite occultist imbecile gently. The index.ts cases run in a CHILD bun process on temp stores.
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostStateEnv } from "./fixtures/host-state-env";

const DR = (await import("../src/deferral-row").catch(() => ({}))) as Record<string, any>;

type Out = Record<string, any>;
function probe(): Out {
  const dir = mkdtempSync(join(tmpdir(), "deferral-row-"));
  try {
    const p = join(dir, "probe.test.ts");
    const src = (f: string) => JSON.stringify(join(import.meta.dir, "..", "src", f));
    writeFileSync(p, `
      import { test } from "bun:test";
      test("probe", async () => {
        const m = await import(${src("index.ts")});
        const pv = await import(${src("person-verdict.ts")});
        const dr = await import(${src("deferral-row.ts")}).catch(() => ({}));
        const logs = []; const ol = console.log, ow = console.warn, oe = console.error;
        console.log = console.warn = console.error = (...a) => logs.push(a.map(String).join(" "));
        const inserts = []; const gapPosts = []; let gapFailOnce = true;
        const rows = new Set(["exec-matched"]);
        globalThis.fetch = (async (u, init) => {
          const url = String(u), body = String(init?.body ?? "");
          if (url.endsWith("/execution-traces/reach")) { const id = JSON.parse(body).execution_id; return Response.json({ updated: rows.has(id) ? 1 : 0 }); }
          if (url.endsWith("/v2/activities/execution-traces")) { inserts.push(JSON.parse(body)); return Response.json({ ok: true }); }
          if (body.includes("substrateGap_write") && body.includes("walk-satisfier-9-999")) { gapPosts.push(1); if (gapFailOnce) { gapFailOnce = false; throw new Error("socket connection was closed unexpectedly"); } return Response.json({ ok: true }); }
          return Response.json({}, { status: 200 });
        });
        const store = m.__dispatchStoreForTests();
        const NOW = Date.now();
        const compact = (id) => (dr.compactDeferralTrace ? dr.compactDeferralTrace({ id, templateId: "satisfier:memoryNote_write", templateName: "satisfier memoryNote_write", tasks: [{ taskId: "t1", resolverId: "memoryNote_write", outputShapes: ["memoryNote_write"], success: true, content: "the occultist campsite body" }], tags: ["state_signature:x"], metadata: { answer: "the imbecile wrongdoer answer" } }) : null);
        const mk = (id, initiator, age) => {
          const r = { dispatchId: "d-" + id, executionId: id, startedAt: NOW - age, status: "completed", reached: true, goal: "gently note the campsite", goalReachReason: "judge: fine", learning: { oracleLabelWritten: false }, initiator,
            deferredReach: pv.openDeferral({ executionId: id, completionShapes: ["memoryNote_write"], reason: "judge: fine", goalHash: "g-" + id, betaWithheldReason: null, learningMode: "learn" }, NOW - age) };
          r.deferredReach.originator = initiator; r.deferredReach.reinsert = compact(id);
          store.set(r.dispatchId, r); return r;
        };
        const person = mk("walk-satisfier-1-111", "operator", 60_000);
        const personNo = mk("walk-satisfier-2-222", "operator", 60_000);
        const matched = mk("exec-matched", "operator", 60_000);
        const fallback = mk("walk-satisfier-3-333", "system", 70 * 60_000);
        await m.decideDeferredReach(person, { deliver: true, reached: true, mint: false });
        await m.decideDeferredReach(personNo, { deliver: true, reached: false, mint: false });
        await m.decideDeferredReach(matched, { deliver: true, reached: true, mint: false });
        await m.expireDeferredReaches(NOW);
        // (c) a non-deferred reached verdict whose row is gone: the lost-reached-verdict gap emit fails once
        m.deliverReachVerdict("walk-satisfier-9-999", true, ["shellResult"], "walk-complete", "judge: ok", "g9", null);
        await new Promise((r) => setTimeout(r, 2_500));
        console.log = ol; console.warn = ow; console.error = oe;
        const ins = (id) => inserts.filter((t) => (t.tags ?? []).some((g) => g === "reinserted_from_deferral:" + id) || t.id === id || t.execution_id === id);
        const tagsOf = (id) => ins(id).map((t) => t.tags ?? []);
        process.stdout.write("RESULT " + JSON.stringify({
          person: tagsOf("walk-satisfier-1-111"), personNo: tagsOf("walk-satisfier-2-222"), matched: ins("exec-matched").length, fallback: tagsOf("walk-satisfier-3-333"),
          fallbackState: fallback.deferredReach.state, gapPosts: gapPosts.length,
          copyInLogs: logs.some((l) => l.includes("occultist") || l.includes("imbecile") || l.includes("satisfier memoryNote_write")),
          insertCarriesContent: JSON.stringify(inserts).includes("occultist") || JSON.stringify(inserts).includes("imbecile"),
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

describe("a deferral's decision on a pruned row (child process)", () => {
  let o: Out;
  beforeAll(() => { o = probe(); }, 90_000);

  it("[MUST-FAIL] a person's achieved on a pruned walk-satisfier row is re-inserted graded, with provenance tags", () => {
    expect(o.person.length).toBe(1);
    expect(o.person[0]).toEqual(expect.arrayContaining(["reached:true", "reinserted_from_deferral:walk-satisfier-1-111", "decided_by:person"]));
    expect(o.person[0]).not.toContain("beta_withheld:true");
  });
  it("[MUST-FAIL] a judge fallback on a pruned row is re-inserted reached:true with the beta_withheld markers (no α)", () => {
    expect(o.fallbackState).toBe("judge-fallback");
    expect(o.fallback.length).toBe(1);
    expect(o.fallback[0]).toEqual(expect.arrayContaining(["reached:true", "beta_withheld:true", "decided_by:judge-fallback", "reinserted_from_deferral:walk-satisfier-3-333"]));
  });
  it("[MUST-FAIL] a lost reached verdict's gap emit that fails once is retried and delivered", () => {
    expect(o.gapPosts).toBe(2);
  });
  it("[MUST-FAIL] a person's not_achieved on a pruned row re-inserts reached:false (β)", () => {
    expect(o.personNo.length).toBe(1);
    expect(o.personNo[0]).toEqual(expect.arrayContaining(["reached:false", "decided_by:person"]));
  });
  it("[CONTROL] a matched row re-inserts nothing; the copy never reaches a log line or an insert's content", () => {
    expect(o.matched).toBe(0);
    expect(o.copyInLogs).toBe(false);
    expect(o.insertCarriesContent).toBe(false);
  });
});

describe("the open and the copy (pure)", () => {
  it("[MUST-FAIL] a deferral with nothing to patch is refused at open, with a reason", () => {
    const refuse = DR["deferralOpenRefusal"] ?? (() => null);
    expect(String(refuse("goal-seek:no-trace:abc", ["goal-seek:no-trace:"], null))).toContain("no row to patch");
    expect(String(refuse("walk-satisfier-4-444", [], null))).toContain("not persisted");
  });
  it("[CONTROL] a deferral with a persisted trace, or on a template run, opens (no refusal)", () => {
    const refuse = DR["deferralOpenRefusal"] ?? (() => null);
    expect(refuse("walk-satisfier-5-555", [], { id: "walk-satisfier-5-555", tasks: [], tags: [] })).toBeNull();
    expect(refuse("exec-template-run", [], null)).toBeNull();
  });
  it("[MUST-FAIL] the compact copy is bounded and holds no content or metadata", () => {
    const refuse = DR["deferralOpenRefusal"] ?? (() => "absent");
    const compact = DR["compactDeferralTrace"] ?? (() => null);
    const c = compact({ id: "walk-satisfier-5-555", tasks: Array.from({ length: 100 }, (_, i) => ({ taskId: "t" + i, outputShapes: ["x"], content: "gently ".repeat(500) })), tags: ["a"], metadata: { answer: "wrongdoer" } });
    expect(c).not.toBeNull();
    expect(refuse("walk-satisfier-5-555", [], c)).toBeNull();
    const text = JSON.stringify(c ?? {});
    expect(text.length).toBeLessThanOrEqual(DR["COMPACT_TRACE_MAX_BYTES"] ?? 0);
    expect(text).not.toContain("gently");
    expect(text).not.toContain("wrongdoer");
  });
});
